// Content script, registered at document_start in the page's MAIN world when the extension is
// enabled. Extends fingerprint uniformization INTO Web Workers.
//
// Why this file exists: the sibling overrides (inject.ts, webgl.ts, ...) patch the page's `window`
// globals, but a Worker runs in its OWN global scope with a separate WorkerNavigator and its own
// OffscreenCanvas / WebGL contexts — none of the window patches reach it. A page that spoofs only
// the window therefore leaks the REAL values the moment a script reads them from inside a worker,
// and that window-vs-worker MISMATCH is itself a stable identifier CreepJS specifically probes for.
// Closing it is the single biggest remaining detector gap (ticket #38).
//
// Mechanism (the standard, and only, content-script-reachable approach — see the ticket #38 research
// note): we cannot reach into a worker realm after it exists, so we prepend our overrides to the
// worker SOURCE. The wrapped Worker/SharedWorker constructor builds a tiny bootstrap — the serialized
// override function invoked with the resolved profile, then importScripts()/import() of the site's
// original (absolute) URL — wraps it in a Blob, and hands the real constructor the blob URL. The
// worker thus applies our profile synchronously before a single line of the site's worker code runs.
//
// The override body (applyWorkerOverrides) is deliberately SELF-CONTAINED: it references only its
// argument and worker globals, never this module's scope, because it is serialized with toString()
// and re-parsed in a fresh realm. That forces a small amount of duplication with the window-side
// overrides (the WebGL enums, the blank-canvas readback), which is intrinsic to crossing realms.
//
// Known limitations (documented, not bugs):
//   - A page whose Content-Security-Policy forbids blob/worker sources (e.g. `worker-src 'self'`)
//     rejects the blob-URL worker, so the worker either loads unspoofed or fails — the inherent
//     blob/CSP tradeoff of worker injection. We fail OPEN (fall back to the untouched constructor)
//     for anything we can catch synchronously, so we never break a worker we can avoid breaking.
//   - Service workers are NOT covered here: their script URL must be a same-origin http(s) resource,
//     so a blob bootstrap is rejected by the browser. Covering them needs a background webRequest
//     response rewrite (deferred) — see the PR notes.
//   - A wrapped SharedWorker is keyed by its per-document blob URL, so cross-document sharing of the
//     same SharedWorker no longer coalesces to one instance (intra-document reuse is preserved via
//     the blob cache below).

import { resolveProfileFromPage, type CommonProfile } from "./profiles";

/**
 * Applied INSIDE a worker's global scope. Serialized with toString() into the bootstrap blob, so it
 * must rely ONLY on its argument and standard worker globals — never on this module's imports or
 * scope. Mirrors the window-side overrides for the signals a worker actually exposes:
 *   - WorkerNavigator (userAgent, appVersion, platform, language, languages, hardwareConcurrency).
 *     No oscpu / plugins / mimeTypes / screen in a worker, so those are simply absent, not spoofed.
 *   - timezone: Intl.DateTimeFormat().resolvedOptions().timeZone and Date.getTimezoneOffset(), which
 *     do exist in a worker and must agree with the window.
 *   - OffscreenCanvas readback (convertToBlob, 2D getImageData), the worker canvas surface.
 *   - WebGL vendor/renderer masking on OffscreenCanvas-backed contexts.
 * Web Audio has no worker surface (AudioContext is window-only), so there is nothing to do there.
 */
function applyWorkerOverrides(p: CommonProfile): void {
  const scope = self as unknown as {
    __poisonWorkerDone?: boolean;
    navigator: Record<string, unknown>;
    OffscreenCanvas?: (new (w: number, h: number) => { width: number; height: number }) & {
      prototype: { convertToBlob?: (...args: unknown[]) => Promise<Blob> };
    };
    OffscreenCanvasRenderingContext2D?: { prototype: { getImageData?: (x: number, y: number, w: number, h: number) => ImageData } };
    WebGLRenderingContext?: { prototype: { getParameter?: (pname: number) => unknown } };
    WebGL2RenderingContext?: { prototype: { getParameter?: (pname: number) => unknown } };
  };
  // Run at most once per worker realm, so a double bootstrap cannot re-wrap the already-wrapped
  // read paths.
  if (scope.__poisonWorkerDone) return;
  scope.__poisonWorkerDone = true;

  const define = (obj: object, prop: string, value: unknown): void => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true, enumerable: true });
    } catch {
      /* non configurable on this engine: skip rather than throw into the worker */
    }
  };

  // navigator (WorkerNavigator). Same values the window presents, so window == worker.
  try {
    const nav = scope.navigator;
    define(nav, "userAgent", p.ua);
    define(nav, "appVersion", p.ua.replace("Mozilla/", ""));
    define(nav, "platform", p.platform);
    define(nav, "language", p.language);
    define(nav, "languages", Object.freeze([...p.languages]));
    define(nav, "hardwareConcurrency", p.hardwareConcurrency);
  } catch {
    /* WorkerNavigator missing or frozen: leave it untouched */
  }

  // timezone: Intl.resolvedOptions().timeZone and Date.getTimezoneOffset must agree, matching inject.ts.
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
    /* engine rejected the timezone patch: leave it untouched */
  }

  // OffscreenCanvas readback: encode a fresh blank canvas of the same size for convertToBlob, and hand
  // back transparent pixels for the 2D getImageData path — identical neutralization to inject.ts.
  try {
    const OffscreenCtor = scope.OffscreenCanvas;
    if (OffscreenCtor && typeof OffscreenCtor.prototype.convertToBlob === "function") {
      const origConvertToBlob = OffscreenCtor.prototype.convertToBlob;
      OffscreenCtor.prototype.convertToBlob = function convertToBlob(this: { width: number; height: number }, ...args: unknown[]): Promise<Blob> {
        const blank = new OffscreenCtor(Math.max(1, this.width | 0), Math.max(1, this.height | 0));
        return origConvertToBlob.apply(blank, args);
      };
    }
    const offCtxProto = scope.OffscreenCanvasRenderingContext2D?.prototype;
    if (offCtxProto && typeof offCtxProto.getImageData === "function") {
      offCtxProto.getImageData = function getImageData(_x, _y, w, h) {
        return new ImageData(Math.max(1, w | 0), Math.max(1, h | 0));
      };
    }
  } catch {
    /* no OffscreenCanvas in this worker: nothing to neutralize */
  }

  // WebGL vendor/renderer masking, identical to webgl.ts: masked core VENDOR/RENDERER return Firefox's
  // constant "Mozilla", the debug-renderer UNMASKED_* pair returns the per-family common GPU identity.
  try {
    const VENDOR = 0x1f00;
    const RENDERER = 0x1f01;
    const UNMASKED_VENDOR_WEBGL = 0x9245;
    const UNMASKED_RENDERER_WEBGL = 0x9246;
    const masked = "Mozilla";
    const unmaskedVendor = p.webgl.unmaskedVendor;
    const unmaskedRenderer = p.webgl.unmaskedRenderer;
    const patch = (proto: { getParameter?: (pname: number) => unknown } | undefined): void => {
      if (!proto || typeof proto.getParameter !== "function") return;
      const original = proto.getParameter;
      proto.getParameter = function getParameter(this: unknown, parameter: number): unknown {
        if (parameter === VENDOR || parameter === RENDERER) return masked;
        if (parameter === UNMASKED_VENDOR_WEBGL) return unmaskedVendor;
        if (parameter === UNMASKED_RENDERER_WEBGL) return unmaskedRenderer;
        return original.call(this, parameter);
      };
    };
    if (scope.WebGLRenderingContext) patch(scope.WebGLRenderingContext.prototype);
    if (scope.WebGL2RenderingContext) patch(scope.WebGL2RenderingContext.prototype);
  } catch {
    /* no WebGL in this worker: nothing to mask */
  }
}

// This file IS the page's MAIN world, so wrap the constructors directly. Resolve the same profile the
// window overrides use: the background injects window.__poisonOsFamily before these scripts, so both
// layers present the same family (falling back to the real navigator if that global is absent).
installWorkerHooks(resolveProfileFromPage(window));

function installWorkerHooks(profile: CommonProfile): void {
  // Run at most once per document, so a second injection cannot double-wrap the constructors.
  const guard = window as unknown as { __poisonWorkersDone?: boolean };
  if (guard.__poisonWorkersDone) return;
  guard.__poisonWorkersDone = true;

  // The bootstrap prefix: the serialized override, invoked with the frozen-in profile. Built once.
  const overrideSource = `(${applyWorkerOverrides.toString()})(${JSON.stringify(profile)});`;

  // Blob URLs are cached by (module/classic, name, absolute URL) so repeated constructions with the
  // same arguments reuse one URL — this both avoids blob churn and preserves a SharedWorker's
  // intra-document identity (a SharedWorker is keyed by URL + name, so a stable URL keeps same-page
  // constructions coalescing to one instance).
  const blobCache = new Map<string, string>();

  const bootstrapURL = (scriptURL: string | URL, options: unknown): string => {
    const absolute = new URL(String(scriptURL), location.href).href;
    const opts = options && typeof options === "object" ? (options as { type?: string; name?: string }) : {};
    // SharedWorker's second argument may be a plain string name instead of an options bag.
    const name = typeof options === "string" ? options : typeof opts.name === "string" ? opts.name : "";
    const isModule = opts.type === "module";
    const key = `${isModule ? "m" : "c"} ${name} ${absolute}`;
    const cached = blobCache.get(key);
    if (cached) return cached;
    // Pull the site's original script in AFTER our synchronous overrides, from its real absolute URL
    // so its own relative imports/importScripts still resolve. A classic worker uses the synchronous
    // importScripts(), so the original (including any onmessage it installs) runs to completion before
    // the worker's event loop starts. A module worker cannot importScripts, so it uses top-level
    // `await import()`: the await keeps the bootstrap module evaluating — and the worker's message
    // queue therefore paused — until the original module has evaluated and wired up its handlers, so a
    // message the page posts right after `new Worker(...)` is not dropped on the floor.
    const load = isModule ? `await import(${JSON.stringify(absolute)});` : `importScripts(${JSON.stringify(absolute)});`;
    const blobURL = URL.createObjectURL(new Blob([`${overrideSource}\n${load}`], { type: "text/javascript" }));
    blobCache.set(key, blobURL);
    return blobURL;
  };

  // Wrap a worker constructor via a Proxy so the exotic parts of the original (its .prototype, .name,
  // instanceof, and subclassing through `class X extends Worker`) are preserved untouched — only the
  // scriptURL argument is swapped for the bootstrap blob. Any failure building the blob falls back to
  // the untouched construction so we never break a worker the site depends on.
  const wrap = <T extends abstract new (...args: never[]) => object>(Ctor: T): T =>
    new Proxy(Ctor, {
      construct(target, argArray, newTarget): object {
        try {
          const [scriptURL, options] = argArray as [string | URL, unknown];
          const url = bootstrapURL(scriptURL, options);
          return Reflect.construct(target, [url, options] as never[], newTarget);
        } catch {
          return Reflect.construct(target, argArray as never[], newTarget);
        }
      },
    });

  const g = window as unknown as {
    Worker?: abstract new (...args: never[]) => object;
    SharedWorker?: abstract new (...args: never[]) => object;
  };
  if (typeof g.Worker === "function") g.Worker = wrap(g.Worker);
  if (typeof g.SharedWorker === "function") g.SharedWorker = wrap(g.SharedWorker);
}

// Module scope (no runtime export): keeps applyWorkerOverrides / installWorkerHooks file local so
// they do not collide with the sibling fingerprint content scripts in tsc's global script scope.
export {};
