// The installed @types/firefox-webext-browser (v120) predates the `world` option on
// browser.contentScripts.register. Firefox 128+ supports registering a content script into the
// page's MAIN world, which we rely on so the fingerprint overrides survive a strict page Content
// Security Policy. Augment the option bag until the upstream types catch up.
//
// This file has no import/export on purpose: it must stay a global script so the declaration merges
// into the ambient `browser` namespace rather than becoming an isolated module.
declare namespace browser.contentScripts {
  interface RegisteredContentScriptOptions {
    /** The execution world for the script. Same as the `world` key in manifest content_scripts. */
    world?: "ISOLATED" | "MAIN" | undefined;
  }
}
