// On device configuration. Poison your Trace ships as "one brick": a single on and off switch is the
// whole product surface. The only other setting is a correctness escape hatch, not a preference:
// which OS family the fingerprint presents. It defaults to "auto" (detect the real OS) and a user
// only touches it if detection ever reports the wrong family for their machine.

import type { OsFamily } from "./fingerprint/profiles";

/** The complete user facing state. */
export interface PoisonConfig {
  /** Master switch. When false the extension registers no scripts and rewrites no headers. */
  enabled: boolean;
  /**
   * The OS family the fingerprint presents. "auto" resolves the machine's real family; an explicit
   * family overrides that resolution (a manual correction when auto detection got it wrong).
   */
  osFamily: OsFamily | "auto";
}

const STORAGE_KEY = "poisonyourtrace.config";

const DEFAULTS: PoisonConfig = { enabled: true, osFamily: "auto" };

/**
 * Load the config from on device storage. A fresh profile has nothing saved yet, so we default to
 * enabled: the product protects you from first load, matching the "if a signal can be hidden it is
 * hidden" philosophy. OS family defaults to auto detection.
 */
export async function loadConfig(): Promise<PoisonConfig> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY] as Partial<PoisonConfig> | undefined;
  return {
    enabled: raw?.enabled ?? DEFAULTS.enabled,
    osFamily: raw?.osFamily ?? DEFAULTS.osFamily,
  };
}

/**
 * Persist config to on device storage only (local first, nothing leaves the machine). Accepts a
 * partial patch and merges it over the current config, so a caller that only flips `enabled` never
 * clobbers `osFamily` and vice versa.
 */
export async function saveConfig(patch: Partial<PoisonConfig>): Promise<void> {
  const current = await loadConfig();
  await browser.storage.local.set({ [STORAGE_KEY]: { ...current, ...patch } });
}
