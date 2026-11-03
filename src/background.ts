// Background script: the single control point. It reads the config and wires every protection on when
// enabled, off when disabled. The heavy lifting is delegated to Firefox itself: instead of the old
// custom fingerprint engine we flip the browser's own privacy.* BrowserSettings (Resist
// Fingerprinting, WebRTC IP policy, Tracking Protection, hyperlink auditing, network prediction). The
// only in-extension mechanism left is auto containers. The popup toggle writes the config and sends a
// "poison:apply" message, which re-runs applyConfig.

import { loadConfig, saveConfig, type PoisonConfig, type Protections } from "./config";
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
 *  Never throws — a failure is logged and swallowed so the surrounding loop keeps going. Returns false
 *  when setting an active switch failed, so the check that follows does not mistake it for a change
 *  made outside the extension. */
async function applyPrivacySwitch(sw: PrivacySwitch): Promise<boolean> {
  try {
    if (sw.active) {
      await sw.setting.set({ value: sw.value });
    } else {
      // clear() takes an (empty) details object; passing {} reverts control to the user's own setting.
      await sw.setting.clear({});
    }
    return true;
  } catch (err) {
    console.warn(`[poison] could not ${sw.active ? "set" : "clear"} ${sw.name}:`, err);
    return !sw.active;
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

// Protections turned off outside the extension (e.g. by hand in about:config). When that is noticed the
// setting is NOT put back: the protection is turned off in the config too, so its tick box matches what
// Firefox really does, and its key is remembered here so the popup can say why it was turned off. Kept in
// storage so the note survives a background restart. The key is dropped when the user ticks the
// protection again, or when the setting goes back to the protective value by hand.
const DISABLED_OUTSIDE_KEY = "poisonyourtrace.disabledOutside";

async function loadDisabledOutside(): Promise<Set<keyof Protections>> {
  const stored = await browser.storage.local.get(DISABLED_OUTSIDE_KEY);
  const raw: unknown = stored[DISABLED_OUTSIDE_KEY];
  return new Set(Array.isArray(raw) ? (raw as (keyof Protections)[]) : []);
}

async function saveDisabledOutside(keys: Set<keyof Protections>): Promise<void> {
  await browser.storage.local.set({ [DISABLED_OUTSIDE_KEY]: [...keys] });
}

// Protections whose last set() failed. A differing value is then our own failure, not a change made
// outside the extension, so it is reported as "mismatch" instead of turning the protection off.
const failedSets = new Set<keyof Protections>();

// Applies and checks run one after another, never at the same time. A check that overlaps an apply
// could read the config from before the apply, see a setting the apply just cleared, and turn it back
// on: the popup would then say a protection is off while Firefox still applies it. Two overlapping
// applies have the same problem (one's check "repairs" what the other has not written yet).
let queue: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  // Keep the queue alive if one task fails; the caller still sees the failure through `run`.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Read back what Firefox actually applies for one active switch. Never throws, never re-applies. The
 * cases:
 *   - expected value → "applied", whoever holds it (us, another extension, a policy).
 *   - another extension holds a different value → "other_extension": the most recently installed
 *     extension takes precedence, so ours cannot win; report only.
 *   - not controllable (enterprise policy) with a different value → "locked": report only.
 *   - our own set() failed → "mismatch".
 *   - controllable but different (typically changed by hand in about:config) → "disabled_outside": the
 *     change is respected and the caller turns the protection off in the config.
 */
async function verifyPrivacySwitch(sw: PrivacySwitch): Promise<ProtectionStatus> {
  try {
    const current = await sw.setting.get({});
    // The expected value is what matters: if another extension or a policy holds the setting at the
    // same value (uBlock Origin also disables prefetching and pings, for instance), the user is
    // protected, so this is not reported as a problem.
    if (current.value === sw.value) return "applied";
    if (current.levelOfControl === "controlled_by_other_extensions") return "other_extension";
    if (current.levelOfControl === "not_controllable") return "locked";
    if (failedSets.has(sw.key)) return "mismatch";
    return "disabled_outside";
  } catch (err) {
    console.warn(`[poison] could not read ${sw.name}:`, err);
    return "unavailable";
  }
}

/**
 * The real status of every protection. Privacy settings are read back from Firefox; containers are an
 * in-extension mechanism wired directly by applyConfig, so their state follows the config. A protection
 * found turned off outside the extension is turned off in the config as well (never put back).
 */
async function checkStatus(): Promise<ProtectionStatuses> {
  const config = await loadConfig();
  const disabledOutside = await loadDisabledOutside();
  const turnedOff: Partial<Protections> = {};
  const turnedBackOn: Partial<Protections> = {};
  const statuses = {} as ProtectionStatuses;

  for (const sw of privacySwitches(config)) {
    if (!config.enabled) {
      statuses[sw.key] = "off";
    } else if (disabledOutside.has(sw.key)) {
      // Turned off outside the extension earlier. If the setting has since been put back to the
      // protective value by hand, the protection is on again; otherwise keep explaining why it is off.
      const status = await verifyPrivacySwitch(sw);
      if (status === "applied") {
        disabledOutside.delete(sw.key);
        turnedBackOn[sw.key] = true;
        statuses[sw.key] = "applied";
      } else {
        statuses[sw.key] = "disabled_outside";
      }
    } else if (!sw.active) {
      statuses[sw.key] = "off";
    } else {
      const status = await verifyPrivacySwitch(sw);
      if (status === "disabled_outside") {
        console.warn(`[poison] ${sw.name} was changed outside the extension; turning the protection off.`);
        disabledOutside.add(sw.key);
        turnedOff[sw.key] = false;
      }
      statuses[sw.key] = status;
    }
  }

  const changed = { ...turnedOff, ...turnedBackOn };
  if (Object.keys(changed).length > 0) {
    await saveConfig({ protections: changed });
    await saveDisabledOutside(disabledOutside);
  }
  statuses.container = config.enabled && config.protections.container ? "applied" : "off";
  return statuses;
}

// True while a background check is waiting in the queue: a burst of triggers (tab switches, our own
// writes firing onChange) then adds a single check instead of piling them up.
let checkPending = false;

/** Check in the background, queued after any apply. Errors are already handled per
 *  setting. */
function checkInBackground(): void {
  if (checkPending) return;
  checkPending = true;
  void enqueue(() => {
    checkPending = false;
    return checkStatus();
  });
}

/** Apply the current config: wire every protection on when enabled + its flag is on, off otherwise.
 *  Idempotent — safe to call from any trigger, any number of times. Queued, never overlaps a check. */
function applyConfig(): Promise<void> {
  return enqueue(applyConfigNow);
}

async function applyConfigNow(): Promise<void> {
  const config = await loadConfig();
  const disabledOutside = await loadDisabledOutside();
  const before = disabledOutside.size;
  // The browser-wide privacy settings, each gated on enabled AND its own flag. Every set/clear is
  // independent and self-guarding, so one failing setting does not abort the rest.
  for (const sw of privacySwitches(config)) {
    if (disabledOutside.has(sw.key)) {
      // Ticked again by the user: the protection is theirs to turn back on.
      if (config.protections[sw.key]) {
        disabledOutside.delete(sw.key);
      } else {
        // Still off because it was changed outside the extension: leave the user's value alone (no set,
        // and no clear either, which could restore the value from before the extension took over).
        continue;
      }
    }
    if (await applyPrivacySwitch(sw)) failedSets.delete(sw.key);
    else failedSets.add(sw.key);
  }
  if (disabledOutside.size !== before) await saveDisabledOutside(disabledOutside);

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
// A check never writes a privacy setting, so it cannot trigger itself either.
void loadConfig().then((config) => {
  // The setting objects are the same whatever the config; it is only needed to build the list. A
  // setting missing on this Firefox build is skipped, so the others still get their listener.
  for (const sw of privacySwitches(config)) sw.setting?.onChange?.addListener(() => checkInBackground());
});
browser.tabs.onActivated.addListener(() => checkInBackground());

browser.runtime.onMessage.addListener(
  (message: unknown, _sender: browser.runtime.MessageSender): Promise<unknown> | undefined => {
    const msg = message as { type?: string };
    // The popup writes the config then sends this so the background re-wires every setting immediately.
    if (msg?.type === "poison:apply") {
      return applyConfig().then(() => ({ ok: true }));
    }
    // The popup asks for the real state when it opens and after each toggle.
    if (msg?.type === "poison:status") {
      return enqueue(checkStatus).then((statuses) => ({ statuses }));
    }
    return undefined;
  },
);
