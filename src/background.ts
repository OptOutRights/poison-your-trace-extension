// Background script: the single control point. It reads the config and wires every protection on when
// enabled, off when disabled. The heavy lifting is delegated to Firefox itself: instead of the old
// custom fingerprint engine we flip the browser's own privacy.* BrowserSettings (Resist
// Fingerprinting, WebRTC IP policy, Tracking Protection, hyperlink auditing, network prediction). The
// only in-extension mechanism left is auto containers. The popup toggle writes the config and sends a
// "poison:apply" message, which re-runs applyConfig.

import { loadConfig, type PoisonConfig, type Protections } from "./config";
import { ContainerManager } from "./containers/manager";
import { AutoContainer } from "./containers/auto";
import type { ProtectionStatus, ProtectionStatuses } from "./status";

const containers = new ContainerManager();
const autoContainer = new AutoContainer(containers);

// A single privacy.* BrowserSetting we drive. We describe each one declaratively (the setting object,
// the value to apply when on) so applyConfig can loop over them uniformly: set the value when the
// protection is active, otherwise CLEAR it so Firefox reverts to the USER's own preference rather than
// to some hardcoded default we pretend is neutral. Every op is wrapped so one failing setting (an API
// missing on an old/Android build, say) never aborts the others.
interface PrivacySwitch {
  /** The protection flag this switch belongs to, so its real status can be reported per protection. */
  key: keyof Protections;
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
    { key: "rfp", name: "resistFingerprinting", setting: websites.resistFingerprinting, value: true, active: on && p.rfp },
    { key: "webrtc", name: "webRTCIPHandlingPolicy", setting: network.webRTCIPHandlingPolicy, value: "disable_non_proxied_udp", active: on && p.webrtc },
    { key: "trackingProtection", name: "trackingProtectionMode", setting: websites.trackingProtectionMode, value: "always", active: on && p.trackingProtection },
    { key: "hyperlinkAuditing", name: "hyperlinkAuditingEnabled", setting: websites.hyperlinkAuditingEnabled, value: false, active: on && p.hyperlinkAuditing },
    { key: "networkPrediction", name: "networkPredictionEnabled", setting: network.networkPredictionEnabled, value: false, active: on && p.networkPrediction },
  ];
}

// Protections that were found changed outside the extension and put back since the popup last asked.
// Reported once as "reapplied" so the user learns why a setting they changed by hand came back, then
// cleared so the note does not stick around forever.
const recentlyReapplied = new Set<keyof Protections>();

// True while applyConfig is writing settings. Our own set()/clear() calls fire onChange; checking in
// the middle of an apply would race it, so checks are skipped and one runs once the apply is done.
let applying = false;

/**
 * Read back what Firefox actually applies for one switch and, when it drifted and we are allowed to,
 * put it back. Never throws. The cases:
 *   - inactive on purpose → "off" (we cleared it; whatever value it has is the user's own).
 *   - expected value → "applied", whoever holds it (us, another extension, a policy).
 *   - another extension holds a different value → "other_extension": re-setting cannot win (the most
 *     recently installed extension takes precedence) and retrying could make two extensions fight, so
 *     report only.
 *   - not controllable (enterprise policy) with a different value → "locked": report only.
 *   - controllable but different (typically changed by hand in about:config) → re-apply once, then
 *     "reapplied" if it stuck, "mismatch" if it did not.
 */
async function verifyPrivacySwitch(sw: PrivacySwitch): Promise<ProtectionStatus> {
  if (!sw.active) return "off";
  try {
    const current = await sw.setting.get({});
    // The expected value is what matters: if another extension or a policy holds the setting at the
    // same value (uBlock Origin also disables prefetching and pings, for instance), the user is
    // protected, so this is not reported as a problem.
    if (current.value === sw.value) return "applied";
    if (current.levelOfControl === "controlled_by_other_extensions") return "other_extension";
    if (current.levelOfControl === "not_controllable") return "locked";

    console.warn(`[poison] ${sw.name} is ${String(current.value)} instead of ${String(sw.value)}; re-applying.`);
    await sw.setting.set({ value: sw.value });
    const after = await sw.setting.get({});
    if (after.value === sw.value) {
      recentlyReapplied.add(sw.key);
      return "reapplied";
    }
    return "mismatch";
  } catch (err) {
    console.warn(`[poison] could not read ${sw.name}:`, err);
    return "unavailable";
  }
}

/**
 * The real status of every protection. Privacy settings are read back from Firefox; containers are an
 * in-extension mechanism wired directly by applyConfig, so their state follows the config.
 */
async function checkStatus(): Promise<ProtectionStatuses> {
  const config = await loadConfig();
  const statuses = {} as ProtectionStatuses;
  for (const sw of privacySwitches(config)) {
    const status = await verifyPrivacySwitch(sw);
    // A drift fixed earlier (e.g. on a tab switch) is still reported as "reapplied" the next time the
    // popup asks, as long as the setting is still applied now.
    statuses[sw.key] = status === "applied" && recentlyReapplied.has(sw.key) ? "reapplied" : status;
  }
  statuses.container = config.enabled && config.protections.container ? "applied" : "off";
  return statuses;
}

/** Check (and repair) in the background, outside of an apply. Errors are already handled per setting. */
function checkInBackground(): void {
  if (!applying) void checkStatus();
}

/** Apply the current config: wire every protection on when enabled + its flag is on, off otherwise.
 *  Idempotent — safe to call from any trigger, any number of times. */
async function applyConfig(): Promise<void> {
  const config = await loadConfig();
  applying = true;
  try {
    // The browser-wide privacy settings, each gated on enabled AND its own flag. Every set/clear is
    // independent and self-guarding, so one failing setting does not abort the rest.
    for (const sw of privacySwitches(config)) await applyPrivacySwitch(sw);
  } finally {
    applying = false;
  }

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

  // Read back what Firefox actually applied, so a failed set() (other extension, policy) is noticed
  // right away rather than only logged.
  await checkStatus();
}

browser.runtime.onInstalled.addListener(() => void applyConfig());
browser.runtime.onStartup.addListener(() => void applyConfig());
// Also apply on every background load (e.g. web-ext hot reload during development), so the
// protections are armed without needing a manual toggle.
void applyConfig();

// Notice settings changed outside the extension (by hand in about:config, another extension, a
// policy). onChange is the direct signal; it is guarded because it may not fire for every kind of
// change on every Firefox build, which is why tab switches also trigger a check below. Our own writes
// fire onChange too, but a check then finds the expected value and does nothing, so there is no loop.
void loadConfig().then((config) => {
  // The setting objects are the same whatever the config; it is only needed to build the list.
  for (const sw of privacySwitches(config)) sw.setting.onChange?.addListener(() => checkInBackground());
});
browser.tabs.onActivated.addListener(() => checkInBackground());

browser.runtime.onMessage.addListener(
  (message: unknown, _sender: browser.runtime.MessageSender): Promise<unknown> | undefined => {
    const msg = message as { type?: string };
    // The popup writes the config then sends this so the background re-wires every setting immediately.
    if (msg?.type === "poison:apply") {
      return applyConfig().then(() => ({ ok: true }));
    }
    // The popup asks for the real state when it opens and after each toggle. A "reapplied" note is
    // shown once, so it is cleared after being reported.
    if (msg?.type === "poison:status") {
      return checkStatus().then((statuses) => {
        recentlyReapplied.clear();
        return { statuses };
      });
    }
    return undefined;
  },
);
