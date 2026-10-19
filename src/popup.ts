// Toolbar popup: the hero Enabled toggle and one merged per-protection panel where each row carries its
// tick box, a one-line description, and a "See how" drop-down with a before→after visual. The hero
// toggle and each protection toggle write the on-device config and ask the background to re-apply.

import { loadConfig, saveConfig, PROTECTION_KEYS, type PoisonConfig } from "./config";
import { buildDemo, type ReadoutKey } from "./demos";

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

// When the master switch is off nothing is running, so the per-protection panel reads as unavailable:
// we DIM it AND disable every toggle so they can't be clicked. The changed aspect (dimmed + the native
// disabled checkbox) is the cue that these controls do nothing until Enabled is turned back on.
function setDetailsEnabled(enabled: boolean): void {
  el<HTMLElement>("details").classList.toggle("disabled", !enabled);
  for (const key of PROTECTION_KEYS) {
    el<HTMLInputElement>(`prot-${key}`).disabled = !enabled;
  }
}

// A short plain-language sentence shown at the top of each protection's "See how" drop-down, above the
// before→after visual. One per protection key; the authoritative key list is PROTECTION_KEYS.
const EASY: Record<ReadoutKey, string> = {
  rfp: "Your device reports common, shared values instead of its own.",
  webrtc: "Video and voice calls can't reveal your real or local address.",
  trackingProtection: "Known tracking companies are stopped before they load.",
  hyperlinkAuditing: "Links can't quietly report your clicks to other companies.",
  networkPrediction: "Firefox won't contact sites before you actually open them.",
  container: "This site gets its own sealed box for cookies and logins.",
};

// Attach a "See how" disclosure (the easy sentence + the before→after visual) to each protection row.
// The rows already carry the toggle and the one-line description from the HTML; this folds the old
// readout's demos onto the same rows, so the tick box, the explanation and the illustration live
// together. Built once — the visuals are static (they teach the mechanism, not live per-tab state).
function injectDemos(): void {
  for (const key of PROTECTION_KEYS) {
    const row = document.querySelector<HTMLElement>(`.prot[data-key="${key}"]`);
    if (!row || row.querySelector(".prot-see")) continue;
    const demo = buildDemo(key as ReadoutKey);
    if (!demo) continue;

    const see = document.createElement("details");
    see.className = "prot-see";
    const summary = document.createElement("summary");
    summary.textContent = "See how";
    const easy = document.createElement("p");
    easy.className = "readout-easy";
    easy.textContent = EASY[key as ReadoutKey];
    see.append(summary, easy, demo);
    row.append(see);
  }
}

// Update the one-line summary above the rows to match the REAL state — master off, all-off, or active.
// No fabricated counts: just the honest overall state, so the panel never overclaims.
function renderSummary(config: PoisonConfig): void {
  const summary = el<HTMLElement>("readout-summary");
  if (!config.enabled) {
    summary.textContent = "Protection is off. Nothing is active on this or any site. Flip Enabled to turn it back on.";
    return;
  }
  const anyOn = PROTECTION_KEYS.some((k) => config.protections[k]);
  summary.textContent = anyOn
    ? "These protections are working on this site. Open any one to see how."
    : "Protection is on, but every protection below is turned off, so nothing is active here.";
}

// Bind the hero toggle and every protection toggle from the current config, then wire their change
// handlers. Each write is a partial patch (deep-merged for protections in saveConfig), followed by a
// "poison:apply" so the background re-wires immediately.
async function render(): Promise<void> {
  const enabled = el<HTMLInputElement>("enabled");
  const status = el<HTMLElement>("status");

  // Live copy of the config so the toggle handlers can repaint the summary without reloading
  // everything. It is updated in place as the user flips switches.
  const config = await loadConfig();
  enabled.checked = config.enabled;
  setStatus(status, config.enabled);

  // Reflect each protection flag onto its checkbox.
  for (const key of PROTECTION_KEYS) {
    el<HTMLInputElement>(`prot-${key}`).checked = config.protections[key];
  }
  setDetailsEnabled(config.enabled);

  // Fold the before→after visuals onto their protection rows (once) and paint the summary.
  injectDemos();
  renderSummary(config);

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
        config.enabled = on;
        renderSummary(config);
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
          config.protections[key] = toggle.checked;
          renderSummary(config);
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
