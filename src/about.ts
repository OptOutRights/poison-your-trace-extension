// How-it-works page: inject the same before→after visuals used in the popup's "See how" drop-downs into
// the "What it turns on" list, so the reference page shows the flag/sound/clock/chip demos too, always
// visible (no toggles here). The demos are the shared builders from ./demos and use no extension APIs,
// so they run fine on this ordinary page.

import { buildDemo, type ReadoutKey } from "./demos";

function injectAboutDemos(): void {
  const slots = document.querySelectorAll<HTMLElement>(".about-demo[data-demo]");
  for (const slot of slots) {
    if (slot.childElementCount) continue;
    const key = slot.dataset.demo as ReadoutKey | undefined;
    const demo = key ? buildDemo(key) : null;
    if (demo) slot.append(demo);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectAboutDemos);
} else {
  injectAboutDemos();
}
