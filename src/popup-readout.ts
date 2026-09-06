// Popup readout probe. The background registers it into the page's MAIN world (world: "MAIN"), the only
// place it reads what the site truly sees: Firefox applies fingerprint protection to the page's own
// principal but EXEMPTS the extension's content-script world, so a content-script read would report the
// real value, not the protected one. Running in MAIN world, the read below gets the same protection the
// site gets.
//
// We surface one clear, changing signal: the processor core count. Firefox reports a common value (for
// example 8) instead of your real number, so you blend into the crowd. The other values a site can read
// (user agent, screen, timezone) are already crowd uniform, so showing them adds noise, not signal.
//
// How the value crosses back to the popup: MAIN-world globals are invisible to the popup's
// isolated-world executeScript, but the DOM is shared by both worlds. So we stamp the reading (as JSON)
// onto document.documentElement.dataset.poisonSiteView, and the popup reads that attribute back.

// The shape the popup consumes. Exported so the popup imports the exact type (the value never crosses,
// only the type does).
export interface SiteView {
  hardwareConcurrency: number;
}

// The shared-DOM slot the probe writes and the popup reads back (a data attribute on <html>).
const SITE_VIEW_ATTR = "poisonSiteView";

const view: SiteView = {
  hardwareConcurrency: navigator.hardwareConcurrency,
};
document.documentElement.dataset[SITE_VIEW_ATTR] = JSON.stringify(view);
