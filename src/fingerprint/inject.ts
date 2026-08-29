// Content script, registered dynamically at document_start in the page's MAIN world when the
// extension is enabled.
//
// Uniformizes the JavaScript visible fingerprint toward the COMMON profile. Running in the MAIN
// world means the overrides are applied directly to the page's own globals and are visible to the
// site's scripts, and — because the browser injects the script rather than the DOM — they keep
// working under a strict page Content Security Policy. The network layer half, the User Agent and
// Accept Language request headers, is handled in the background via webRequest so the two layers can
// never disagree.
//
// The MAIN world has no extension APIs, so before/after captures are posted with window.postMessage
// and forwarded to the background by the isolated-world relay (report-relay.ts).

import { resolveProfileFromPage, type CommonProfile } from "./profiles";
import { REPORT_MESSAGE_TYPE, OPAQUE_BEFORE, NEUTRALIZED_AFTER } from "./report";

/**
 * Runs in the page's MAIN world, reading and replacing the page's own globals, so it must rely only
 * on its arguments and standard page globals, never on extension APIs. The report tag and sentinels
 * are passed in as arguments so it can post its before and after captures to the isolated-world
 * relay.
 */
function pageWorldOverride(p: CommonProfile, reportType: string, opaqueBefore: string, neutralized: string): void {
  // Run at most once per document. If this override is injected twice into the same page (e.g. a
  // race that registers the content script twice), a second run would read the value we already
  // overrode as its "before", collapsing the popup's before and after to the same text. The guard
  // makes the override idempotent so the recorded "before" is always the page's real value.
  const guard = window as unknown as { __poisonFingerprintDone?: boolean };
  if (guard.__poisonFingerprintDone) return;
  guard.__poisonFingerprintDone = true;

  // Collected before and after pairs, posted to the isolated world relay at the end of the run.
  const captures: { signal: string; group: string; before: string; after: string }[] = [];
  const toStr = (v: unknown): string => {
    try {
      if (Array.isArray(v)) return v.join(", ");
      return String(v);
    } catch {
      return "";
    }
  };
  // Record the real value (read BEFORE we replace it) against the value we are about to apply.
  const record = (signal: string, group: string, before: unknown, after: unknown): void => {
    captures.push({ signal, group, before: toStr(before), after: toStr(after) });
  };

  const define = (obj: object, prop: string, value: unknown): void => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true, enumerable: true });
    } catch {
      /* some engines mark a prop non configurable; skip rather than throw into the page */
    }
  };
  // Capture the real value first, then define the override, so `before` is never the overridden one.
  const defineAndRecord = (obj: object, prop: string, value: unknown, group: string): void => {
    let before: unknown = "";
    try {
      before = (obj as Record<string, unknown>)[prop];
    } catch {
      /* reading the original threw: leave before empty rather than fail the whole override */
    }
    record(`${group}.${prop}`, group, before, value);
    define(obj, prop, value);
  };

  // navigator. platform, oscpu and the UA all come straight from the resolved profile, so they agree
  // with each other and with the machine's real OS family by construction — no per-OS branching here.
  const appVersion = p.ua.replace("Mozilla/", "");
  defineAndRecord(navigator, "userAgent", p.ua, "navigator");
  defineAndRecord(navigator, "appVersion", appVersion, "navigator");
  defineAndRecord(navigator, "platform", p.platform, "navigator");
  defineAndRecord(navigator, "language", p.language, "navigator");
  defineAndRecord(navigator, "languages", Object.freeze([...p.languages]), "navigator");
  defineAndRecord(navigator, "hardwareConcurrency", p.hardwareConcurrency, "navigator");
  defineAndRecord(navigator, "oscpu", p.oscpu, "navigator");

  // screen and window
  defineAndRecord(screen, "width", p.screen.width, "screen");
  defineAndRecord(screen, "height", p.screen.height, "screen");
  defineAndRecord(screen, "availWidth", p.screen.availWidth, "screen");
  defineAndRecord(screen, "availHeight", p.screen.availHeight, "screen");
  defineAndRecord(screen, "colorDepth", p.colorDepth, "screen");
  defineAndRecord(screen, "pixelDepth", p.colorDepth, "screen");
  defineAndRecord(window, "devicePixelRatio", p.devicePixelRatio, "screen");

  // timezone: Intl.resolvedOptions().timeZone (the common probe) and Date.getTimezoneOffset must agree
  try {
    let beforeZone = "";
    let beforeOffset: unknown = "";
    try {
      beforeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
      beforeOffset = new Date().getTimezoneOffset();
    } catch {
      /* reading the real timezone threw: leave before empty */
    }
    record("timezone.zone", "timezone", beforeZone, p.timezone);
    record("timezone.offsetMinutes", "timezone", beforeOffset, p.timezoneOffsetMinutes);
    const origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function resolvedOptions() {
      const opts = origResolved.call(this);
      opts.timeZone = p.timezone;
      return opts;
    };
    Date.prototype.getTimezoneOffset = function getTimezoneOffset() {
      return p.timezoneOffsetMinutes;
    };
  } catch {
    /* leave timezone untouched if the engine rejects the patch */
  }

  // canvas: uniformize the READBACK toward a plausible, per user identical value. We do NOT return
  // a fixed tiny blank: a 1x1 PNG is a spoofer tell, because no real Firefox reads back a 1x1 image
  // for a larger canvas, so it would ADD entropy. Instead every read path returns a FRESH
  // TRANSPARENT canvas of the SAME pixel dimensions, encoded by Firefox's own encoder: real PNG
  // bytes, correct size, but none of the site drawn content. Same dimensions means identical bytes
  // for every user, so the signal carries close to zero bits (uniformize, not randomize).
  // Documented friction cost: legitimate canvas readback is broken.
  try {
    const canvasProto = HTMLCanvasElement.prototype as unknown as {
      toDataURL: (...args: unknown[]) => string;
      toBlob: (...args: unknown[]) => void;
    };
    const origToDataURL = canvasProto.toDataURL;
    const origToBlob = canvasProto.toBlob;
    // A fresh, unpainted canvas matching the source dimensions. Encoding THIS via the ORIGINAL
    // method (not the override) yields the neutralized readback and avoids recursion. getImageData
    // below returns the same transparent pixels, so the two read paths stay mutually consistent.
    const blankLike = (w: number, h: number): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, w | 0);
      c.height = Math.max(1, h | 0);
      return c;
    };
    canvasProto.toDataURL = function toDataURL(this: HTMLCanvasElement, ...args: unknown[]): string {
      return origToDataURL.apply(blankLike(this.width, this.height), args);
    };
    canvasProto.toBlob = function toBlob(this: HTMLCanvasElement, ...args: unknown[]): void {
      origToBlob.apply(blankLike(this.width, this.height), args);
    };
    const ctxProto = CanvasRenderingContext2D.prototype as unknown as {
      getImageData: (x: number, y: number, w: number, h: number) => ImageData;
    };
    ctxProto.getImageData = function getImageData(_x, _y, w, h) {
      return new ImageData(Math.max(1, w | 0), Math.max(1, h | 0));
    };

    // OffscreenCanvas is a second canvas surface usable on the main thread too (via
    // new OffscreenCanvas(...) or HTMLCanvasElement.transferControlToOffscreen()), with its own
    // readback paths that bypass the HTMLCanvasElement patch above: convertToBlob() and the 2D
    // context's getImageData(). Left alone they leak the same device drawn signature, so neutralize
    // them identically — encode a FRESH blank OffscreenCanvas of the same size, and hand back
    // transparent pixels — keeping the main-thread canvas signal consistent whichever surface a site
    // reads. (The worker-side copy of this same neutralization lives in workers.ts.)
    const offscreenCtor = (window as unknown as {
      OffscreenCanvas?: { prototype: { convertToBlob?: (...args: unknown[]) => Promise<Blob> } } & (new (w: number, h: number) => { width: number; height: number });
    }).OffscreenCanvas;
    if (offscreenCtor && typeof offscreenCtor.prototype.convertToBlob === "function") {
      const origConvertToBlob = offscreenCtor.prototype.convertToBlob;
      offscreenCtor.prototype.convertToBlob = function convertToBlob(this: { width: number; height: number }, ...args: unknown[]): Promise<Blob> {
        const blank = new offscreenCtor(Math.max(1, this.width | 0), Math.max(1, this.height | 0));
        return origConvertToBlob.apply(blank, args);
      };
    }
    const offscreenCtxProto = (window as unknown as {
      OffscreenCanvasRenderingContext2D?: { prototype: { getImageData?: (x: number, y: number, w: number, h: number) => ImageData } };
    }).OffscreenCanvasRenderingContext2D?.prototype;
    if (offscreenCtxProto && typeof offscreenCtxProto.getImageData === "function") {
      offscreenCtxProto.getImageData = function getImageData(_x, _y, w, h) {
        return new ImageData(Math.max(1, w | 0), Math.max(1, h | 0));
      };
    }
    // Canvas readback has no scalar value to compare, so we report the agreed sentinels: the real
    // device drawn signature before, neutralized after.
    record("canvas.readback", "canvas", opaqueBefore, neutralized);
  } catch {
    /* canvas API missing (e.g. worker), nothing to uniformize */
  }

  // Post the collected before and after pairs to the isolated world relay. This is a read out for
  // the popup, never a protection, so a failure here must not disturb the page.
  try {
    window.postMessage({ type: reportType, captures }, "*");
  } catch {
    /* postMessage unavailable or serialization failed: drop the batch, overrides still applied */
  }
}

// This file IS the page's MAIN world (world: "MAIN" content script), so apply the overrides
// directly. All three OS profiles are bundled in by esbuild; the background injects the resolved OS
// family (from getPlatformInfo, honouring any user override) as window.__poisonOsFamily just before
// this script, so we present the common profile FOR THAT FAMILY and never claim a different OS than
// the machine's real one. If that global is absent we fall back to detecting from the real navigator.
pageWorldOverride(resolveProfileFromPage(window), REPORT_MESSAGE_TYPE, OPAQUE_BEFORE, NEUTRALIZED_AFTER);
