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

import { REPORT_MESSAGE_TYPE } from "./report";

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
 * reference only its arguments and standard globals, never module scope symbols. The report tag is
 * passed in so it can post its before and after captures out of the page world without importing.
 */
function pageWorldOverride(
  names: readonly string[],
  mimes: readonly { type: string; suffixes: string; description: string }[],
  reportType: string,
): void {
  const define = (obj: object, prop: string, value: unknown): void => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true, enumerable: true });
    } catch {
      /* some engines mark a prop non configurable; skip rather than throw into the page */
    }
  };

  // Read the REAL plugin and mimeType lists first, before the override, as comma joined names so the
  // popup can show what the page would have seen. Reading a live PluginArray is index based.
  const captures: { signal: string; group: string; before: string; after: string }[] = [];
  const listNames = (arr: { length?: number; item?: (i: number) => { name?: string } | null } | undefined): string => {
    const out: string[] = [];
    try {
      const len = arr && typeof arr.length === "number" ? arr.length : 0;
      for (let i = 0; i < len; i++) {
        const entry = arr && arr.item ? arr.item(i) : undefined;
        if (entry && typeof entry.name === "string") out.push(entry.name);
      }
    } catch {
      /* reading the live list threw: return what we gathered so far */
    }
    return out.join(", ");
  };
  const listTypes = (arr: { length?: number; item?: (i: number) => { type?: string } | null } | undefined): string => {
    const out: string[] = [];
    try {
      const len = arr && typeof arr.length === "number" ? arr.length : 0;
      for (let i = 0; i < len; i++) {
        const entry = arr && arr.item ? arr.item(i) : undefined;
        if (entry && typeof entry.type === "string") out.push(entry.type);
      }
    } catch {
      /* reading the live list threw: return what we gathered so far */
    }
    return out.join(", ");
  };
  const beforePlugins = listNames(navigator.plugins as unknown as { length?: number; item?: (i: number) => { name?: string } | null });
  const beforeMimes = listTypes(navigator.mimeTypes as unknown as { length?: number; item?: (i: number) => { type?: string } | null });
  captures.push({ signal: "navigator.plugins", group: "plugins", before: beforePlugins, after: names.join(", ") });
  captures.push({ signal: "navigator.mimeTypes", group: "plugins", before: beforeMimes, after: mimes.map((m) => m.type).join(", ") });

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

  // Post the before and after pairs to the isolated world relay. A failure here must not disturb
  // the page: capture is a read out for the popup, never a protection.
  try {
    window.postMessage({ type: reportType, captures }, "*");
  } catch {
    /* postMessage unavailable: drop the batch, the override still applied */
  }
}

function inject(): void {
  const code = `(${pageWorldOverride.toString()})(${JSON.stringify(PLUGIN_NAMES)}, ${JSON.stringify(PLUGIN_MIME_TYPES)}, ${JSON.stringify(REPORT_MESSAGE_TYPE)});`;
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
