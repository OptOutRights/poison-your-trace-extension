// Toolbar popup: the hero Enabled toggle, a collapsible per-protection breakdown, and a live "what
// this site sees" readout. The hero toggle and each protection toggle write the on-device config and
// ask the background to re-apply immediately. The readout reads back the values the active site observes
// (which the background's MAIN-world probe stamped onto the page's DOM) AFTER Firefox's fingerprint
// protection has reshaped them, and shows them as the current truth (after only — the browser does the
// hiding, so there is no before/after to draw).

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

// When the master switch is off, the per-protection flags are only GATED, not cleared, so their
// checkboxes would still read "on" while nothing is actually active. That was misleading. Disable and
// dim the whole details section while off, so the breakdown reads as inactive and matches reality.
function setDetailsEnabled(enabled: boolean): void {
  el<HTMLElement>("details").classList.toggle("disabled", !enabled);
  for (const key of PROTECTION_KEYS) {
    el<HTMLInputElement>(`prot-${key}`).disabled = !enabled;
  }
}

// The active tab, resolved once per readout. Returns undefined when there is no ordinary web tab
// (e.g. an about: page), so the readout can fall back to a graceful message.
async function activeTab(): Promise<browser.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Ask the active tab what it sees. The MAIN-world probe (registered by the background) has already
// stamped the reading onto document.documentElement.dataset.poisonSiteView, so we only read that shared
// DOM attribute back with a tiny isolated-world snippet — executeScript resolves to its last expression.
// We must NOT inject the probe from here: executeScript runs in the extension's world, which Firefox
// exempts from fingerprint protection, so a read from here would report the real values, not what the
// site sees. Returns undefined on a privileged page (executeScript throws) OR when the attribute is
// absent (the page loaded before the probe registered — a reload populates it).
async function readSiteView(tabId: number): Promise<SiteView | undefined> {
  try {
    const results = await browser.tabs.executeScript(tabId, {
      code: "document.documentElement.dataset.poisonSiteView || null",
    });
    const raw = results?.[0];
    return typeof raw === "string" ? (JSON.parse(raw) as SiteView) : undefined;
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
    none.textContent = "No reading yet. Reload this page to see what it exposes.";
    readout.append(none);
    return;
  }

  const heading = document.createElement("h2");
  heading.textContent = "What this site sees";
  readout.append(heading);

  // One clear signal: the processor cores. Firefox reports a common value instead of your real number,
  // so the site cannot tell you apart by it. The other readable values are already the same for everyone
  // on this browser, so we do not list them.
  readout.append(readoutRow("Processor cores", String(view.hardwareConcurrency)));

  const note = document.createElement("p");
  note.className = "readout-note";
  note.textContent = "This site reads a shared value, not your real core count, so you blend in.";
  readout.append(note);
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
  setDetailsEnabled(config.enabled);

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
        setDetailsEnabled(on);
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

  // Firefox Relay hand-off (issue #60). The built-in burner is an inert throwaway that RECEIVES
  // nothing; Relay gives a real address-mask that forwards mail to your inbox, for genuine sign-ups.
  // The extension CANNOT enable Relay programmatically — there is no API — so this button is guidance
  // only: it opens Relay's onboarding in a new tab and lets Firefox take it from there. No "step aside"
  // detection is needed: the burner is now on-demand (context menu), so it never fights Relay's inline
  // chip; it only ever acts on an explicit user gesture.
  el<HTMLButtonElement>("relay-open").addEventListener("click", () => {
    void browser.tabs.create({ url: "https://relay.firefox.com/" });
  });
}

// Run immediately if the document is already parsed (DOMContentLoaded may have fired before this
// bundled script executed), otherwise wait for it. Either way render() runs once.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void render());
} else {
  void render();
}
