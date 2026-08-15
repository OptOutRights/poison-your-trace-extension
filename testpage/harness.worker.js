// Worker-context probes for the Poison your Trace fingerprint regression harness.
//
// A DedicatedWorker has its OWN WorkerNavigator and its own OffscreenCanvas / WebGL, none of which
// the v1 page-world <script> override reaches (the override runs in the document, not in workers).
// Reading the same signals here and comparing them to the window context is how the harness proves
// or disproves "worker == window" parity, the epic's key pass target (see issue #34 / #38).
//
// Plain classic worker script: no build step, loaded with `new Worker("harness.worker.js")`.

"use strict";

// FNV-1a: turn a canvas/audio byte readback into one short comparable string. Display convenience,
// not a security primitive. Identical input bytes give an identical hash.
function hash(bytes) {
  var h = 0x811c9dc5;
  for (var i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = (h * 0x01000193) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

function safe(fn) {
  try {
    return fn();
  } catch (err) {
    return "unavailable (" + (err && err.message ? err.message : String(err)) + ")";
  }
}

// Hash an OffscreenCanvas 2D readback. Uniformized this would match the window canvas; on the v1
// build the worker is untouched, so it returns the machine's REAL canvas hash.
function canvasHash() {
  return safe(function () {
    if (typeof OffscreenCanvas === "undefined") return "no-offscreencanvas";
    var canvas = new OffscreenCanvas(220, 30);
    var ctx = canvas.getContext("2d");
    if (!ctx) return "no-2d-context";
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 110, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("PoisonYourTrace ✨", 2, 2);
    var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return hash(data);
  });
}

function webgl() {
  return safe(function () {
    if (typeof OffscreenCanvas === "undefined") return { vendor: "no-offscreencanvas" };
    var canvas = new OffscreenCanvas(64, 64);
    var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return { vendor: "no-webgl" };
    var ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : "no-debug-ext",
      unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "no-debug-ext",
    };
  });
}

self.onmessage = function () {
  var gl = webgl();
  var result = {
    "navigator.userAgent": safe(function () { return navigator.userAgent; }),
    "navigator.platform": safe(function () { return navigator.platform; }),
    "navigator.language": safe(function () { return navigator.language; }),
    "navigator.languages": safe(function () { return (navigator.languages || []).join(", "); }),
    "navigator.hardwareConcurrency": safe(function () { return String(navigator.hardwareConcurrency); }),
    "timezone": safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }),
    "timezoneOffset": safe(function () { return String(new Date().getTimezoneOffset()); }),
    "canvas.readback": canvasHash(),
    "webgl.vendor": String(gl.vendor),
    "webgl.renderer": String(gl.renderer),
    "webgl.unmaskedVendor": String(gl.unmaskedVendor),
    "webgl.unmaskedRenderer": String(gl.unmaskedRenderer),
  };
  self.postMessage(result);
};
