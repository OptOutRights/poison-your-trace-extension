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

/**
 * Runs in the PAGE world. Must be fully self contained: it is serialized with `toString()` and may
 * reference only its argument (`p`) and standard globals, never module scope symbols.
 */
function pageWorldOverride(p: CommonProfile): void {
  const define = (obj: object, prop: string, value: unknown): void => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true, enumerable: true });
    } catch {
      /* some engines mark a prop non configurable; skip rather than throw into the page */
    }
  };

  // navigator
  define(navigator, "userAgent", p.ua);
  define(navigator, "appVersion", p.ua.replace("Mozilla/", ""));
  define(navigator, "platform", p.platform);
  define(navigator, "language", p.language);
  define(navigator, "languages", Object.freeze([...p.languages]));
  define(navigator, "hardwareConcurrency", p.hardwareConcurrency);
  define(navigator, "oscpu", p.platform === "Win32" ? "Windows NT 10.0; Win64; x64" : p.platform);

  // screen and window
  define(screen, "width", p.screen.width);
  define(screen, "height", p.screen.height);
  define(screen, "availWidth", p.screen.availWidth);
  define(screen, "availHeight", p.screen.availHeight);
  define(screen, "colorDepth", p.colorDepth);
  define(screen, "pixelDepth", p.colorDepth);
  define(window, "devicePixelRatio", p.devicePixelRatio);

  // timezone: Intl.resolvedOptions().timeZone (the common probe) and Date.getTimezoneOffset must agree
  try {
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
  } catch {
    /* canvas API missing (e.g. worker), nothing to uniformize */
  }
}

function inject(): void {
  const code = `(${pageWorldOverride.toString()})(${JSON.stringify(COMMON_PROFILE)});`;
  const script = document.createElement("script");
  script.textContent = code;
  const root = document.documentElement ?? document.head ?? document.body;
  if (!root) return;
  root.prepend(script);
  script.remove();
}

inject();
