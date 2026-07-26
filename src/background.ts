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
import { getBurnerFor } from "./email/store";

// Before and after capture store (ticket #4). Kept in its own module and referenced from a few
// clearly separated lines so this block merges cleanly with other tickets touching background.ts.
const captures = new CapturesStore();

const containers = new ContainerManager();
const autoContainer = new AutoContainer(containers);
// The header uniformizer reports the real (before) and applied (after) request header values into
// the capture store, keyed by the originating tab, so the popup can show the network layer too.
const headers = new HeaderUniformizer((tabId, entries) => captures.add(tabId, entries));

// The page world scripts that make up fingerprint uniformization. `fingerprint.js` is the base
// (navigator, screen, timezone, canvas); the others cover WebGL, Web Audio, and plugins/mimeTypes.
// `fingerprint-report-relay.js` runs in the isolated world and forwards the page world before and
// after captures to the background. Each is registered at document_start so it runs before the
// page's own scripts.
const FINGERPRINT_SCRIPTS = [
  "dist/fingerprint.js",
  "dist/fingerprint-webgl.js",
  "dist/fingerprint-audio.js",
  "dist/fingerprint-plugins.js",
  "dist/fingerprint-report-relay.js",
];

type RegisteredScript = Awaited<ReturnType<typeof browser.contentScripts.register>>;
let fingerprintHandles: RegisteredScript[] = [];

async function setFingerprint(on: boolean): Promise<void> {
  if (on && fingerprintHandles.length === 0) {
    for (const file of FINGERPRINT_SCRIPTS) {
      fingerprintHandles.push(
        await browser.contentScripts.register({
          matches: ["<all_urls>"],
          js: [{ file }],
          runAt: "document_start",
          allFrames: true,
        }),
      );
    }
  } else if (!on && fingerprintHandles.length > 0) {
    for (const handle of fingerprintHandles) await handle.unregister();
    fingerprintHandles = [];
  }
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
    await setFingerprint(false);
    await setBurnerAutofill(false);
    headers.disable();
    console.info("[poison] disabled, all protections off.");
    return;
  }

  autoContainer.enable();
  await setFingerprint(true);
  await setBurnerAutofill(true);
  headers.enable();
  console.info("[poison] enabled, auto containers, fingerprint uniformization and burner autofill on.");
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
