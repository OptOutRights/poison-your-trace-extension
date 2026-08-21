// Content script, registered dynamically at document_start in the page's MAIN world when the
// extension is enabled.
//
// Uniformizes navigator.plugins and navigator.mimeTypes toward a FIXED, widely shared Firefox 140
// configuration. Like inject.ts it runs in the page's MAIN world so the override applies directly
// to the page's own globals and is visible to the site's scripts, and — because the browser injects
// the script rather than the DOM — it survives a strict page Content Security Policy.
//
// Why a constant list carries zero bits: modern Firefox and Chromium expose the SAME standardized
// set of five built in PDF "plugins" (real NPAPI plugins are gone). Presenting exactly that set,
// the crowd's default, means the plugin vector distinguishes no one. Randomizing would instead mint
// a per visit identifier, so we uniformize.

import { REPORT_MESSAGE_TYPE } from "./report";

/**
 * The five standardized PDF plugin names modern Firefox 140 and Chromium report, in canonical
 * order.
 */
const PLUGIN_NAMES: readonly string[] = [
  "PDF Viewer",
  "Chrome PDF Viewer",
  "Chromium PDF Viewer",
  "Microsoft Edge PDF Viewer",
  "WebKit built-in PDF",
];

/** The two MIME types every one of the five PDF plugins advertises (matches real Firefox 140). */
const PLUGIN_MIME_TYPES: readonly { type: string; suffixes: string; description: string }[] = [
  { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
  { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" },
];

/**
 * Runs in the page's MAIN world, reading and replacing the page's own globals, so it must rely only
 * on its arguments and standard page globals, never on extension APIs. The report tag is passed in
 * so it can post its before and after captures to the isolated-world relay.
 */
function pageWorldOverride(
  names: readonly string[],
  mimes: readonly { type: string; suffixes: string; description: string }[],
  reportType: string,
): void {
  // Run at most once per document. A second injection into the same page would read our already
  // overridden navigator.plugins and navigator.mimeTypes as its "before", collapsing the popup's
  // before and after to the same text, so the guard keeps the override idempotent.
  const guard = window as unknown as { __poisonPluginsDone?: boolean };
  if (guard.__poisonPluginsDone) return;
  guard.__poisonPluginsDone = true;

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

// This file IS the page's MAIN world (world: "MAIN" content script), so apply the override
// directly. The constants are bundled in by esbuild; no toString() serialization round trip.
pageWorldOverride(PLUGIN_NAMES, PLUGIN_MIME_TYPES, REPORT_MESSAGE_TYPE);

// Module scope (no runtime export): keeps pageWorldOverride file local so it does not collide with
// the sibling fingerprint content scripts in tsc's global script scope.
export {};
