// Fingerprint regression harness runner.
//
// Drives testpage/harness.html under a real Firefox with the extension installed, so "robust" is a
// recorded number instead of a feeling (issue #35). It runs the page twice — once with NO addon
// (the machine's real values) and once with the extension installed (the uniformized values) — reads
// the JSON verdict the page exposes on window.__HARNESS_RESULT__, and writes:
//   - docs/fingerprint-baseline.json   (machine-readable source of truth)
//   - the marked block inside docs/fingerprint-baseline.md (human-readable table)
//
// Why Selenium and not the live external suites: our own page is deterministic, offline, and
// CSP-free, so the "worker == window" and "no contradictions" pass targets become assertions we can
// re-run on every ticket. We ALSO run a version-pinned, self-hosted copy of CreepJS (the spoof
// detector) offline in the same rig, and read its structured verdict from window.Fingerprint —
// giving a real "lies" count for the surfaces we override, tracked over time so future tickets can
// prove an addition actually helps. pixelscan / Cover Your Tracks / browserleaks stay a manual
// protocol (documented in docs/fingerprint-regression-harness.md) because they are behind anti-bot.
//
// Automation caveat: Selenium/Marionette sets navigator.webdriver, which CreepJS detects. Its
// headlessRating / stealthRating capture that automation noise SEPARATELY from lies, so we record
// both and read the on-vs-off lie delta rather than an absolute "0 lies".
//
// Usage:
//   node scripts/fingerprint-harness.mjs            # headless, build, run our page + CreepJS, record
//   node scripts/fingerprint-harness.mjs --headed   # watch the browser
//   node scripts/fingerprint-harness.mjs --no-build  # reuse the current dist/ + xpi
//   node scripts/fingerprint-harness.mjs --no-creep  # skip the CreepJS pass (our page only)
//
// Env overrides: FIREFOX_BINARY=/path/to/firefox, HARNESS_PORT=8971

import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const TESTPAGE_DIR = join(ROOT, "testpage");
const GECKODRIVER = join(ROOT, "node_modules", ".bin", "geckodriver");
const WEB_EXT = join(ROOT, "node_modules", ".bin", "web-ext");
const ARTIFACTS_DIR = join(ROOT, "web-ext-artifacts");
const XPI_NAME = "poison-harness.xpi";

// Self-hosted CreepJS, pinned so a moved number is attributable to OUR extension, never upstream
// drift. Fetched into a gitignored vendor dir on first run (MIT licensed; not committed, to keep the
// repo lean and the third-party bundle un-vendored — same pattern as geckodriver/Firefox binaries).
const CREEP_REPO = "https://github.com/abrahamjuliot/creepjs.git";
const CREEP_SHA = "10aa6724cd33a1015db1574211890518cd04f0cc";
const CREEP_DIR = join(ROOT, "vendor", "creepjs");
const CREEP_DOCS = join(CREEP_DIR, "docs");

const args = new Set(process.argv.slice(2));
const HEADED = args.has("--headed");
const BUILD = !args.has("--no-build");
const CREEP = !args.has("--no-creep");
const PORT = Number(process.env.HARNESS_PORT || 8971);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

// The uniformized UA the page uses to self-report ON/OFF, read from source so it never drifts.
function expectedUa() {
  try {
    const src = readFileSync(join(ROOT, "src", "fingerprint", "profile.ts"), "utf8");
    const m = src.match(/ua:\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    /* fall through to the known default */
  }
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
}

function firefoxBinary() {
  if (process.env.FIREFOX_BINARY) return process.env.FIREFOX_BINARY;
  const mac = "/Applications/Firefox.app/Contents/MacOS/firefox";
  if (existsSync(mac)) return mac;
  return null; // let Selenium locate the default install
}

// Serve testpage/ at the root and the vendored CreepJS at /creepjs/. Both live under one origin
// (127.0.0.1:PORT) so they share a registrable domain — the auto-container feature hands the tab
// off once, then both pages load in the same container without a second reopen.
function startServer() {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let baseDir = TESTPAGE_DIR;
    let rel;
    if (urlPath === "/creepjs" || urlPath.startsWith("/creepjs/")) {
      baseDir = CREEP_DOCS;
      const sub = urlPath.slice("/creepjs".length).replace(/^\/+/, "");
      rel = sub === "" ? "index.html" : sub;
    } else {
      rel = urlPath === "/" ? "harness.html" : urlPath.replace(/^\/+/, "");
    }
    const file = resolve(baseDir, rel);
    if (!file.startsWith(baseDir)) {
      res.writeHead(403).end("forbidden"); // never serve outside the served roots
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((res) => server.listen(PORT, "127.0.0.1", () => res(server)));
}

// Fetch the pinned CreepJS commit into the gitignored vendor dir (idempotent). Uses fetch-by-sha so
// we grab exactly one commit, not the full history.
function ensureCreep() {
  if (existsSync(join(CREEP_DOCS, "index.html"))) return;
  console.log(`[harness] vendoring CreepJS @ ${CREEP_SHA.slice(0, 10)} into vendor/creepjs…`);
  execFileSync("mkdir", ["-p", CREEP_DIR]);
  const git = (...a) => execFileSync("git", ["-C", CREEP_DIR, ...a], { stdio: "inherit" });
  if (!existsSync(join(CREEP_DIR, ".git"))) git("init", "-q");
  try {
    execFileSync("git", ["-C", CREEP_DIR, "remote", "add", "origin", CREEP_REPO]);
  } catch {
    /* remote already present */
  }
  git("fetch", "-q", "--depth", "1", "origin", CREEP_SHA);
  git("checkout", "-q", "FETCH_HEAD");
  if (!existsSync(join(CREEP_DOCS, "index.html"))) {
    throw new Error("CreepJS checkout did not produce docs/index.html");
  }
}

function buildXpi() {
  console.log("[harness] building extension (npm run build)…");
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  console.log("[harness] packaging xpi (web-ext build)…");
  execFileSync(
    WEB_EXT,
    ["build", "--overwrite-dest", "--filename", XPI_NAME, "--artifacts-dir", ARTIFACTS_DIR],
    { cwd: ROOT, stdio: "inherit" },
  );
}

async function findXpi() {
  const preferred = join(ARTIFACTS_DIR, XPI_NAME);
  if (existsSync(preferred)) return preferred;
  // Fall back to the newest .zip/.xpi web-ext produced if the filename flag was ignored.
  const entries = (await readdir(ARTIFACTS_DIR)).filter((f) => /\.(xpi|zip)$/.test(f));
  if (!entries.length) throw new Error("no packaged extension found in " + ARTIFACTS_DIR);
  return join(ARTIFACTS_DIR, entries.sort().at(-1));
}

function buildDriver() {
  const options = new firefox.Options();
  if (!HEADED) options.addArguments("-headless");
  const bin = firefoxBinary();
  if (bin) options.setBinary(bin);
  const service = new firefox.ServiceBuilder(GECKODRIVER);
  return new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(service).build();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors thrown when the tab we were driving got torn out from under us. With the extension ON this
// is EXPECTED on every top-level navigation: the auto-container feature cancels the request, reopens
// the URL in a fresh container tab, and removes the old one — invalidating our window handle.
const isDiscard = (err) =>
  /contentBrowser is null|no such window|browsing context has been discarded/i.test(String(err));

// Switch the driver onto whatever live tab currently exists (the container tab the extension just
// opened). Returns false if no tab survives.
async function switchToLiveTab(driver) {
  const handles = await driver.getAllWindowHandles();
  if (!handles.length) return false;
  await driver.switchTo().window(handles[handles.length - 1]);
  return true;
}

// Ready/extract contracts for the two pages we drive.
const HARNESS_READY = "return !!(document.body && document.body.dataset.harnessReady === 'true')";
const HARNESS_EXTRACT = "return window.__HARNESS_RESULT__;";
// CreepJS exposes its computed fingerprint on window.Fingerprint (src/creep.ts). lies.totalLies is
// the spoof-lie count; lies.data maps each surface to its detected lies; headless.* is automation
// noise measured separately. The status/samples fetches are non-blocking, so this resolves offline.
const CREEP_READY = "return !!(window.Fingerprint && window.Fingerprint.lies);";
const CREEP_EXTRACT = `
  var fp = window.Fingerprint || {};
  var lies = fp.lies || {};
  var headless = fp.headless || {};
  return {
    totalLies: lies.totalLies == null ? null : lies.totalLies,
    lieKeys: Object.keys(lies.data || {}).sort(),
    lieDetail: lies.data || {},
    headlessRating: headless.headlessRating == null ? null : headless.headlessRating,
    stealthRating: headless.stealthRating == null ? null : headless.stealthRating,
  };
`;

// Load a page and return an extracted value, tolerating the auto-container tab handoff. A plain
// get() may reject (old tab discarded) or succeed then be replaced; either way we re-acquire the
// live tab and, if it is not yet on our page, drive it there (an in-container nav passes straight
// through with no second reopen).
async function driveAndExtract(driver, url, readyScript, extractScript, timeout = 20000) {
  try {
    await driver.get(url);
  } catch (err) {
    if (!isDiscard(err)) throw err;
  }
  if (!(await switchToLiveTab(driver))) throw new Error("no window handle after navigation");

  const current = await driver.getCurrentUrl().catch(() => "");
  if (!current.startsWith(url)) {
    try {
      await driver.get(url);
    } catch (err) {
      if (!isDiscard(err)) throw err;
      await switchToLiveTab(driver);
    }
  }
  await driver.wait(
    async () => (await driver.executeScript(readyScript)) === true,
    timeout,
    "page never signalled ready: " + url,
  );
  return driver.executeScript(extractScript);
}

const readVerdict = (driver, url) => driveAndExtract(driver, url, HARNESS_READY, HARNESS_EXTRACT);

// CreepJS is slow (spawns ~14 iframes + workers) and network fetches time out offline, so allow a
// generous ceiling. A failure here must not sink the whole run — record it and move on.
async function readCreep(driver, url) {
  try {
    return await driveAndExtract(driver, url, CREEP_READY, CREEP_EXTRACT, 60000);
  } catch (err) {
    console.warn("[harness] CreepJS pass failed:", String(err).split("\n")[0]);
    return { error: String(err).split("\n")[0] };
  }
}

// Run one mode. For "on", the background enables its listeners and registers content scripts
// asynchronously after install, so we retry the page until the override actually applies (the page
// self-reports via extensionActive). Then, in the same session/container, run the CreepJS pass.
async function runMode(mode, urls, xpiPath) {
  const driver = buildDriver();
  try {
    const caps = await driver.getCapabilities();
    const browserVersion = caps.getBrowserVersion();
    if (mode === "on") {
      // Establish a live content browser before installing, so the install can't race an empty one.
      await driver.get("about:blank");
      await driver.installAddon(xpiPath, true);
      let verdict = null;
      for (let attempt = 1; attempt <= 8; attempt++) {
        await sleep(1200);
        try {
          verdict = await readVerdict(driver, urls.harness);
        } catch (err) {
          if (!isDiscard(err)) throw err;
          console.log(`[harness] tab handoff in flight (attempt ${attempt}/8), retrying…`);
          continue;
        }
        if (verdict && verdict.extensionActive) break;
        console.log(`[harness] extension not active yet (attempt ${attempt}/8), retrying…`);
      }
      if (!verdict || !verdict.extensionActive) {
        console.warn("[harness] WARNING: extension never reported active; recording what was observed.");
      }
      const creep = CREEP ? await readCreep(driver, urls.creep) : null;
      return { verdict, creep, browserVersion };
    }
    const verdict = await readVerdict(driver, urls.harness);
    const creep = CREEP ? await readCreep(driver, urls.creep) : null;
    return { verdict, creep, browserVersion };
  } finally {
    if (!args.has("--keep")) await driver.quit();
  }
}

// ---- Markdown rendering ---------------------------------------------------

function mdTable(off, on) {
  const win = on.window || {};
  const keys = Object.keys(win);
  const rows = keys.map((k) => {
    const offVal = off.window && off.window[k] !== undefined ? String(off.window[k]) : "—";
    const onVal = String(win[k]);
    const changed = offVal !== onVal ? "yes" : "";
    return `| \`${k}\` | ${mdCell(offVal)} | ${mdCell(onVal)} | ${changed} |`;
  });
  return [
    "| Signal | Extension OFF (real) | Extension ON (uniformized) | Changed |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function mdCell(s) {
  return "`" + String(s).replace(/\|/g, "\\|").slice(0, 120) + "`";
}

function renderBlock(baseline) {
  const on = baseline.on || {};
  const off = baseline.off || {};
  const parity = on.parity || { checked: 0, mismatches: [] };
  const contradictions = on.contradictions || [];
  const lines = [];
  lines.push(`_Generated by \`npm run harness\` on ${baseline.generatedAt}._`);
  lines.push("");
  lines.push(`- **Host OS:** ${baseline.host.platform} ${baseline.host.release} (${baseline.host.arch})`);
  lines.push(`- **Firefox:** ${baseline.firefoxVersion || "unknown"}`);
  lines.push(`- **Extension version:** ${baseline.extensionVersion}`);
  lines.push(`- **Extension reported active (ON run):** ${on.extensionActive ? "yes" : "NO — see warning above"}`);
  lines.push("");
  lines.push("### Pass targets");
  lines.push("");
  lines.push(`- **worker == window:** ${parity.mismatches.length === 0 ? "PASS" : `FAIL — ${parity.mismatches.length} mismatch(es)`} (of ${parity.checked} shared signals)`);
  lines.push(`- **no contradictions:** ${contradictions.length === 0 ? "PASS" : `FAIL — ${contradictions.length} contradiction(s)`}`);
  lines.push("");
  if (parity.mismatches.length) {
    lines.push("### Worker vs window mismatches");
    lines.push("");
    lines.push("| Signal | Window (page) | Worker |");
    lines.push("| --- | --- | --- |");
    for (const m of parity.mismatches) {
      lines.push(`| \`${m.signal}\` | ${mdCell(m.window)} | ${mdCell(m.worker)} |`);
    }
    lines.push("");
  }
  if (contradictions.length) {
    lines.push("### Cross-signal contradictions");
    lines.push("");
    for (const c of contradictions) lines.push(`- ${c}`);
    lines.push("");
  }
  renderCreep(lines, baseline.creep, baseline.creepPinnedSha);
  renderStillMisses(lines, baseline);

  lines.push("### Signal table (window context)");
  lines.push("");
  lines.push(mdTable(off, on));
  return lines.join("\n");
}

// CreepJS results, with the automation caveat made explicit. The honest signal is the ON-vs-OFF lie
// delta: both runs carry the same Selenium automation lies, so the difference is what the extension
// added.
function renderCreep(lines, creep, sha) {
  lines.push("### CreepJS (self-hosted, pinned)");
  lines.push("");
  if (!creep) {
    lines.push("_CreepJS pass skipped (`--no-creep`)._");
    lines.push("");
    return;
  }
  const on = creep.on || {};
  const off = creep.off || {};
  if (on.error || off.error) {
    lines.push(`_CreepJS pass errored: ${on.error || off.error}._`);
    lines.push("");
    return;
  }
  lines.push(`Pinned commit \`${(sha || "").slice(0, 10)}\`. **Caveat:** Selenium sets \`navigator.webdriver\`, which CreepJS reads as automation. Compare the **ON − OFF lie delta**, not the absolute count; \`headlessRating\`/\`stealthRating\` measure that automation noise separately.`);
  lines.push("");
  lines.push("| Metric | OFF (real) | ON (uniformized) |");
  lines.push("| --- | --- | --- |");
  lines.push(`| total lies | ${fmt(off.totalLies)} | ${fmt(on.totalLies)} |`);
  lines.push(`| headless rating | ${fmt(off.headlessRating)}% | ${fmt(on.headlessRating)}% |`);
  lines.push(`| stealth rating | ${fmt(off.stealthRating)}% | ${fmt(on.stealthRating)}% |`);
  lines.push("");
  const onKeys = on.lieKeys || [];
  if (onKeys.length) {
    lines.push(`Surfaces CreepJS flags as lying with the extension ON: ${onKeys.map((k) => `\`${k}\``).join(", ")}.`);
    lines.push("");
  }
}

// The point of the harness for the epic: a shrinking, regenerated list of what still leaks, so a
// future ticket can prove an addition helped. Built only from MEASURED evidence here.
function renderStillMisses(lines, baseline) {
  const on = baseline.on || {};
  const parity = on.parity || { mismatches: [] };
  const contradictions = on.contradictions || [];
  const creepOn = baseline.creep?.on || {};
  lines.push("### What the extension still misses (measured)");
  lines.push("");
  const workerLeaks = parity.mismatches.map((m) => m.signal);
  if (workerLeaks.length) {
    lines.push(`- **Worker context leaks the real value** for: ${workerLeaks.map((s) => `\`${s}\``).join(", ")}. The page-world override never runs in workers (closes in #38).`);
  } else {
    lines.push("- Worker context matches the window (no leaks measured).");
  }
  if (contradictions.length) {
    lines.push(`- **Cross-signal contradictions:** ${contradictions.length} (see above; the per-OS profile fix is #37).`);
  }
  if (creepOn.lieKeys && creepOn.lieKeys.length) {
    const offLies = baseline.creep?.off?.totalLies;
    const onLies = creepOn.totalLies;
    const attribution =
      offLies === 0
        ? "all attributable to the extension — the OFF run had 0 lies, so Selenium's automation landed in `headlessRating`, not lies"
        : `ON−OFF lie delta ${onLies - offLies} (OFF carried ${offLies} automation-baseline lies)`;
    lines.push(`- **CreepJS detects the overrides as lies** on ${creepOn.lieKeys.length} surface(s) (${attribution}). The 0-lies target means making these overrides undetectable — v2 hardening.`);
  }
  lines.push("- **Not probed by this harness:** fonts, `Intl` locale, `matchMedia` media features, `enumerateDevices`, `speechSynthesis` — known untouched surfaces tracked in [`robustness-improvements-research.md`](./robustness-improvements-research.md) (tickets #39/#40).");
  lines.push("");
}

function fmt(v) {
  return v == null ? "n/a" : String(v);
}

const BEGIN = "<!-- HARNESS:BEGIN -->";
const END = "<!-- HARNESS:END -->";

async function writeMarkdown(baseline) {
  const path = join(ROOT, "docs", "fingerprint-baseline.md");
  const block = `${BEGIN}\n\n${renderBlock(baseline)}\n\n${END}`;
  let doc = existsSync(path) ? await readFile(path, "utf8") : "";
  if (doc.includes(BEGIN) && doc.includes(END)) {
    doc = doc.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block);
  } else {
    doc += (doc ? "\n\n" : "") + block + "\n";
  }
  await writeFile(path, doc);
  console.log("[harness] wrote docs/fingerprint-baseline.md");
}

// ---- Main -----------------------------------------------------------------

async function main() {
  if (BUILD) buildXpi();
  if (CREEP) ensureCreep();
  const xpiPath = await findXpi();
  const extensionVersion = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  const server = await startServer();
  const base = `http://127.0.0.1:${PORT}`;
  const urls = { harness: `${base}/harness.html`, creep: `${base}/creepjs/` };
  console.log(`[harness] serving testpage at ${urls.harness}`);
  if (CREEP) console.log(`[harness] serving CreepJS @ ${CREEP_SHA.slice(0, 10)} at ${urls.creep}`);
  console.log(`[harness] expected uniformized UA: ${expectedUa()}`);

  try {
    console.log("[harness] run 1/2: extension OFF (real values)…");
    const offRun = await runMode("off", urls, xpiPath);
    console.log("[harness] run 2/2: extension ON (uniformized)…");
    const onRun = await runMode("on", urls, xpiPath);

    const baseline = {
      generatedAt: new Date().toISOString(),
      extensionVersion,
      firefoxVersion: onRun.browserVersion || offRun.browserVersion,
      host: { platform: os.platform(), release: os.release(), arch: os.arch() },
      creepPinnedSha: CREEP ? CREEP_SHA : null,
      off: offRun.verdict,
      on: onRun.verdict,
      creep: CREEP ? { off: offRun.creep, on: onRun.creep } : null,
    };

    const jsonPath = join(ROOT, "docs", "fingerprint-baseline.json");
    await writeFile(jsonPath, JSON.stringify(baseline, null, 2) + "\n");
    console.log("[harness] wrote docs/fingerprint-baseline.json");
    await writeMarkdown(baseline);

    const p = baseline.on?.parity?.mismatches?.length ?? -1;
    const c = baseline.on?.contradictions?.length ?? -1;
    const lies = baseline.creep?.on?.totalLies;
    console.log(
      `[harness] done. worker/window mismatches: ${p}, contradictions: ${c}` +
        (lies == null ? "" : `, CreepJS lies (ON): ${lies}`),
    );
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("[harness] failed:", err);
  process.exitCode = 1;
});
