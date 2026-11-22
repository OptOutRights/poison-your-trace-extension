// How-it-works page: two jobs. First, inject the same before→after visuals used in the popup's "See
// how" drop-downs into the "What it turns on" list, so the reference page shows the flag/sound/clock/
// chip demos too. The demos are the shared builders from ./demos and use no extension APIs, so they run
// fine anywhere. Second, wire the live "How to check it's really on" test panel: a master switch and
// one toggle per protection that write the same on-device config the popup does and ask the background
// to re-apply, so you can flip a protection here and watch its about:config pref change. The toggles show
// the same real state as the popup and follow changes made elsewhere while the page stays open.

import { buildDemo, type ReadoutKey } from "./demos";
import { loadConfig, saveConfig, PROTECTION_KEYS, STORAGE_KEY, type Protections } from "./config";
import {
  STATUS_CHANGED,
  fetchStatuses,
  paintProtection,
  type ProtectionStatuses,
  type StatusChangedMessage,
} from "./status";

function injectAboutDemos(): void {
  const slots = document.querySelectorAll<HTMLElement>(".about-demo[data-demo]");
  for (const slot of slots) {
    if (slot.childElementCount) continue;
    const key = slot.dataset.demo as ReadoutKey | undefined;
    const demo = key ? buildDemo(key) : null;
    if (demo) slot.append(demo);
  }
}

// Bind the test panel's master switch and per-protection toggles. Guarded so the page still renders its
// demos when opened outside the extension (a plain file:// load for QA), where `browser` is undefined.
//
// The page is often left open while the user changes things elsewhere (the popup, about:config), so the
// toggles are not read once: they follow two signals.
//   - browser.storage.onChanged on the config: a write from anywhere (popup, this page, the background
//     turning off a protection changed outside the extension) repaints the tick boxes right away.
//   - the background's STATUS_CHANGED broadcast, sent after every check: it carries the real state
//     Firefox reports, the same one the popup shows, so a pref changed by hand is reflected too.
async function wireTestPanel(): Promise<void> {
  if (typeof browser === "undefined" || !browser.storage) return;

  const master = document.getElementById("verify-enabled") as HTMLInputElement | null;
  const rows = [...document.querySelectorAll<HTMLElement>(".verify-list li[data-key]")];
  if (!master && rows.length === 0) return; // a page build without the panel

  let config = await loadConfig();
  // The last real state from the background, per protection. A key is dropped when its config changes,
  // since the old status no longer applies: the row then follows the config until the check that comes
  // with the apply reports the new state.
  let statuses: Partial<ProtectionStatuses> = {};

  const render = (): void => {
    if (master) master.checked = config.enabled;
    for (const row of rows) {
      const key = row.dataset.key as keyof Protections;
      const toggle = row.querySelector<HTMLInputElement>(".verify-toggle");
      if (!toggle) continue;
      paintProtection(toggle, row.querySelector<HTMLElement>(".verify-text"), config.enabled, config.protections[key], statuses[key]);
    }
  };

  // Listen before the first status fetch, so a change made while it is in flight is not missed.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(STORAGE_KEY in changes)) return;
    void loadConfig().then((next) => {
      if (next.enabled !== config.enabled) statuses = {};
      for (const key of PROTECTION_KEYS) {
        if (next.protections[key] !== config.protections[key]) delete statuses[key];
      }
      config = next;
      render();
    });
  });
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as Partial<StatusChangedMessage> | undefined;
    if (msg?.type !== STATUS_CHANGED || !msg.statuses) return undefined;
    const fresh = msg.statuses;
    // A check can turn a protection off in the config (changed outside the extension), so re-read it
    // with the statuses rather than pairing them with a config that may be one write behind.
    void loadConfig().then((next) => {
      config = next;
      statuses = fresh;
      render();
    });
    return undefined;
  });

  render();
  const initial = await fetchStatuses();
  if (initial) {
    config = await loadConfig();
    statuses = initial;
    render();
  }

  // Each row's checkbox writes its one protection flag; the listeners above repaint it.
  for (const row of rows) {
    const key = row.dataset.key as keyof Protections;
    const toggle = row.querySelector<HTMLInputElement>(".verify-toggle");
    if (!toggle) continue;
    toggle.addEventListener("change", () => {
      void (async () => {
        await saveConfig({ protections: { [key]: toggle.checked } });
        await browser.runtime.sendMessage({ type: "poison:apply" });
      })();
    });
  }

  master?.addEventListener("change", () => {
    void (async () => {
      await saveConfig({ enabled: master.checked });
      await browser.runtime.sendMessage({ type: "poison:apply" });
    })();
  });
}

// Copy text to the clipboard. Prefers the async Clipboard API (secure context + user gesture, no
// permission needed), falling back to the legacy execCommand path for any context where it is missing.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand fallback below
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Make every pref name in the test panel click-to-copy: a Firefox page can't link to about:config, so
// the next best thing is one click to grab the pref and paste it into the about:config search box. Each
// <code> flashes a check mark for a moment on a successful copy. Also keyboard-operable (Enter/Space).
function wireCopyableCode(): void {
  const section = document.getElementById("verify")?.closest("section");
  if (!section) return;
  for (const code of section.querySelectorAll<HTMLElement>("code")) {
    code.classList.add("copyable");
    code.title = "Click to copy";
    code.tabIndex = 0;
    const doCopy = (): void => {
      void copyText(code.textContent ?? "").then((ok) => {
        if (!ok) return;
        code.classList.add("copied");
        window.setTimeout(() => code.classList.remove("copied"), 1200);
      });
    };
    code.addEventListener("click", doCopy);
    code.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        doCopy();
      }
    });
  }
}

function init(): void {
  injectAboutDemos();
  void wireTestPanel();
  wireCopyableCode();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
