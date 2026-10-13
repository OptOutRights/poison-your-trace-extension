// Toolbar popup: the hero Enabled toggle and a collapsible per-protection breakdown. The hero toggle
// and each protection toggle write the on-device config and ask the background to re-apply immediately.

import { loadConfig, saveConfig, PROTECTION_KEYS, type PoisonConfig } from "./config";
import { registrableDomain, targetFor } from "./containers/auto";

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

// One line of the per-site readout: a plain-language title and a supporting sentence. `tone` picks the
// left marker colour — "on" (accent) for an active protection, "off" (muted) when it is not in effect.
interface ReadoutLine {
  title: string;
  detail: string;
  tone: "on" | "off";
}

// Build the readout lines for the active tab from the REAL state: the master switch, each protection
// flag, and whether this site is paused. We never fabricate counts; a browser-wide on/off setting is
// reported as on/off, not as a made-up number. `url` is the active tab's web URL (so we can show the
// container name/colour cheaply via targetFor); null means a non-web tab and the caller hides the card.
function readoutLines(config: PoisonConfig, url: string | null, paused: boolean): { summary: string; lines: ReadoutLine[] } {
  // Master switch off: nothing is running, say so plainly and show no per-protection lines.
  if (!config.enabled) {
    return {
      summary: "Protection is off. Nothing is active on this or any site. Flip Enabled to turn it back on.",
      lines: [],
    };
  }

  const p = config.protections;

  // Paused (whitelisted) site: container isolation is skipped here and the browser-wide settings are
  // relaxed while this tab is in front. Be honest about what is and isn't in effect.
  if (paused) {
    return {
      summary: "Protection is paused on this site. Things are relaxed here so it works normally.",
      lines: [
        { title: "Cookies not isolated", detail: "This site is not kept in its own box while it is paused.", tone: "off" },
        {
          title: "Other protections eased",
          detail:
            "The look-ordinary protection, tracker blocking, and IP leak guard are browser-wide, so they are eased for your other tabs too while this one is in front.",
          tone: "off",
        },
      ],
    };
  }

  // Active, unpaused site: report each protection that is actually on. Respect the individual flags:
  // if a protection's own toggle is off we don't claim it.
  const lines: ReadoutLine[] = [];

  if (p.container) {
    const target = url ? targetFor(url) : null;
    lines.push({
      title: "Cookies isolated",
      detail: target
        ? `This site is kept in its own box (container "${target.name}"), so it can't see what you do elsewhere.`
        : "This site is kept in its own box, so it can't see what you do elsewhere.",
      tone: "on",
    });
  }

  if (p.rfp) {
    lines.push({
      title: "Fingerprint reshaped",
      detail:
        "This site sees common, shared values instead of your device's. Some images or graphics may look slightly off or noisy. That is expected, not a broken page.",
      tone: "on",
    });
  }

  if (p.trackingProtection) {
    lines.push({ title: "Trackers blocked", detail: "Known trackers are blocked on this site.", tone: "on" });
  }

  if (p.webrtc) {
    lines.push({ title: "IP leak guarded", detail: "Video and voice calls can't reveal your local or real address.", tone: "on" });
  }

  const summary =
    lines.length > 0
      ? "These protections are active on this site right now:"
      : "Protection is on, but every protection is turned off in Details, so nothing is active here.";

  return { summary, lines };
}

// Paint the readout section for the active tab. Hidden entirely on non-web tabs (no currentUrl). Kept
// separate from render() so it can be repainted when the pause toggle flips without a full re-render.
function renderReadout(config: PoisonConfig, currentUrl: string | null, paused: boolean): void {
  const section = el<HTMLElement>("readout");
  if (!currentUrl) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const { summary, lines } = readoutLines(config, currentUrl, paused);
  el<HTMLElement>("readout-summary").textContent = summary;

  const list = el<HTMLUListElement>("readout-list");
  list.replaceChildren();
  for (const line of lines) {
    const item = document.createElement("li");
    item.className = `readout-item readout-${line.tone}`;
    const title = document.createElement("span");
    title.className = "readout-title";
    title.textContent = line.title;
    const detail = document.createElement("span");
    detail.className = "readout-detail";
    detail.textContent = line.detail;
    item.append(title, detail);
    list.append(item);
  }
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
        renderReadout(config, currentUrl, pausedNow);
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
          renderReadout(config, currentUrl, pausedNow);
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

    // Repaint the per-site readout: its content depends on the live pause state, so it must follow every
    // whitelist change (initial load, add, remove) and not just the first render.
    renderReadout(config, currentUrl, paused);
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
