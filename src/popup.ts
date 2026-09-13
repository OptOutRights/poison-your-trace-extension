// Toolbar popup: the hero Enabled toggle and a collapsible per-protection breakdown. The hero toggle
// and each protection toggle write the on-device config and ask the background to re-apply immediately.

import { loadConfig, saveConfig, PROTECTION_KEYS } from "./config";

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

// Bind the hero toggle and every protection toggle from the current config, then wire their change
// handlers. Each write is a partial patch (deep-merged for protections in saveConfig), followed by a
// "poison:apply" so the background re-wires immediately.
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
