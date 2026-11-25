// The REAL state of each protection, as Firefox reports it, as opposed to what the stored config asks
// for. The background computes it (it owns the privacy.* settings) and the popup renders it, so a
// protection is never shown as working when Firefox is not actually applying it.

import type { Protections } from "./config";

/**
 * - applied: active and Firefox reports the expected value.
 * - off: turned off on purpose (master switch or its own toggle), so nothing is expected.
 * - disabled_outside: turned off outside the extension (e.g. by hand in about:config). It is not put
 *   back: the protection is turned off in the config too, and the user can tick it again to re-enable it.
 * - other_extension: another extension controls this setting, so ours cannot apply it.
 * - locked: not controllable at all (typically an enterprise policy).
 * - mismatch: controllable by us, but setting it failed, so the value differs.
 * - unavailable: the setting could not be read (API missing on this Firefox build).
 */
export type ProtectionStatus =
  | "applied"
  | "off"
  | "disabled_outside"
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

/** Message the background sends to every open extension page after each check, carrying the fresh
 *  statuses, so a page left open (the How it works page) follows changes made elsewhere. */
export const STATUS_CHANGED = "poison:status-changed";

export interface StatusChangedMessage {
  type: typeof STATUS_CHANGED;
  statuses: ProtectionStatuses;
}

// What to tell the user when a protection is not in the state its tick box suggests. "applied" and
// "off" need no note: the tick box already says it all.
const STATUS_NOTES: Partial<Record<ProtectionStatus, string>> = {
  disabled_outside: "This was turned off in Firefox's settings, outside the extension. Tick it to turn it back on.",
  other_extension: "Another extension controls this setting, so it can't be turned on here.",
  locked: "This setting is locked on this computer (for example by your organisation), so it can't be turned on.",
  mismatch: "Firefox isn't applying this right now. Tick it to try again.",
  unavailable: "This setting isn't available in your version of Firefox.",
};

// Problems the user can't fix with the tick box: it is greyed out. A "mismatch" stays clickable, since
// ticking it again re-applies the setting.
const UNFIXABLE: ReadonlySet<ProtectionStatus> = new Set(["other_extension", "locked", "unavailable"]);

/**
 * Make one protection's tick box and note match the real state Firefox reports: a protection that is
 * not actually applied is shown unticked. For a lock or another extension the stored config still asks
 * for it (so it comes back on its own once they go away); a protection turned off outside the extension
 * is off in the config too, and comes back only when the user ticks it again. `status` is undefined
 * when the real state is unknown: the tick box then follows the config and no note is shown. The note
 * is a <p class="prot-status"> appended to `text` (created or removed as needed).
 */
export function paintProtection(
  toggle: HTMLInputElement,
  text: HTMLElement | null,
  enabled: boolean,
  wanted: boolean,
  status: ProtectionStatus | undefined,
): void {
  const problem = status !== undefined && PROBLEM_STATUSES.has(status);
  toggle.checked = problem ? false : wanted;
  toggle.disabled = !enabled || (status !== undefined && UNFIXABLE.has(status));

  if (!text) return;
  let note = text.querySelector<HTMLElement>(".prot-status");
  const message = status ? STATUS_NOTES[status] : undefined;
  if (!message) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement("p");
    text.append(note);
  }
  // Turned off outside the extension: red, since the user may not know their protection is gone. The
  // other notes are warnings.
  note.className = status === "disabled_outside" ? "prot-status error" : "prot-status warn";
  note.textContent = message;
}

/** Ask the background for the real state. Null if it can't answer, in which case no notes are shown. */
export async function fetchStatuses(): Promise<ProtectionStatuses | null> {
  try {
    const res = (await browser.runtime.sendMessage({ type: "poison:status" })) as { statuses?: ProtectionStatuses };
    return res?.statuses ?? null;
  } catch {
    return null;
  }
}
