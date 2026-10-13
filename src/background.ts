// Background script: the single control point. It reads the config and wires every protection on when
// enabled, off when disabled. The heavy lifting is delegated to Firefox itself: instead of the old
// custom fingerprint engine we flip the browser's own privacy.* BrowserSettings (Resist
// Fingerprinting, WebRTC IP policy, Tracking Protection, hyperlink auditing, network prediction). The
// only in-extension mechanisms left are auto containers and the on-demand burner email insertion. The
// popup toggle writes the config and sends a "poison:apply" message, which re-runs applyConfig.

import { loadConfig, type PoisonConfig } from "./config";
import { ContainerManager } from "./containers/manager";
import { AutoContainer } from "./containers/auto";
import { getBurnerFor } from "./email/store";
import { getWhitelist, addToWhitelist, removeFromWhitelist, isWhitelisted } from "./whitelist";

const containers = new ContainerManager();
const autoContainer = new AutoContainer(containers);

// On-demand burner email (issues #59/#24). The OLD model auto-filled every empty email field for 10s
// via a MutationObserver — intrusive, and it fought Firefox Relay's inline chip. The NEW model is a
// deliberate, user-invoked action: a "Insérer une adresse jetable" context-menu item on editable
// fields. Right-clicking a field and picking it fills THAT field with this site's burner address.
//
// Two pieces are wired together, both gated on enabled AND the burnerEmail protection:
//   - a lightweight content script (src/email/insert.ts) registered top-frame only, which tracks the
//     right-clicked field and fills it when told to;
//   - the context-menu item itself, whose click handler resolves the tab's burner and messages that
//     content script to insert it.
// When the protection is off (or the extension disabled) BOTH are torn down, so nothing is injected
// and no menu item appears on the disabled path.
const BURNER_MENU_ID = "poison-insert-burner";

type RegisteredScript = Awaited<ReturnType<typeof browser.contentScripts.register>>;
let insertHandle: RegisteredScript | null = null;
// Track whether the menu item currently exists, so create/remove stay idempotent (contextMenus.create
// throws on a duplicate id, and remove() throws on an unknown id).
let burnerMenuPresent = false;

async function setBurnerContextMenu(on: boolean): Promise<void> {
  // Register/unregister the insertion content script. Top frame only (allFrames:false) so a tracker
  // iframe can never receive the insert message; http/https only.
  if (on && insertHandle === null) {
    insertHandle = await browser.contentScripts.register({
      matches: ["http://*/*", "https://*/*"],
      js: [{ file: "dist/email-insert.js" }],
      runAt: "document_idle",
      allFrames: false,
    });
  } else if (!on && insertHandle !== null) {
    await insertHandle.unregister();
    insertHandle = null;
  }

  // Create/remove the context-menu item. `contexts: ["editable"]` restricts it to text fields, so it
  // only ever appears where insertion makes sense (and, with the top-frame-only script, honeypots and
  // tracker iframes are excluded by construction).
  //
  // The `burnerMenuPresent` flag is module-global, so it only tracks presence WITHIN one background
  // lifetime; after a background restart (MV2 event-page suspension) the flag resets to false while
  // Firefox may still hold the menu it created before. So on the create path we `removeAll()` first —
  // it never throws on an empty set — which makes create idempotent across restarts too: whatever
  // stale item survived is cleared, then we create exactly one. The create callback reads
  // `runtime.lastError` to swallow any residual duplicate-id error rather than let it surface uncaught.
  if (on && !burnerMenuPresent) {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create(
      { id: BURNER_MENU_ID, title: "Insert a throwaway email", contexts: ["editable"] },
      () => void browser.runtime.lastError, // reading lastError marks it handled (no uncaught warning)
    );
    burnerMenuPresent = true;
  } else if (!on && burnerMenuPresent) {
    await browser.contextMenus.remove(BURNER_MENU_ID);
    burnerMenuPresent = false;
  }
}

// Handle a click on the burner menu item: resolve the tab's registrable-domain burner and message the
// insertion content script to fill the field the user right-clicked. Registered once at load; it
// self-guards on the menu id and on the protection being on, so a stray click while off does nothing.
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== BURNER_MENU_ID) return;
  void (async () => {
    const config = await loadConfig();
    if (!config.enabled || !config.protections.burnerEmail) return;
    // Derive the hostname from the tab's URL (the page the user right-clicked in). Without a URL or a
    // tab id we cannot resolve or address the burner, so bail quietly.
    if (!tab || typeof tab.id !== "number" || !tab.url) return;
    let hostname: string;
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      return; // non-URL tab (about:, etc.) — nothing to fill
    }
    // Whitelisted site ("disable on this site"): the burner stands down here, insert nothing.
    if (await isWhitelisted(hostname)) return;
    const address = await getBurnerFor(hostname);
    try {
      await browser.tabs.sendMessage(tab.id, { type: "poison:insert-burner", address });
    } catch (err) {
      // The content script may be absent on a page it never loaded into (e.g. injected before the
      // protection was turned on). Log and move on rather than surfacing an error to the user.
      console.warn("[poison] burner insert message failed:", err);
    }
  })();
});

// A single privacy.* BrowserSetting we drive. We describe each one declaratively (the setting object,
// the value to apply when on) so applyConfig can loop over them uniformly: set the value when the
// protection is active, otherwise CLEAR it so Firefox reverts to the USER's own preference rather than
// to some hardcoded default we pretend is neutral. Every op is wrapped so one failing setting (an API
// missing on an old/Android build, say) never aborts the others.
interface PrivacySwitch {
  /** Human name for the log line. */
  name: string;
  /** The BrowserSetting object exposing .set()/.clear(). browser.types.Setting is the shared shape of
   *  every privacy.* setting; the several settings carry different value types, but each value below is
   *  paired with its own setting, so passing it through Setting.set() is sound. */
  setting: browser.types.Setting;
  /** The value to apply while the protection is on. */
  value: unknown;
  /** Whether this protection is currently active (extension enabled AND its own flag on). */
  active: boolean;
}

/** Apply one privacy switch: set its value when active, clear it (revert to the user's value) when not.
 *  Never throws — a failure is logged and swallowed so the surrounding loop keeps going. */
async function applyPrivacySwitch(sw: PrivacySwitch): Promise<void> {
  try {
    if (sw.active) {
      await sw.setting.set({ value: sw.value });
    } else {
      // clear() takes an (empty) details object; passing {} reverts control to the user's own setting.
      await sw.setting.clear({});
    }
  } catch (err) {
    console.warn(`[poison] could not ${sw.active ? "set" : "clear"} ${sw.name}:`, err);
  }
}

/**
 * Build the list of privacy switches for a config. Each is gated on `config.enabled` AND its own
 * protection flag: when the master switch is off every switch is inactive and therefore cleared, so
 * disabling the extension hands every setting back to the user. Firefox's browser.privacy surface:
 *   - websites.resistFingerprinting  → RFP, the replacement for the whole old fingerprint engine.
 *   - network.webRTCIPHandlingPolicy → "disable_non_proxied_udp" stops STUN from leaking the real IP.
 *   - websites.trackingProtectionMode → "always" forces Tracking Protection on everywhere.
 *   - websites.hyperlinkAuditingEnabled → false kills <a ping> click-tracking beacons.
 *   - network.networkPredictionEnabled → false stops speculative DNS/TCP/prefetch reaching out early.
 *
 * `suppressGlobal` is the per site whitelist override: when the focused tab sits on a whitelisted site
 * every switch is forced inactive (and therefore cleared), pausing the global protections. Because
 * these settings are browser wide this necessarily affects every tab while that tab is focused — the
 * accepted tradeoff of a per site pause for browser wide settings.
 */
function privacySwitches(config: PoisonConfig, suppressGlobal: boolean): PrivacySwitch[] {
  const on = config.enabled && !suppressGlobal;
  const p = config.protections;
  const websites = browser.privacy.websites;
  const network = browser.privacy.network;
  return [
    { name: "resistFingerprinting", setting: websites.resistFingerprinting, value: true, active: on && p.rfp },
    { name: "webRTCIPHandlingPolicy", setting: network.webRTCIPHandlingPolicy, value: "disable_non_proxied_udp", active: on && p.webrtc },
    { name: "trackingProtectionMode", setting: websites.trackingProtectionMode, value: "always", active: on && p.trackingProtection },
    { name: "hyperlinkAuditingEnabled", setting: websites.hyperlinkAuditingEnabled, value: false, active: on && p.hyperlinkAuditing },
    { name: "networkPredictionEnabled", setting: network.networkPredictionEnabled, value: false, active: on && p.networkPrediction },
  ];
}

/** Is the currently focused tab sitting on a whitelisted site? Resolves the active tab of the last
 *  focused window and checks its registrable domain. Because the global privacy.* settings are browser
 *  wide, "which site is in front" is what decides whether they are paused. Never throws — any failure
 *  (no window focused, non-web tab) is treated as "not whitelisted" so protections stay applied. */
async function currentSiteWhitelisted(): Promise<boolean> {
  try {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) return false;
    const hostname = new URL(tab.url).hostname; // throws on about:/moz-extension: → caught below
    return await isWhitelisted(hostname);
  } catch {
    return false;
  }
}

// Snapshot of the last global privacy state we applied, so repeated focus/tab events that do not
// actually change the outcome are skipped rather than re-writing every privacy.* setting (and spamming
// the log). Reset to null so the first applyGlobalPrivacy always runs.
let lastGlobalKey: string | null = null;

/** Apply just the five global privacy.* switches for the current config and focused-tab whitelist
 *  state. Factored out of applyConfig so the frequent tab/window focus events can re-evaluate the
 *  global settings cheaply without touching containers or the burner menu. Guarded so an event that
 *  leaves the outcome unchanged is a no-op. */
async function applyGlobalPrivacy(): Promise<void> {
  const config = await loadConfig();
  const suppressGlobal = config.enabled ? await currentSiteWhitelisted() : false;

  const key = JSON.stringify({ enabled: config.enabled, protections: config.protections, suppressGlobal });
  if (key === lastGlobalKey) return; // nothing changed since last apply — skip the redundant writes
  lastGlobalKey = key;

  // Each set/clear is independent and self-guarding, so one failing setting does not abort the rest.
  for (const sw of privacySwitches(config, suppressGlobal)) await applyPrivacySwitch(sw);
}

/** Apply the current config: wire every protection on when enabled + its flag is on, off otherwise.
 *  Idempotent — safe to call from any trigger, any number of times. */
async function applyConfig(): Promise<void> {
  const config = await loadConfig();

  // The browser-level privacy settings, gated by the focused tab's whitelist state. Force a fresh
  // apply (config may have changed) by clearing the dedupe snapshot first.
  lastGlobalKey = null;
  await applyGlobalPrivacy();

  // Auto containers: gated on enabled AND the container flag. enable()/disable() are idempotent.
  if (config.enabled && config.protections.container) {
    autoContainer.enable();
  } else {
    autoContainer.disable();
  }

  // On-demand burner email: gated on enabled AND the burnerEmail flag. Wires (or tears down) both the
  // insertion content script and the "Insérer une adresse jetable" context-menu item together.
  await setBurnerContextMenu(config.enabled && config.protections.burnerEmail);

  console.info(
    config.enabled
      ? "[poison] enabled; privacy settings applied per protection flags, containers + burner context menu wired to their flags."
      : "[poison] disabled; all privacy settings reverted to the user's values, containers and burner context menu off.",
  );
}

browser.runtime.onInstalled.addListener(() => void applyConfig());
browser.runtime.onStartup.addListener(() => void applyConfig());
// Also apply on every background load (e.g. web-ext hot reload during development), so the
// protections are armed without needing a manual toggle.
void applyConfig();

// Re-evaluate the global privacy settings whenever the focused site may have changed: switching tab,
// switching window, or the focused tab navigating. applyGlobalPrivacy is self-guarding (it no-ops when
// the outcome is unchanged), so these frequent events stay cheap. Containers/burner are per site by
// construction and need no re-wiring here.
browser.tabs.onActivated.addListener(() => void applyGlobalPrivacy());
// browser.windows is limited/absent on Firefox for Android; guard so its absence never throws at load
// and break the whole background script. Without it we still re-evaluate on tab activation/navigation.
browser.windows?.onFocusChanged?.addListener(() => void applyGlobalPrivacy());
browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Only the active tab's URL matters for the global suppression decision; ignore background tabs and
  // non-navigation updates (favicon, title, ...) to avoid needless re-evaluation.
  if (tab.active && changeInfo.url) void applyGlobalPrivacy();
});

browser.runtime.onMessage.addListener(
  (message: unknown, _sender: browser.runtime.MessageSender): Promise<unknown> | undefined => {
    const msg = message as { type?: string; hostname?: string; domain?: string };
    if (msg?.type === "poison:apply") {
      return applyConfig().then(() => ({ ok: true }));
    }
    // Whitelist management from the popup. Every mutation re-runs applyConfig so the global settings
    // re-evaluate immediately for the current tab (and containers/burner pick up the change on the
    // next navigation). The list query is a plain read.
    if (msg?.type === "poison:whitelist-list") {
      return getWhitelist().then((list) => ({ list }));
    }
    if (msg?.type === "poison:whitelist-add" && typeof msg.hostname === "string") {
      const hostname = msg.hostname;
      return addToWhitelist(hostname)
        .then(() => applyConfig())
        .then(() => getWhitelist())
        .then((list) => ({ list }));
    }
    if (msg?.type === "poison:whitelist-remove" && typeof msg.domain === "string") {
      const domain = msg.domain;
      return removeFromWhitelist(domain)
        .then(() => applyConfig())
        .then(() => getWhitelist())
        .then((list) => ({ list }));
    }
    // Resolve a site's burner address on request (kept for callers that ask by hostname, e.g. the
    // popup or tooling). The context menu resolves the burner directly in its click handler, but this
    // handler stays the single source of truth for "what is this site's address". Only answer when
    // enabled and the burnerEmail protection is on and a hostname was supplied, so nothing leaks while off.
    if (msg?.type === "poison:burner" && typeof msg.hostname === "string") {
      const hostname = msg.hostname;
      return loadConfig().then((config) =>
        config.enabled && config.protections.burnerEmail
          ? getBurnerFor(hostname).then((address) => ({ address }))
          : {},
      );
    }
    return undefined;
  },
);
