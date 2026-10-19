// How-it-works page: two jobs. First, inject the same before→after visuals used in the popup's "See
// how" drop-downs into the "What it turns on" list, so the reference page shows the flag/sound/clock/
// chip demos too. The demos are the shared builders from ./demos and use no extension APIs, so they run
// fine anywhere. Second, wire the live "How to check it's really on" test panel: a master switch and
// one toggle per protection that write the same on-device config the popup does and ask the background
// to re-apply, so you can flip a protection here and watch its about:config pref change.

import { buildDemo, type ReadoutKey } from "./demos";
import { loadConfig, saveConfig, type Protections } from "./config";

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
async function wireTestPanel(): Promise<void> {
  if (typeof browser === "undefined" || !browser.storage) return;

  const master = document.getElementById("verify-enabled") as HTMLInputElement | null;
  const rows = [...document.querySelectorAll<HTMLElement>(".verify-list li[data-key]")];
  if (!master && rows.length === 0) return; // a page build without the panel

  const config = await loadConfig();
  if (master) master.checked = config.enabled;

  // Each row's checkbox reflects, and on change writes, its one protection flag.
  for (const row of rows) {
    const key = row.dataset.key as keyof Protections;
    const toggle = row.querySelector<HTMLInputElement>(".verify-toggle");
    if (!toggle) continue;
    toggle.checked = config.protections[key];
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
