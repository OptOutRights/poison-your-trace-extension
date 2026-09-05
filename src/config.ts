// On device configuration. Poison your Trace ships as "one brick": a single on and off switch is the
// hero surface. Under it sits a per protection breakdown — each protection is a plain boolean the
// popup's "Détails" disclosure exposes, so a user who hits a broken site can turn ONE protection off
// (typically RFP, which is global and can visibly alter a site) without losing the rest. Everything
// defaults on: the product protects you from first load, matching the "if a signal can be hidden it is
// hidden" philosophy.

/**
 * The per protection switches. Each is an independent boolean the popup toggles; the background gates
 * every protection on BOTH `enabled` and its own flag, so the master switch stays authoritative while
 * a single protection can still be turned off on its own.
 */
export interface Protections {
  /** Firefox Resist Fingerprinting (RFP). Global, browser wide — may visibly change a site. */
  rfp: boolean;
  /** WebRTC IP handling policy set to disable_non_proxied_udp, so a STUN request cannot leak the LAN/real IP. */
  webrtc: boolean;
  /** Firefox Tracking Protection forced to "always" (on in private and normal windows alike). */
  trackingProtection: boolean;
  /** Hyperlink auditing (<a ping>) beacons disabled, so a click cannot silently notify a third party. */
  hyperlinkAuditing: boolean;
  /** Network prediction (speculative DNS/TCP/prefetch) disabled, so the browser does not reach out ahead of intent. */
  networkPrediction: boolean;
  /** Auto per site containers, so each site's cookies live in their own jar (the containers unit owns the mechanism). */
  container: boolean;
  /** Burner email autofill, so a signup form is filled with a per site alias (the email unit owns the mechanism). */
  burnerEmail: boolean;
}

/** The complete user facing state: the master switch plus the per protection breakdown. */
export interface PoisonConfig {
  /** Master switch. When false every protection stands down regardless of its own flag. */
  enabled: boolean;
  /** Per protection switches, all defaulting on. */
  protections: Protections;
}

const STORAGE_KEY = "poisonyourtrace.config";

const DEFAULT_PROTECTIONS: Protections = {
  rfp: true,
  webrtc: true,
  trackingProtection: true,
  hyperlinkAuditing: true,
  networkPrediction: true,
  container: true,
  burnerEmail: true,
};

/**
 * The authoritative list of protection keys, derived from DEFAULT_PROTECTIONS so it can never drift
 * from the schema: adding a key to `Protections` + DEFAULT_PROTECTIONS is a compile error until it is
 * added here too (the cast is checked against `keyof Protections`). loadConfig and the popup both
 * iterate this, so there is exactly one place to touch when a protection is added.
 */
export const PROTECTION_KEYS = Object.keys(DEFAULT_PROTECTIONS) as (keyof Protections)[];

const DEFAULTS: PoisonConfig = { enabled: true, protections: DEFAULT_PROTECTIONS };

/**
 * Load the config from on device storage. A fresh profile has nothing saved yet, so we default to
 * enabled with every protection on. We also migrate gracefully: an OLD stored config carried
 * `{ enabled, osFamily }` and no `protections` at all — it loads here with every protection defaulting
 * on, so upgrading users keep full coverage. Each protection key is defaulted independently, so a
 * partial `protections` object (only some keys stored) still fills the gaps with the defaults.
 */
export async function loadConfig(): Promise<PoisonConfig> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  // The stored shape is untrusted: it may be the new shape, the old `{ enabled, osFamily }` shape, or
  // a partial. We read `protections` loosely and rebuild it key by key so any missing key defaults on.
  const raw = stored[STORAGE_KEY] as { enabled?: boolean; protections?: Partial<Protections> } | undefined;
  const storedProtections = raw?.protections;
  // Start from the all-on defaults, then override each known key ONLY when the stored value is a real
  // boolean. This both migrates the old `{ enabled, osFamily }` shape (no `protections` → all default
  // on) and defends against a garbage stored value (a non-boolean is ignored, keeping the default).
  const protections = { ...DEFAULT_PROTECTIONS };
  for (const key of PROTECTION_KEYS) {
    const value = storedProtections?.[key];
    if (typeof value === "boolean") protections[key] = value;
  }
  return {
    enabled: raw?.enabled ?? DEFAULTS.enabled,
    protections,
  };
}

/** A patch accepted by saveConfig: `enabled` and/or a partial set of protection flags. `protections`
 *  is deliberately a `Partial<Protections>` so a caller can flip a single key without naming the rest. */
export interface PoisonConfigPatch {
  enabled?: boolean;
  protections?: Partial<Protections>;
}

/**
 * Persist config to on device storage only (local first, nothing leaves the machine). Accepts a
 * partial patch and merges it over the current config. `protections` is DEEP merged: a caller that
 * flips a single protection key passes `{ protections: { rfp: false } }` and the other protection keys
 * are preserved from the current config rather than clobbered. `enabled` merges shallowly as before.
 */
export async function saveConfig(patch: PoisonConfigPatch): Promise<void> {
  const current = await loadConfig();
  const next: PoisonConfig = {
    enabled: patch.enabled ?? current.enabled,
    // Spread current first, then the patch's protections, so only the supplied keys change.
    protections: { ...current.protections, ...(patch.protections ?? {}) },
  };
  await browser.storage.local.set({ [STORAGE_KEY]: next });
}
