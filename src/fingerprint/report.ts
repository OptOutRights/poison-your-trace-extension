// Before and after capture: the shared data contract between the page world overrides, the content
// script relay, the background store, and the popup (ticket #6).
//
// Each fingerprint override, before it replaces a signal, reads the REAL value the page would have
// seen. It then posts a list of { signal, before, after } entries out of the page world with
// window.postMessage. A tiny relay content script (report-relay.ts) forwards those to the
// background, which keeps them per tab so the popup can answer "what did this tab's fingerprint look
// like before versus after".
//
// Design constraint: the override functions are serialized with toString() and injected into the
// page world, so they cannot import from this module. They inline their own posting primitive. This
// module owns the CONTRACT (the message tag, the entry shape, the signal names) so every producer
// and consumer agrees on one vocabulary.

/** The postMessage tag that marks a before and after report coming out of the page world. */
export const REPORT_MESSAGE_TYPE = "poison:capture";

/** The runtime message the popup sends to the background to read a tab's captures. */
export const GET_CAPTURES_MESSAGE_TYPE = "poison:getCaptures";

/**
 * One captured signal. `before` is the real value the page would have seen with the extension off,
 * `after` is the uniformized value it now sees. Both are stringified for a stable, popup ready shape.
 * Signals with no scalar value (canvas, Web Audio) use the sentinels below.
 */
export interface SignalCapture {
  /** Stable identifier for the signal, e.g. "navigator.userAgent" or "canvas.readback". */
  signal: string;
  /** Human readable group the popup can use to lay out related rows, e.g. "navigator". */
  group: string;
  /** The real value with protection off. */
  before: string;
  /** The uniformized value with protection on. */
  after: string;
}

/** The envelope a page world override posts with window.postMessage. */
export interface CaptureMessage {
  type: typeof REPORT_MESSAGE_TYPE;
  captures: SignalCapture[];
}

/** Sentinel `before` value for signals with no readable scalar (canvas, Web Audio). */
export const OPAQUE_BEFORE = "device signature";
/** Sentinel `after` value for those same signals once neutralized. */
export const NEUTRALIZED_AFTER = "neutralized";

/** Type guard the relay uses to accept only well formed capture envelopes from the page. */
export function isCaptureMessage(value: unknown): value is CaptureMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as { type?: unknown; captures?: unknown };
  return msg.type === REPORT_MESSAGE_TYPE && Array.isArray(msg.captures);
}
