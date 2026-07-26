// Content script, registered dynamically at document_start when the extension is enabled.
//
// Uniformizes navigator.plugins and navigator.mimeTypes toward a FIXED, widely shared Firefox 128
// configuration. Like inject.ts it injects a page world <script> so the override is visible to the
// site's own scripts.
//
// Why a constant list carries zero bits: modern Firefox and Chromium expose the SAME standardized
// set of five built in PDF "plugins" (real NPAPI plugins are gone). Presenting exactly that set,
// the crowd's default, means the plugin vector distinguishes no one. Randomizing would instead mint
// a per visit identifier, so we uniformize.
//
// Caveat (documented seam): inline injection can be blocked by a strict page Content Security
// Policy. The Firefox privileged wrappedJSObject and exportFunction route is the CSP proof
// hardening left for a later pass.

/**
 * The five standardized PDF plugin names modern Firefox 128 and Chromium report, in canonical
 * order.
 */
const PLUGIN_NAMES: readonly string[] = [
  "PDF Viewer",
  "Chrome PDF Viewer",
  "Chromium PDF Viewer",
  "Microsoft Edge PDF Viewer",
  "WebKit built-in PDF",
];

/** The two MIME types every one of the five PDF plugins advertises (matches real Firefox 128). */
const PLUGIN_MIME_TYPES: readonly { type: string; suffixes: string; description: string }[] = [
  { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
  { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" },
];

/**
 * Runs in the PAGE world. Must be fully self contained: it is serialized with `toString()` and may
 * reference only its arguments and standard globals, never module scope symbols.
 */
function pageWorldOverride(
  names: readonly string[],
  mimes: readonly { type: string; suffixes: string; description: string }[],
): void {
  const define = (obj: object, prop: string, value: unknown): void => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true, enumerable: true });
    } catch {
      /* some engines mark a prop non configurable; skip rather than throw into the page */
    }
  };

  try {
    // A shared, plausible MimeType like object per advertised type. `enabledPlugin` is wired to the
    // owning plugin below so the plugin and mimeType cross references are internally consistent.
    const mimeObjects = mimes.map((m) => {
      const mime: Record<string, unknown> = {
        type: m.type,
        suffixes: m.suffixes,
        description: m.description,
        enabledPlugin: null,
      };
      return mime;
    });

    // A plausible Plugin like object per name. Each is array like over its MIME types (numeric
    // indices, `.length`, `.item` and `.namedItem`), mirroring a real PluginArray entry.
    const pluginObjects = names.map((name) => {
      const plugin: Record<string, unknown> = {
        name,
        description: "Portable Document Format",
        filename: "internal-pdf-viewer",
        length: mimeObjects.length,
        item: (i: number): unknown => mimeObjects[i] ?? null,
        namedItem: (t: string): unknown => mimeObjects.find((mm) => mm.type === t) ?? null,
      };
      mimeObjects.forEach((mm, i) => {
        plugin[i] = mm;
        // Point each MIME's back reference at the first plugin that claims it (Firefox behaviour).
        if (mm.enabledPlugin === null) mm.enabledPlugin = plugin;
      });
      return plugin;
    });

    // Assemble the PluginArray like object: numeric indices, `.length`, and the standard lookups.
    const pluginArray: Record<string, unknown> = {
      length: pluginObjects.length,
      item: (i: number): unknown => pluginObjects[i] ?? null,
      namedItem: (n: string): unknown => pluginObjects.find((pp) => pp.name === n) ?? null,
      refresh: (): void => {
        /* no op: the list is fixed */
      },
    };
    pluginObjects.forEach((pp, i) => {
      pluginArray[i] = pp;
    });

    // Assemble the MimeTypeArray like object over the same MIME objects.
    const mimeTypeArray: Record<string, unknown> = {
      length: mimeObjects.length,
      item: (i: number): unknown => mimeObjects[i] ?? null,
      namedItem: (t: string): unknown => mimeObjects.find((mm) => mm.type === t) ?? null,
    };
    mimeObjects.forEach((mm, i) => {
      mimeTypeArray[i] = mm;
    });

    define(navigator, "plugins", pluginArray);
    define(navigator, "mimeTypes", mimeTypeArray);
  } catch {
    /* leave navigator untouched if the engine rejects the patch */
  }
}

function inject(): void {
  const code = `(${pageWorldOverride.toString()})(${JSON.stringify(PLUGIN_NAMES)}, ${JSON.stringify(PLUGIN_MIME_TYPES)});`;
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
