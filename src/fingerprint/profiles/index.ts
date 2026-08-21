// Per-OS fingerprint profiles: detect the REAL OS family, then resolve the one common profile for
// that family. This is the single seam that replaces the old per-branch "if platform === Win32"
// logic — callers never special case an OS, they resolve a profile and read its fields.

import type { CommonProfile, OsFamily } from "./base";
import { WINDOWS_PROFILE } from "./windows";
import { MAC_PROFILE } from "./mac";
import { LINUX_PROFILE } from "./linux";

export type { CommonProfile, OsFamily } from "./base";
export { acceptLanguageHeader } from "./base";

/** The profile presented for each family. A plain lookup keeps resolution branch free. */
const PROFILES: Record<OsFamily, CommonProfile> = {
  windows: WINDOWS_PROFILE,
  mac: MAC_PROFILE,
  linux: LINUX_PROFILE,
};

/** The common profile for a given family. */
export function resolveProfile(family: OsFamily): CommonProfile {
  return PROFILES[family];
}

/**
 * Resolve the profile for the family the page's `navigator` reports. This is the page world's single
 * entry point (both inject.ts and webgl.ts use it), so the `oscpu` cast — Firefox exposes
 * navigator.oscpu but the DOM lib does not type it — lives in exactly one place.
 *
 * Called before any override has run it reads the machine's real family; called after the navigator
 * overrides it reads the already-applied profile, which is the SAME family, so the result is stable.
 */
export function resolveProfileFromNavigator(nav: Navigator): CommonProfile {
  return resolveProfile(osFamilyFromHints(nav.platform, nav.userAgent, (nav as { oscpu?: string }).oscpu));
}

/**
 * Classify the real OS family from any available hints — navigator.platform / userAgent / oscpu in
 * the page world, or browser.runtime.getPlatformInfo().os in the background. All hints are matched
 * case insensitively against a single joined string, so the caller just passes whatever it has.
 *
 * We do NOT spoof across families (see base.ts), so an unrecognized hint falls back to Windows: the
 * most populous family and therefore the safest default for the anonymity set.
 */
export function osFamilyFromHints(...hints: (string | null | undefined)[]): OsFamily {
  const haystack = hints.filter(Boolean).join(" ").toLowerCase();
  // "mac" also covers getPlatformInfo's "mac"; iOS strings are grouped with macOS.
  if (/mac|darwin|iphone|ipad/.test(haystack)) return "mac";
  // "win" covers "Win32"/"Windows"/getPlatformInfo's "win".
  if (/win/.test(haystack)) return "windows";
  // "linux"/"x11" plus getPlatformInfo's "linux"/"cros"/"openbsd" and Android, all Mesa/Linux-ish.
  if (/linux|x11|cros|bsd|android/.test(haystack)) return "linux";
  return "windows";
}
