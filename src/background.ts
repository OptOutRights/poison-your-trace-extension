// Background script: the single control point. It reads the config and wires every protection on when
// enabled, off when disabled. The heavy lifting is delegated to Firefox itself: instead of the old
// custom fingerprint engine we flip the browser's own privacy.* BrowserSettings (Resist
// Fingerprinting, WebRTC IP policy, Tracking Protection, hyperlink auditing, network prediction). The
// only in-extension mechanism left is auto containers. The popup toggle writes the config and sends a
// "poison:apply" message, which re-runs applyConfig.

import { loadConfig, type PoisonConfig } from "./config";
import { ContainerManager } from "./containers/manager";
import { AutoContainer } from "./containers/auto";

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
 * These settings are browser-wide: Firefox exposes no per-site switch for them, so each is either on
 * for every site or off for every site, following the master switch and its own flag.
 */
function privacySwitches(config: PoisonConfig): PrivacySwitch[] {
  const on = config.enabled;
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

/** Apply the current config: wire every protection on when enabled + its flag is on, off otherwise.
 *  Idempotent — safe to call from any trigger, any number of times. */
async function applyConfig(): Promise<void> {
  const config = await loadConfig();

  // The browser-wide privacy settings, each gated on enabled AND its own flag. Every set/clear is
  // independent and self-guarding, so one failing setting does not abort the rest.
  for (const sw of privacySwitches(config)) await applyPrivacySwitch(sw);

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

browser.runtime.onMessage.addListener(
  (message: unknown, _sender: browser.runtime.MessageSender): Promise<unknown> | undefined => {
    const msg = message as { type?: string };
    // The popup writes the config then sends this so the background re-wires every setting immediately.
    if (msg?.type === "poison:apply") {
      return applyConfig().then(() => ({ ok: true }));
    }
    return undefined;
  },
);
