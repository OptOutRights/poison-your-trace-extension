// Toolbar popup: the hero Enabled toggle and a collapsible per-protection breakdown. The hero toggle
// and each protection toggle write the on-device config and ask the background to re-apply immediately.

import { loadConfig, saveConfig, PROTECTION_KEYS } from "./config";
import { registrableDomain } from "./containers/auto";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

// The current tab's hostname, or null on a non-web tab (about:, moz-extension:, no url) where pausing
// makes no sense. Used to drive the "This site" card.
async function currentHostname(): Promise<string | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const url = new URL(tab.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
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

  // Whitelist ("pause on this site"): the current-site card plus the managed list of paused sites.
  // State lives in the background (own storage key); the popup only reads and mutates it via messages.
  const sitePause = el<HTMLInputElement>("site-pause");
  const siteNote = el<HTMLElement>("site-note");
  const whitelistDetails = el<HTMLElement>("whitelist");
  const whitelistList = el<HTMLUListElement>("whitelist-list");

  const hostname = await currentHostname();
  const currentDomain = hostname ? registrableDomain(hostname) : null;

  // Redraw the managed list and reflect whether the current site is among the paused ones.
  const applyList = (list: string[]): void => {
    whitelistList.replaceChildren();
    for (const domain of list) {
      const item = document.createElement("li");
      item.className = "whitelist-item";
      const name = document.createElement("span");
      name.className = "whitelist-domain";
      name.textContent = domain;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "whitelist-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        void (async () => {
          try {
            const res = (await browser.runtime.sendMessage({ type: "poison:whitelist-remove", domain })) as { list?: string[] };
            applyList(res?.list ?? []);
          } catch (err) {
            showError(err);
          }
        })();
      });
      item.append(name, remove);
      whitelistList.append(item);
    }
    el<HTMLElement>("whitelist-count").textContent = String(list.length);
    whitelistDetails.hidden = list.length === 0;

    if (currentDomain) {
      const paused = list.includes(currentDomain);
      sitePause.checked = paused;
      siteNote.hidden = !paused;
    }
  };

  // The current-site card only makes sense on a web tab; leave it hidden on about:/extension pages.
  if (currentDomain) {
    el<HTMLElement>("site-card").hidden = false;
    el<HTMLElement>("site-domain").textContent = currentDomain;
    sitePause.addEventListener("change", () => {
      void (async () => {
        try {
          const message = sitePause.checked
            ? { type: "poison:whitelist-add", hostname }
            : { type: "poison:whitelist-remove", domain: currentDomain };
          const res = (await browser.runtime.sendMessage(message)) as { list?: string[] };
          applyList(res?.list ?? []);
        } catch (err) {
          showError(err);
        }
      })();
    });
  }

  const initial = (await browser.runtime.sendMessage({ type: "poison:whitelist-list" })) as { list?: string[] };
  applyList(initial?.list ?? []);
}

// Run immediately if the document is already parsed (DOMContentLoaded may have fired before this
// bundled script executed), otherwise wait for it. Either way render() runs once.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void render());
} else {
  void render();
}
