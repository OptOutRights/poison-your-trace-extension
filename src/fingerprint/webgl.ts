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
const WEBGL_MASKED = "Mozilla";
const WEBGL_UNMASKED_VENDOR = "Google Inc. (Intel)";
const WEBGL_UNMASKED_RENDERER = "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)";

/**
 * Runs in the PAGE world. Must be fully self contained: it is serialized with `toString()` and may
 * reference only its arguments and standard globals, never module scope symbols.
 */
function pageWorldOverride(masked: string, unmaskedVendor: string, unmaskedRenderer: string): void {
  // Numeric enum values for the intercepted parameters. These are fixed by the WebGL and extension
  // specs, so hard coding them avoids depending on a live context: VENDOR and RENDERER are core GL
  // enums; the UNMASKED_* pair comes from WEBGL_debug_renderer_info.
  const VENDOR = 0x1f00;
  const RENDERER = 0x1f01;
  const UNMASKED_VENDOR_WEBGL = 0x9245;
  const UNMASKED_RENDERER_WEBGL = 0x9246;

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
}

function inject(): void {
  const code = `(${pageWorldOverride.toString()})(${JSON.stringify(WEBGL_MASKED)}, ${JSON.stringify(WEBGL_UNMASKED_VENDOR)}, ${JSON.stringify(WEBGL_UNMASKED_RENDERER)});`;
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
