// The REAL state of each protection, as Firefox reports it, as opposed to what the stored config asks
// for. The background computes it (it owns the privacy.* settings) and the popup renders it, so a
// protection is never shown as working when Firefox is not actually applying it.

import type { Protections } from "./config";

/**
 * - applied: active and Firefox reports the expected value.
 * - off: turned off on purpose (master switch or its own toggle), so nothing is expected.
 * - reapplied: was changed outside the extension (e.g. by hand in about:config) and has been put back.
 * - other_extension: another extension controls this setting, so ours cannot apply it.
 * - locked: not controllable at all (typically an enterprise policy).
 * - mismatch: controllable by us, but the value still differs after trying to re-apply it.
 * - unavailable: the setting could not be read (API missing on this Firefox build).
 */
export type ProtectionStatus =
  | "applied"
  | "off"
  | "reapplied"
  | "other_extension"
  | "locked"
  | "mismatch"
  | "unavailable";

export type ProtectionStatuses = Record<keyof Protections, ProtectionStatus>;

/** Statuses where the user believes a protection is on but it is not (or was not) actually applied. */
export const PROBLEM_STATUSES: ReadonlySet<ProtectionStatus> = new Set([
  "other_extension",
  "locked",
  "mismatch",
  "unavailable",
]);
