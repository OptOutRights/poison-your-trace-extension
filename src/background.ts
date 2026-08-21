// Background script: the single control point. It reads the one boolean config and either wires up
// every protection (auto containers, the page world fingerprint scripts, and header rewriting) or
// stands fully down. The popup toggle writes the config and sends a "poison:apply" message, which
// re runs applyConfig so the change takes effect immediately.

import { loadConfig } from "./config";
import { ContainerManager } from "./containers/manager";
import { AutoContainer } from "./containers/auto";
import { HeaderUniformizer } from "./fingerprint/headers";
import { CapturesStore } from "./fingerprint/captures-store";
import { REPORT_MESSAGE_TYPE, GET_CAPTURES_MESSAGE_TYPE, isCaptureMessage } from "./fingerprint/report";
import { resolveProfile, osFamilyFromHints, type OsFamily, type CommonProfile } from "./fingerprint/profiles";
import { getBurnerFor } from "./email/store";

// Before and after capture store (ticket #4). Kept in its own module and referenced from a few
// clearly separated lines so this block merges cleanly with other tickets touching background.ts.
const captures = new CapturesStore();

// The OS family is resolved HERE and treated as the single source of truth for BOTH layers (ticket
// #37): the network header rewrite reads it directly, and it is injected into the page's MAIN world
// so the JS overrides present the same family — the two can never disagree. We detect the real family
// from getPlatformInfo; `osResolved` records whether that succeeded. The effective family a user sees
// is the config override when set, otherwise the detected one.
let detectedFamily: OsFamily = "windows";
let osResolved = false;
const platformReady = browser.runtime
  .getPlatformInfo()
  .then((info) => {
    detectedFamily = osFamilyFromHints(info.os);
    osResolved = true;
  })
  .catch(() => {
    /* getPlatformInfo unavailable: leave osResolved false (headers stay down unless overridden) */
  });

// The profile the header layer applies, kept in sync with the effective family by applyConfig. It
// starts on the placeholder detected default and is corrected once the platform and config resolve.
let resolvedProfile: CommonProfile = resolveProfile(detectedFamily);

/** The family to present: the user's explicit override, or the detected real family under "auto". */
function effectiveFamily(override: OsFamily | "auto"): OsFamily {
  return override === "auto" ? detectedFamily : override;
}

const containers = new ContainerManager();
const autoContainer = new AutoContainer(containers);
// The header uniformizer reads the shared resolved profile and reports the real (before) and applied
// (after) request header values into the capture store, keyed by the originating tab, so the popup
// can show the network layer too.
const headers = new HeaderUniformizer(
  () => resolvedProfile,
  (tabId, entries) => captures.add(tabId, entries),
);

// The page world scripts that make up fingerprint uniformization. `fingerprint.js` is the base
// (navigator, screen, timezone, canvas); the others cover WebGL, Web Audio, and plugins/mimeTypes.
// They run in the page's MAIN world (world: "MAIN") so the overrides apply directly to the page's
// own globals and are visible to the site's scripts, and — unlike the old inline <script> injection
// — survive a strict page Content Security Policy because the browser injects them, not the DOM.
const FINGERPRINT_OVERRIDE_SCRIPTS = [
  "dist/fingerprint.js",
  "dist/fingerprint-webgl.js",
  "dist/fingerprint-audio.js",
  "dist/fingerprint-plugins.js",
];
// `fingerprint-report-relay.js` runs in the ISOLATED content world (the only world with extension
// APIs) and forwards the page world before/after captures to the background. Everything is
// registered at document_start so it runs before the page's own scripts.
const FINGERPRINT_RELAY_SCRIPT = "dist/fingerprint-report-relay.js";

type RegisteredScript = Awaited<ReturnType<typeof browser.contentScripts.register>>;
let fingerprintHandles: RegisteredScript[] = [];
// The family baked into the currently registered MAIN-world prelude, or null when the scripts are
// registered WITHOUT a forced family (the page world then detects from the real navigator). Lets an
// applyConfig re-register only when the value actually changed rather than leave stale scripts.
let fingerprintForced: OsFamily | null = null;

// All fingerprint (un)registration is serialized behind this promise chain. applyConfig fires from
// several triggers at once (module load, onInstalled, onStartup, poison:apply); without serialization
// a teardown could interleave with an in-flight register — unregistering another call's handles and
// dropping a family change. Chaining makes each op run to completion before the next starts. The
// `.catch` keeps the chain alive after a failed op so later calls still run; the returned promise
// still rejects so the caller can surface the error.
let fingerprintOp: Promise<void> = Promise.resolve();

async function unregisterFingerprint(): Promise<void> {
  for (const handle of fingerprintHandles) await handle.unregister();
  fingerprintHandles = [];
  fingerprintForced = null;
}

/**
 * Turn the page-world fingerprint scripts on or off. `forced` is the OS family to inject into the
 * page world (window.__poisonOsFamily) so it matches the header layer; pass null to register without
 * a prelude, letting the page world fall back to detecting the real navigator (used when the family
 * is not actually known, so the page never claims an OS the untouched UA would contradict).
 */
function setFingerprint(on: boolean, forced: OsFamily | null): Promise<void> {
  const next = fingerprintOp.then(() => applyFingerprint(on, forced));
  fingerprintOp = next.catch(() => {});
  return next;
}

async function applyFingerprint(on: boolean, forced: OsFamily | null): Promise<void> {
  const registered = fingerprintHandles.length > 0;
  if (!on) {
    if (registered) await unregisterFingerprint();
    return;
  }
  // Already up with the right value: nothing to do. Family changed: tear down and rebuild.
  if (registered && fingerprintForced === forced) return;
  if (registered) await unregisterFingerprint();

  // Register the isolated-world relay first so its message listener is live before the MAIN world
  // overrides post their captures.
  fingerprintHandles.push(
    await browser.contentScripts.register({
      matches: ["<all_urls>"],
      js: [{ file: FINGERPRINT_RELAY_SCRIPT }],
      runAt: "document_start",
      allFrames: true,
    }),
  );

  // All MAIN-world overrides in ONE registration so they run in array order. When a family is forced,
  // a tiny prelude sets window.__poisonOsFamily before the override files, so the page world presents
  // the same family the header layer applies. This is the single source of truth for both layers.
  const mainFiles = FINGERPRINT_OVERRIDE_SCRIPTS.map((file) => ({ file }));
  const withPrelude = forced
    ? [{ code: `window.__poisonOsFamily=${JSON.stringify(forced)};` }, ...mainFiles]
    : mainFiles;
  try {
    fingerprintHandles.push(
      await browser.contentScripts.register({
        matches: ["<all_urls>"],
        js: withPrelude,
        runAt: "document_start",
        allFrames: true,
        world: "MAIN",
      }),
    );
  } catch (err) {
    // Some engines may reject a `code` entry in the MAIN world. If we were injecting a prelude, retry
    // with the files only: the page world then resolves the family from the real navigator (see
    // resolveProfileFromPage), so auto-detection still works — only a manual override cannot reach the
    // page world (the header layer still honours it). A files-only failure is a real error: rethrow.
    if (!forced) throw err;
    fingerprintHandles.push(
      await browser.contentScripts.register({
        matches: ["<all_urls>"],
        js: mainFiles,
        runAt: "document_start",
        allFrames: true,
        world: "MAIN",
      }),
    );
  }
  fingerprintForced = forced;
}

// Burner email autofill (issue #5). Registered only while the extension is enabled, so the disabled
// path never injects it. The content script asks back for the site's burner address via the
// "poison:burner" message handled below.
let burnerHandle: RegisteredScript | null = null;

async function setBurnerAutofill(on: boolean): Promise<void> {
  if (on && burnerHandle === null) {
    burnerHandle = await browser.contentScripts.register({
      matches: ["http://*/*", "https://*/*"],
      js: [{ file: "dist/email-autofill.js" }],
      runAt: "document_idle",
      allFrames: false,
    });
  } else if (!on && burnerHandle !== null) {
    await burnerHandle.unregister();
    burnerHandle = null;
  }
}

/** Apply the current config: wire every protection on when enabled, off when disabled. Idempotent. */
async function applyConfig(): Promise<void> {
  const config = await loadConfig();

  if (!config.enabled) {
    autoContainer.disable();
    await setFingerprint(false, null);
    await setBurnerAutofill(false);
    headers.disable();
    console.info("[poison] disabled, all protections off.");
    return;
  }

  // Resolve the family both layers will present before wiring anything, so the header rewrite and the
  // injected page-world prelude carry the exact same value (config override, or the detected real OS).
  await platformReady;
  const family = effectiveFamily(config.osFamily);
  // We only "know" the family when detection succeeded or the user pinned an explicit override. When
  // it is unknown (auto + getPlatformInfo failed), we must NOT force a guessed family onto either
  // layer: a UA/profile that contradicts the real stack is the getHasLiedOs tell ticket #37 removes.
  const familyKnown = osResolved || config.osFamily !== "auto";
  resolvedProfile = resolveProfile(family);

  autoContainer.enable();
  // Inject the family into the page world only when known; otherwise register without a prelude so the
  // page world falls back to the real navigator (which matches the untouched UA when headers are off).
  await setFingerprint(true, familyKnown ? family : null);
  await setBurnerAutofill(true);
  if (familyKnown) {
    headers.enable();
  } else {
    headers.disable();
    console.warn("[poison] OS family unresolved; leaving request headers untouched to avoid a UA/OS mismatch.");
  }
  console.info(
    familyKnown
      ? `[poison] enabled, presenting the ${family} profile; auto containers and burner autofill on.`
      : "[poison] enabled with auto containers and burner autofill; OS family unresolved, fingerprint follows the real navigator.",
  );
}

browser.runtime.onInstalled.addListener(() => void applyConfig());
browser.runtime.onStartup.addListener(() => void applyConfig());
// Also apply on every background load (e.g. web-ext hot reload during development), so the
// protections are armed without needing a manual toggle.
void applyConfig();

browser.runtime.onMessage.addListener(
  (message: unknown, sender: browser.runtime.MessageSender): Promise<unknown> | undefined => {
    const msg = message as { type?: string; tabId?: number; hostname?: string };
    if (msg?.type === "poison:apply") {
      return applyConfig().then(() => ({ ok: true }));
    }
    // The popup asks what OS family is detected and which one is actually being presented, so it can
    // show the real family and let the user override it. `resolved` is false when getPlatformInfo
    // failed, so the popup can flag the detection as uncertain.
    if (msg?.type === "poison:osinfo") {
      return platformReady.then(() => loadConfig()).then((config) => ({
        detected: detectedFamily,
        resolved: osResolved,
        override: config.osFamily,
        effective: effectiveFamily(config.osFamily),
      }));
    }
    // A relay content script forwarding page world before and after captures. Attribute them to the
    // sender's tab so the popup can read this tab's snapshot.
    if (isCaptureMessage(message) && msg.type === REPORT_MESSAGE_TYPE) {
      const tabId = sender.tab?.id;
      if (typeof tabId === "number") captures.add(tabId, message.captures);
      return Promise.resolve({ ok: true });
    }
    // The popup asks for a tab's before and after snapshot. It may pass an explicit tabId, otherwise
    // we fall back to the sender's tab. This is the documented read interface ticket #6 consumes.
    if (msg?.type === GET_CAPTURES_MESSAGE_TYPE) {
      const tabId = typeof msg.tabId === "number" ? msg.tabId : sender.tab?.id;
      return Promise.resolve({ captures: typeof tabId === "number" ? captures.get(tabId) : [] });
    }
    // The autofill content script asks for the site's burner address. Only answer when enabled and a
    // hostname was supplied, so nothing is filled while the extension is off.
    if (msg?.type === "poison:burner" && typeof msg.hostname === "string") {
      return loadConfig().then((config) =>
        config.enabled ? getBurnerFor(msg.hostname as string).then((address) => ({ address })) : {},
      );
    }
    return undefined;
  },
);

// Clear a tab's snapshot when it navigates to a new document or is closed, so the popup never shows
// stale before and after values from a previous page. The overrides repopulate on the next load.
browser.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) captures.clear(details.tabId);
});
browser.tabs.onRemoved.addListener((tabId) => captures.clear(tabId));
