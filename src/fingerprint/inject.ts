// Content script, registered dynamically at document_start when the extension is enabled.
//
// Uniformizes the JavaScript visible fingerprint toward the COMMON profile. It injects a page
// world <script> so the overrides are visible to the site's own scripts (a content script runs in
// an isolated world the page cannot see). The network layer half, the User Agent and Accept
// Language request headers, is handled in the background via webRequest so the two layers can never
// disagree.
//
// Caveat (documented seam): inline injection can be blocked by a strict page Content Security
// Policy. The header rewrite layer still applies there; the Firefox privileged wrappedJSObject and
// exportFunction route is the CSP proof hardening left for a later pass.

import { COMMON_PROFILE, type CommonProfile } from "./profile";
import { REPORT_MESSAGE_TYPE, OPAQUE_BEFORE, NEUTRALIZED_AFTER } from "./report";

/**
 * Runs in the PAGE world. Must be fully self contained: it is serialized with `toString()` and may
 * reference only its arguments and standard globals, never module scope symbols. The report tag and
 * sentinels are passed in as arguments so it can post its before and after captures out of the page
 * world without importing anything.
 */
function pageWorldOverride(p: CommonProfile, reportType: string, opaqueBefore: string, neutralized: string): void {
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

  // navigator
  const appVersion = p.ua.replace("Mozilla/", "");
  const oscpu = p.platform === "Win32" ? "Windows NT 10.0; Win64; x64" : p.platform;
  defineAndRecord(navigator, "userAgent", p.ua, "navigator");
  defineAndRecord(navigator, "appVersion", appVersion, "navigator");
  defineAndRecord(navigator, "platform", p.platform, "navigator");
  defineAndRecord(navigator, "language", p.language, "navigator");
  defineAndRecord(navigator, "languages", Object.freeze([...p.languages]), "navigator");
  defineAndRecord(navigator, "hardwareConcurrency", p.hardwareConcurrency, "navigator");
  defineAndRecord(navigator, "oscpu", oscpu, "navigator");

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

function inject(): void {
  const code = `(${pageWorldOverride.toString()})(${JSON.stringify(COMMON_PROFILE)}, ${JSON.stringify(REPORT_MESSAGE_TYPE)}, ${JSON.stringify(OPAQUE_BEFORE)}, ${JSON.stringify(NEUTRALIZED_AFTER)});`;
  const script = document.createElement("script");
  script.textContent = code;
  const root = document.documentElement ?? document.head ?? document.body;
  if (!root) return;
  root.prepend(script);
  script.remove();
}

inject();
