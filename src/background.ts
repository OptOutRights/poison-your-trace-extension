// Background script: the single control point. It reads the config and wires every protection on when
// enabled, off when disabled. The heavy lifting is delegated to Firefox itself: instead of the old
// custom fingerprint engine we flip the browser's own privacy.* BrowserSettings (Resist
// Fingerprinting, WebRTC IP policy, Tracking Protection, hyperlink auditing, network prediction). The
// only in-extension mechanism left is auto containers. The popup toggle writes the config and sends a
// "poison:apply" message, which re-runs applyConfig.

import { loadConfig, type PoisonConfig } from "./config";
import { ContainerManager } from "./containers/manager";
import { AutoContainer } from "./containers/auto";
import { getWhitelist, addToWhitelist, removeFromWhitelist, isWhitelisted } from "./whitelist";

const containers = new ContainerManager();
const autoContainer = new AutoContainer(containers);

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
 *  global settings cheaply without touching containers. Guarded so an event that leaves the outcome
 *  unchanged is a no-op. */
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

  console.info(
    config.enabled
      ? "[poison] enabled; privacy settings applied per protection flags, containers wired to their flag."
      : "[poison] disabled; all privacy settings reverted to the user's values, containers off.",
  );
}

browser.runtime.onInstalled.addListener(() => void applyConfig());
browser.runtime.onStartup.addListener(() => void applyConfig());
// Also apply on every background load (e.g. web-ext hot reload during development), so the
// protections are armed without needing a manual toggle.
void applyConfig();

// Re-evaluate the global privacy settings whenever the focused site may have changed: switching tab,
// switching window, or the focused tab navigating. applyGlobalPrivacy is self-guarding (it no-ops when
// the outcome is unchanged), so these frequent events stay cheap. Containers are per site by
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
    // re-evaluate immediately for the current tab (and containers pick up the change on the next
    // navigation). The list query is a plain read.
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
    return undefined;
  },
);
