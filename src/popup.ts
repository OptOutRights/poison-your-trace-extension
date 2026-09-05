// Toolbar popup: the hero Enabled toggle, a collapsible per-protection breakdown, and a live "what
// this site sees" readout. The hero toggle and each protection toggle write the on-device config and
// ask the background to re-apply immediately. The readout injects the popup-readout probe into the
// active tab, reads back the values the site observes AFTER Firefox's Resist Fingerprinting has
// reshaped them, and shows them as the current truth (after only — RFP does the hiding, so there is no
// before/after to draw).

import { loadConfig, saveConfig, PROTECTION_KEYS } from "./config";
import type { SiteView } from "./popup-readout";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

// The per-protection toggle ids share the `prot-<key>` convention, so we bind them by iterating
// PROTECTION_KEYS (the schema's own authoritative key list) — adding a protection to config.ts and the
// HTML is enough, no bespoke wiring here.

// Reflect the enabled state in the status pill: colour AND a word, so the state never depends on
// colour alone (design system: state is redundant).
function setStatus(status: HTMLElement, enabled: boolean): void {
  status.textContent = enabled ? "Active" : "Off";
  status.className = enabled ? "status active" : "status paused";
}

// The active tab, resolved once per readout. Returns undefined when there is no ordinary web tab
// (e.g. an about: page), so the readout can fall back to a graceful message.
async function activeTab(): Promise<browser.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Ask the active tab what it sees. We inject the bundled probe (which stashes the reading on a page
// global), then run a second tiny snippet to read that global back — executeScript resolves to the
// last expression of the injected code, so the snippet's bare object access is what we receive. Both
// injections can fail on a privileged page (about:, view-source:, the add-ons site), which we treat as
// "no readout available" rather than an error.
async function readSiteView(tabId: number): Promise<SiteView | undefined> {
  try {
    await browser.tabs.executeScript(tabId, { file: "dist/popup-readout.js", runAt: "document_end" });
    const results = await browser.tabs.executeScript(tabId, { code: "window.__poisonSiteView" });
    return results?.[0] as SiteView | undefined;
  } catch {
    return undefined;
  }
}

// One readout row: a label and the current value the site observes. Values are plain text; the value
// column uses tabular numbers so the aligned rows read cleanly.
function readoutRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "see";
  const b = document.createElement("span");
  b.className = "see-label";
  b.textContent = label;
  const v = document.createElement("span");
  v.className = "see-value";
  v.textContent = value;
  row.append(b, v);
  return row;
}

// Render the live readout for the active tab. Off, non-web, and freshly-opened tabs each get a plain
// sentence rather than an empty or misleading list.
async function renderReadout(): Promise<void> {
  const readout = el<HTMLElement>("readout");
  readout.textContent = "";

  const config = await loadConfig();
  if (!config.enabled) {
    const off = document.createElement("div");
    off.className = "empty";
    off.textContent = "Protections are off. Turn Enabled on to hide what this site sees.";
    readout.append(off);
    return;
  }

  const tab = await activeTab();
  if (!tab || typeof tab.id !== "number") {
    const none = document.createElement("div");
    none.className = "empty";
    none.textContent = "No web page in this tab to read.";
    readout.append(none);
    return;
  }

  const view = await readSiteView(tab.id);
  if (!view) {
    const none = document.createElement("div");
    none.className = "empty";
    none.textContent = "Cannot read this page (it may be a browser or add-on page).";
    readout.append(none);
    return;
  }

  const heading = document.createElement("h2");
  heading.textContent = "What this site sees";
  readout.append(heading);

  readout.append(readoutRow("User agent", view.userAgent));
  readout.append(readoutRow("Screen", `${view.screenWidth} × ${view.screenHeight}`));
  readout.append(readoutRow("Timezone", view.timeZone));
  readout.append(readoutRow("CPU cores", String(view.hardwareConcurrency)));
  readout.append(readoutRow("Pixel ratio", String(view.devicePixelRatio)));
  readout.append(readoutRow("Canvas hash", view.canvasHash));
}

// Bind the hero toggle and every protection toggle from the current config, then wire their change
// handlers. Each write is a partial patch (deep-merged for protections in saveConfig), followed by a
// "poison:apply" so the background re-wires immediately, then a readout refresh so the shown values
// reflect the new state.
async function render(): Promise<void> {
  const enabled = el<HTMLInputElement>("enabled");
  const status = el<HTMLElement>("status");

  const config = await loadConfig();
  enabled.checked = config.enabled;
  setStatus(status, config.enabled);

  // Reflect each protection flag onto its checkbox.
  for (const key of PROTECTION_KEYS) {
    el<HTMLInputElement>(`prot-${key}`).checked = config.protections[key];
  }

  await renderReadout();

  // Surface an error inline on the status pill without throwing out of the handler.
  const showError = (err: unknown): void => {
    status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    status.className = "status paused";
  };

  enabled.addEventListener("change", () => {
    void (async () => {
      const on = enabled.checked;
      try {
        await saveConfig({ enabled: on });
        await browser.runtime.sendMessage({ type: "poison:apply" });
        setStatus(status, on);
        // The enabled state changed, so refresh the readout to match (show it or mark it off).
        await renderReadout();
      } catch (err) {
        showError(err);
      }
    })();
  });

  for (const key of PROTECTION_KEYS) {
    const toggle = el<HTMLInputElement>(`prot-${key}`);
    toggle.addEventListener("change", () => {
      void (async () => {
        try {
          // Deep-merge patch: only this one protection key changes, the rest are preserved.
          await saveConfig({ protections: { [key]: toggle.checked } });
          await browser.runtime.sendMessage({ type: "poison:apply" });
          // A protection change can alter what the site sees (RFP especially), so refresh the readout.
          await renderReadout();
        } catch (err) {
          showError(err);
        }
      })();
    });
  }
}

// Run immediately if the document is already parsed (DOMContentLoaded may have fired before this
// bundled script executed), otherwise wait for it. Either way render() runs once.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void render());
} else {
  void render();
}
