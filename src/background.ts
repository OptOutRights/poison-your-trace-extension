// Background script: the single control point. It reads the one boolean config and either wires up
// every protection (auto containers, the page world fingerprint scripts, and header rewriting) or
// stands fully down. The popup toggle writes the config and sends a "poison:apply" message, which
// re runs applyConfig so the change takes effect immediately.

import { loadConfig } from "./config";
import { ContainerManager } from "./containers/manager";
import { AutoContainer } from "./containers/auto";
import { HeaderUniformizer } from "./fingerprint/headers";

const containers = new ContainerManager();
const autoContainer = new AutoContainer(containers);
const headers = new HeaderUniformizer();

// The page world scripts that make up fingerprint uniformization. `fingerprint.js` is the base
// (navigator, screen, timezone, canvas); the others cover WebGL, Web Audio, and plugins/mimeTypes.
// Each is registered at document_start so it runs before the page's own scripts.
const FINGERPRINT_SCRIPTS = [
  "dist/fingerprint.js",
  "dist/fingerprint-webgl.js",
  "dist/fingerprint-audio.js",
  "dist/fingerprint-plugins.js",
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

/** Apply the current config: wire every protection on when enabled, off when disabled. Idempotent. */
async function applyConfig(): Promise<void> {
  const config = await loadConfig();

  if (!config.enabled) {
    autoContainer.disable();
    await setFingerprint(false);
    headers.disable();
    console.info("[poison] disabled, all protections off.");
    return;
  }

  autoContainer.enable();
  await setFingerprint(true);
  headers.enable();
  console.info("[poison] enabled, auto containers and fingerprint uniformization on.");
}

browser.runtime.onInstalled.addListener(() => void applyConfig());
browser.runtime.onStartup.addListener(() => void applyConfig());
// Also apply on every background load (e.g. web-ext hot reload during development), so the
// protections are armed without needing a manual toggle.
void applyConfig();

browser.runtime.onMessage.addListener((message: unknown): Promise<unknown> | undefined => {
  const msg = message as { type?: string };
  if (msg?.type === "poison:apply") {
    return applyConfig().then(() => ({ ok: true }));
  }
  return undefined;
});
