// Content script, registered dynamically at document_start in the page's MAIN world when the
// extension is enabled.
//
// Uniformizes the WebGL vendor and renderer fingerprint. The GPU vendor and renderer strings are a
// high entropy quasi identifier: the exact driver, GPU and ANGLE backend string is distinctive
// enough to single out a machine. We UNIFORMIZE toward ONE widely shared value so the signal
// carries close to zero distinguishing bits and the whole crowd clusters together, same philosophy
// as the profiles/ modules — one common value PER OS FAMILY (a Mac renderer under a Mac UA).
//
// Running in the MAIN world, the override applies directly to the page's own globals and is visible
// to the site's scripts. It patches getParameter on both WebGLRenderingContext and
// WebGL2RenderingContext so the VENDOR and RENDERER parameters and the WEBGL_debug_renderer_info
// UNMASKED_* parameters all return the chosen common strings. Because the browser injects the
// script rather than the DOM, the override survives a strict page Content Security Policy.

// A real Firefox reports "Mozilla" for the MASKED core params (getParameter(VENDOR) and
// getParameter(RENDERER)) and only exposes the GPU strings through the WEBGL_debug_renderer_info
// UNMASKED_* params. Returning the GPU string on the masked params would be a "Firefox that answers
// like Chrome" contradiction that ADDS entropy. So we split the two: masked returns Firefox's
// constant "Mozilla" (identical on every OS), unmasked returns the per family common GPU identity.
//
// The unmasked renderer is per OS on purpose (ticket #37): detectors cross check it against the UA's
// OS, so a Windows ANGLE/D3D11 renderer under a macOS UA is a tell. We resolve the same OS-family
// profile the navigator overrides use, and read its webgl identity.
import { REPORT_MESSAGE_TYPE } from "./report";
import { resolveProfileFromNavigator } from "./profiles";

const WEBGL_MASKED = "Mozilla";
// This script runs after inject.ts, which has already set navigator to the resolved profile's family,
// so reading navigator here yields that same family (and would fall back to the real one otherwise).
const osProfile = resolveProfileFromNavigator(navigator);
const WEBGL_UNMASKED_VENDOR = osProfile.webgl.unmaskedVendor;
const WEBGL_UNMASKED_RENDERER = osProfile.webgl.unmaskedRenderer;

/**
 * Runs in the page's MAIN world, reading and replacing the page's own globals, so it must rely only
 * on its arguments and standard page globals, never on extension APIs. The report tag is passed in
 * so it can post its before and after captures to the isolated-world relay.
 */
function pageWorldOverride(masked: string, unmaskedVendor: string, unmaskedRenderer: string, reportType: string): void {
  // Run at most once per document. A second injection into the same page would read our already
  // masked vendor and renderer as its "before", collapsing the popup's before and after to the same
  // text, so the guard keeps the override idempotent and the recorded "before" real.
  const guard = window as unknown as { __poisonWebglDone?: boolean };
  if (guard.__poisonWebglDone) return;
  guard.__poisonWebglDone = true;

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

// This file IS the page's MAIN world (world: "MAIN" content script), so apply the override
// directly. The constants are bundled in by esbuild; no toString() serialization round trip.
pageWorldOverride(WEBGL_MASKED, WEBGL_UNMASKED_VENDOR, WEBGL_UNMASKED_RENDERER, REPORT_MESSAGE_TYPE);

// Module scope (no runtime export): keeps pageWorldOverride file local so it does not collide with
// the sibling fingerprint content scripts in tsc's global script scope.
export {};
