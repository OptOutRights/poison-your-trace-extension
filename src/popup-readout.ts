// Popup readout content script: the "what this site sees" probe. It is injected on demand by the
// popup via browser.tabs.executeScript, reads the values a site would actually observe AFTER Firefox's
// Resist Fingerprinting has already reshaped them, and stashes them on a page global the popup reads
// back. There is no before/after here — RFP does the hiding, so we only surface the "after" the popup
// shows as the current truth. This replaces the old capture/relay recap: nothing is stored in the
// background, nothing is messaged.
//
// Why a global rather than a return value: esbuild bundles each entry as an IIFE, so a trailing bare
// expression is NOT what executeScript resolves to. Instead we write the reading onto
// window.__poisonSiteView, and the popup issues a second, tiny executeScript({ code: "..." }) to read
// that global back. The probe file itself stays a normal bundled module.

// The shape the popup consumes. Exported so the popup imports the exact type (bundlers erase the
// import at build time; the value never crosses — only the type does).
export interface SiteView {
  userAgent: string;
  screenWidth: number;
  screenHeight: number;
  timeZone: string;
  hardwareConcurrency: number;
  devicePixelRatio: number;
  /** A short hash of a canvas readback: identical across sites under RFP, a per-device value without it. */
  canvasHash: string;
}

// The page global the probe writes and the popup reads back. Declared on Window so this file and the
// read-back snippet share one name.
declare global {
  interface Window {
    __poisonSiteView?: SiteView;
  }
}

// A tiny, dependency-free hash (FNV-1a, 32-bit) over the canvas' pixel bytes. We only need a stable
// short fingerprint of the readback to show the user, not cryptographic strength — under RFP this comes
// out constant, which is the whole point being demonstrated.
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    // Multiply by the FNV prime (16777619) via shifts, kept in 32-bit unsigned integer math.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Draw a small canvas the way a fingerprinter would and hash the pixels back. Wrapped so a page that
// blocks canvas (or has no 2D context) yields a readable sentinel instead of throwing.
function canvasReadbackHash(): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 40;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "unavailable";
    // The classic fingerprint payload: mixed text, emoji, and shapes exercise the font/AA stack.
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 100, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("Poison your Trace \u{1F489}", 2, 2);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.fillText("Poison your Trace \u{1F489}", 4, 8);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return fnv1a(new Uint8Array(data.buffer));
  } catch {
    return "blocked";
  }
}

// Read the site view and stash it where the popup's read-back snippet will find it. Each read is
// trivial and cannot throw except the canvas, which is already guarded above.
window.__poisonSiteView = {
  userAgent: navigator.userAgent,
  screenWidth: screen.width,
  screenHeight: screen.height,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  hardwareConcurrency: navigator.hardwareConcurrency,
  devicePixelRatio: window.devicePixelRatio,
  canvasHash: canvasReadbackHash(),
};
