// Content script, registered dynamically at document_start when the extension is enabled.
//
// Uniformizes the WebGL vendor and renderer fingerprint. The GPU vendor and renderer strings are a
// high entropy quasi identifier: the exact driver, GPU and ANGLE backend string is distinctive
// enough to single out a machine. We UNIFORMIZE toward ONE widely shared value so the signal
// carries close to zero distinguishing bits and the whole crowd clusters together, same philosophy
// as profile.ts.
//
// It injects a page world <script> so the override is visible to the site's own scripts. The
// override patches getParameter on both WebGLRenderingContext and WebGL2RenderingContext so the
// VENDOR and RENDERER parameters and the WEBGL_debug_renderer_info UNMASKED_* parameters all return
// the chosen common strings.
//
// Caveat (documented seam): inline injection can be blocked by a strict page Content Security
// Policy. The CSP proof wrappedJSObject and exportFunction route is hardening left for a later pass.

// A real Firefox reports "Mozilla" for the MASKED core params (getParameter(VENDOR) and
// getParameter(RENDERER)) and only exposes the ANGLE GPU strings through the
// WEBGL_debug_renderer_info UNMASKED_* params. Returning the ANGLE string on the masked params
// would be a "Firefox that answers like Chrome" contradiction that ADDS entropy. So we split the
// two: masked returns Firefox's constant "Mozilla", unmasked returns the common ANGLE identity.
// Intel UHD Graphics 620 is one of the most common integrated GPUs, maximizing the anonymity set.
import { REPORT_MESSAGE_TYPE } from "./report";

const WEBGL_MASKED = "Mozilla";
const WEBGL_UNMASKED_VENDOR = "Google Inc. (Intel)";
const WEBGL_UNMASKED_RENDERER = "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)";

/**
 * Runs in the PAGE world. Must be fully self contained: it is serialized with `toString()` and may
 * reference only its arguments and standard globals, never module scope symbols. The report tag is
 * passed in so it can post its before and after captures out of the page world without importing.
 */
function pageWorldOverride(masked: string, unmaskedVendor: string, unmaskedRenderer: string, reportType: string): void {
  // Numeric enum values for the intercepted parameters. These are fixed by the WebGL and extension
  // specs, so hard coding them avoids depending on a live context: VENDOR and RENDERER are core GL
  // enums; the UNMASKED_* pair comes from WEBGL_debug_renderer_info.
  const VENDOR = 0x1f00;
  const RENDERER = 0x1f01;
  const UNMASKED_VENDOR_WEBGL = 0x9245;
  const UNMASKED_RENDERER_WEBGL = 0x9246;

  // Read the REAL vendor and renderer once, before the override is installed, so the popup can show
  // the true GPU identity the page would have seen. We probe a live context off screen and query
  // the same four params we are about to uniformize. This runs on the untouched originals.
  const captures: { signal: string; group: string; before: string; after: string }[] = [];
  const readReal = (): { vendor: string; renderer: string; unmaskedVendor: string; unmaskedRenderer: string } => {
    const real = { vendor: "", renderer: "", unmaskedVendor: "", unmaskedRenderer: "" };
    try {
      const canvas = document.createElement("canvas");
      const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as {
        getParameter: (p: number) => unknown;
        getExtension: (n: string) => { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
      } | null;
      if (gl) {
        real.vendor = String(gl.getParameter(VENDOR));
        real.renderer = String(gl.getParameter(RENDERER));
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        if (dbg) {
          real.unmaskedVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
          real.unmaskedRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
        }
      }
    } catch {
      /* no WebGL on this engine, or context creation blocked: leave the reals empty */
    }
    return real;
  };
  const real = readReal();
  captures.push({ signal: "webgl.vendor", group: "webgl", before: real.vendor, after: masked });
  captures.push({ signal: "webgl.renderer", group: "webgl", before: real.renderer, after: masked });
  captures.push({ signal: "webgl.unmaskedVendor", group: "webgl", before: real.unmaskedVendor, after: unmaskedVendor });
  captures.push({ signal: "webgl.unmaskedRenderer", group: "webgl", before: real.unmaskedRenderer, after: unmaskedRenderer });

  // Wrap one prototype's getParameter: the masked core VENDOR and RENDERER return Firefox's
  // constant "Mozilla" (what a real Firefox reports), while the debug renderer UNMASKED_* params
  // return the common ANGLE identity. Everything else (capabilities, limits, precision, ...)
  // delegates to the untouched original so real WebGL apps keep working.
  const patch = (proto: { getParameter?: (p: number) => unknown } | undefined): void => {
    if (!proto || typeof proto.getParameter !== "function") return;
    try {
      const original = proto.getParameter;
      proto.getParameter = function getParameter(this: unknown, parameter: number): unknown {
        if (parameter === VENDOR || parameter === RENDERER) return masked;
        if (parameter === UNMASKED_VENDOR_WEBGL) return unmaskedVendor;
        if (parameter === UNMASKED_RENDERER_WEBGL) return unmaskedRenderer;
        return original.call(this, parameter);
      };
    } catch {
      /* engine rejected the reassignment, leave this context type untouched */
    }
  };

  // WebGL2 may be undefined on this engine; the guard is inside `patch`. We deliberately do NOT
  // touch getExtension: the real WEBGL_debug_renderer_info still hands sites the numeric UNMASKED_*
  // constants, and our getParameter override supplies the uniformized strings when those constants
  // are read.
  const g = window as unknown as {
    WebGLRenderingContext?: { prototype: { getParameter?: (p: number) => unknown } };
    WebGL2RenderingContext?: { prototype: { getParameter?: (p: number) => unknown } };
  };
  if (g.WebGLRenderingContext) patch(g.WebGLRenderingContext.prototype);
  if (g.WebGL2RenderingContext) patch(g.WebGL2RenderingContext.prototype);

  // Post the before and after pairs to the isolated world relay. A failure here must not disturb
  // the page: capture is a read out for the popup, never a protection.
  try {
    window.postMessage({ type: reportType, captures }, "*");
  } catch {
    /* postMessage unavailable: drop the batch, the override still applied */
  }
}

function inject(): void {
  const code = `(${pageWorldOverride.toString()})(${JSON.stringify(WEBGL_MASKED)}, ${JSON.stringify(WEBGL_UNMASKED_VENDOR)}, ${JSON.stringify(WEBGL_UNMASKED_RENDERER)}, ${JSON.stringify(REPORT_MESSAGE_TYPE)});`;
  const script = document.createElement("script");
  script.textContent = code;
  const root = document.documentElement ?? document.head ?? document.body;
  if (!root) return;
  root.prepend(script);
  script.remove();
}

inject();

// Module scope (no runtime export): keeps pageWorldOverride and inject file local so they do not
// collide with the sibling fingerprint content scripts in tsc's global script scope.
export {};
