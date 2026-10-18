// Toolbar popup: the hero Enabled toggle and one merged per-protection panel where each row carries its
// tick box, a one-line description, and a "See how" drop-down with a before→after visual. The hero
// toggle and each protection toggle write the on-device config and ask the background to re-apply.

import { loadConfig, saveConfig, PROTECTION_KEYS, type PoisonConfig } from "./config";
import { registrableDomain } from "./containers/auto";
import { buildDemo, type ReadoutKey } from "./demos";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

// The current tab's full web URL, or null on a non-web tab (about:, moz-extension:, file:, no url)
// where pausing and the readout make no sense. The caller derives the hostname/registrable domain from
// it to drive the "This site" card, and passes the URL to the readout so it can name the container.
async function currentWebUrl(): Promise<string | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const url = new URL(tab.url);
    return url.protocol === "http:" || url.protocol === "https:" ? tab.url : null;
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

// Update the one-line summary above the rows to match the REAL state — master off, paused, all-off, or
// active. No fabricated counts: just the honest overall state, so the panel never overclaims.
function renderSummary(config: PoisonConfig, paused: boolean): void {
  const summary = el<HTMLElement>("readout-summary");
  if (!config.enabled) {
    summary.textContent = "Protection is off. Nothing is active on this or any site. Flip Enabled to turn it back on.";
    return;
  }
  if (paused) {
    summary.textContent =
      "Paused on this site. The per-site box is off here, and the browser-wide protections are eased while this tab is in front.";
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

  // Live copy of the config and the current site's pause state, so the toggle handlers can repaint the
  // readout without reloading everything. Both are updated in place as the user flips switches.
  const config = await loadConfig();
  let pausedNow = false;
  enabled.checked = config.enabled;
  setStatus(status, config.enabled);

  // Reflect each protection flag onto its checkbox.
  for (const key of PROTECTION_KEYS) {
    el<HTMLInputElement>(`prot-${key}`).checked = config.protections[key];
  }
  setDetailsEnabled(config.enabled);

  // Fold the before→after visuals onto their protection rows (once) and paint the initial summary. The
  // pause-dependent summary is repainted later once the whitelist state is known (see applyList).
  injectDemos();
  renderSummary(config, pausedNow);

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
        renderSummary(config, pausedNow);
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
          renderSummary(config, pausedNow);
        } catch (err) {
          showError(err);
        }
      })();
    });
  }

  // Whitelist ("pause on this site"): the current-site card plus the managed list of paused sites.
  // State lives in the background (own storage key); the popup only reads and mutates it via messages.
  const sitePause = el<HTMLInputElement>("site-pause");
  const siteNote = el<HTMLElement>("site-note");
  const whitelistDetails = el<HTMLElement>("whitelist");
  const whitelistList = el<HTMLUListElement>("whitelist-list");

  const currentUrl = await currentWebUrl();
  const hostname = currentUrl ? new URL(currentUrl).hostname : null;
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

    const paused = currentDomain ? list.includes(currentDomain) : false;
    pausedNow = paused;
    if (currentDomain) {
      sitePause.checked = paused;
      siteNote.hidden = !paused;
    }

    // Repaint the summary: it depends on the live pause state, so it must follow every whitelist change
    // (initial load, add, remove) and not just the first render.
    renderSummary(config, paused);
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
