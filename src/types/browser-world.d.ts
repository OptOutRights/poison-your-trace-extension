// The installed @types/firefox-webext-browser (v120) predates the `world` option on
// browser.contentScripts.register. Firefox 128+ supports registering a content script into the page's
// MAIN world, which the "what this site sees" readout probe relies on: only in the page's own world are
// navigator/screen/timezone/canvas reads subject to Firefox's fingerprint protection. A content script
// runs in the extension's world, which Firefox EXEMPTS from that protection, so it would read the real
// values instead of what the site actually sees. Augment the option bag until upstream types catch up.
//
// This file has no import/export on purpose: it must stay a global script so the declaration merges
// into the ambient `browser` namespace rather than becoming an isolated module.
declare namespace browser.contentScripts {
  interface RegisteredContentScriptOptions {
    /** The execution world for the script. Same as the `world` key in manifest content_scripts. */
    world?: "ISOLATED" | "MAIN" | undefined;
  }
}
