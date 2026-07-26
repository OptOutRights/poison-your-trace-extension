// On device configuration. Poison your Trace ships as "one brick": a single on and off switch.
// There are no tiers, no options page, no per site knobs. When enabled is true every protection
// applies; when it is false the extension stands fully down.

/** The complete user facing state: one boolean. */
export interface PoisonConfig {
  /** Master switch. When false the extension registers no scripts and rewrites no headers. */
  enabled: boolean;
}

const STORAGE_KEY = "poisonyourtrace.config";

/**
 * Load the config from on device storage. A fresh profile has nothing saved yet, so we default to
 * enabled: the product protects you from first load, matching the "if a signal can be hidden it is
 * hidden" philosophy.
 */
export async function loadConfig(): Promise<PoisonConfig> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY] as Partial<PoisonConfig> | undefined;
  return { enabled: raw?.enabled ?? true };
}

/** Persist config to on device storage only (local first, nothing leaves the machine). */
export async function saveConfig(config: PoisonConfig): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: config });
}
