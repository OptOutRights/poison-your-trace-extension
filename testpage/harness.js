// Window-context probes + verdict for the Poison your Trace fingerprint regression harness.
//
// Two jobs:
//   1. Human: open http://localhost:<port>/harness.html (served by scripts/fingerprint-harness.mjs,
//      or any static server) with the extension ON and OFF and read the rendered table.
//   2. Machine: it spawns harness.worker.js, diffs worker-vs-window, runs internal contradiction
//      checks, then exposes a JSON verdict on `window.__HARNESS_RESULT__` and flips
//      `document.body.dataset.harnessReady = "true"`. The Selenium driver waits on that flag and
//      reads the verdict, so the same page is both the eyeball view and the automated probe.
//
// Plain classic script, no build step, loaded by harness.html. It must be served over http(s):
// the extension only injects on http/https origins (background.ts matches http://*/* + https://*/*),
// so a file:// load would silently measure the UNPROTECTED page and look like the extension is off.

(function () {
  "use strict";

  // The uniformized User-Agent the extension presents (mirror of COMMON_PROFILE.ua in
  // src/fingerprint/profile.ts). Used only to guess whether the extension is currently active so the
  // page can label itself; the driver decides ON/OFF authoritatively by whether it installed the addon.
  var EXPECTED_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

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

  function canvasHash() {
    return safe(function () {
      var canvas = document.createElement("canvas");
      canvas.width = 220;
      canvas.height = 30;
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
      var canvas = document.createElement("canvas");
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

  // AudioContext metadata (sample rate + hardware output latency-ish params) is a low-entropy but
  // real surface. We report the synchronously-available metadata rather than a rendered buffer hash,
  // because a true audio readback needs an async render this synchronous collector cannot await.
  function audioMeta() {
    return safe(function () {
      var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Ctx) return "no-offlineaudiocontext";
      var ctx = new Ctx(1, 4096, 44100);
      return "sampleRate:" + ctx.sampleRate + " maxChannels:" + ctx.destination.maxChannelCount;
    });
  }

  function collectWindow() {
    var gl = webgl();
    return {
      "navigator.userAgent": safe(function () { return navigator.userAgent; }),
      "navigator.platform": safe(function () { return navigator.platform; }),
      "navigator.oscpu": safe(function () { return navigator.oscpu || "(empty)"; }),
      "navigator.language": safe(function () { return navigator.language; }),
      "navigator.languages": safe(function () { return (navigator.languages || []).join(", "); }),
      "navigator.hardwareConcurrency": safe(function () { return String(navigator.hardwareConcurrency); }),
      "navigator.maxTouchPoints": safe(function () { return String(navigator.maxTouchPoints); }),
      "navigator.plugins": safe(function () {
        return Array.prototype.map.call(navigator.plugins, function (p) { return p.name; }).join(", ") || "(none)";
      }),
      "screen.size": safe(function () { return screen.width + "x" + screen.height; }),
      "screen.avail": safe(function () { return screen.availWidth + "x" + screen.availHeight; }),
      "screen.colorDepth": safe(function () { return String(screen.colorDepth); }),
      "devicePixelRatio": safe(function () { return String(window.devicePixelRatio); }),
      "timezone": safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }),
      "timezoneOffset": safe(function () { return String(new Date().getTimezoneOffset()); }),
      "canvas.readback": canvasHash(),
      "audio.meta": audioMeta(),
      "webgl.vendor": String(gl.vendor),
      "webgl.renderer": String(gl.renderer),
      "webgl.unmaskedVendor": String(gl.unmaskedVendor),
      "webgl.unmaskedRenderer": String(gl.unmaskedRenderer),
    };
  }

  // Map any of userAgent / platform / oscpu / WebGL renderer to a coarse OS family, so we can spot a
  // signal that disagrees with the others. "unknown" means "don't judge this pair".
  function osFromUA(ua) {
    if (/Windows/i.test(ua)) return "Windows";
    if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
    if (/Android/i.test(ua)) return "Android";
    if (/Linux|X11/i.test(ua)) return "Linux";
    return "unknown";
  }
  function osFromPlatform(p) {
    if (/Win/i.test(p)) return "Windows";
    if (/Mac/i.test(p)) return "macOS";
    if (/Linux|X11/i.test(p)) return "Linux";
    if (/Android/i.test(p)) return "Android";
    return "unknown";
  }
  function osFromRenderer(r) {
    if (/Apple|Metal/i.test(r)) return "macOS";
    if (/Direct3D|D3D|ANGLE.*Windows/i.test(r)) return "Windows";
    if (/Mesa|llvmpipe|Gallium|Intel Open Source/i.test(r)) return "Linux";
    return "unknown";
  }

  // Cross-signal contradiction checks: the local stand-in for "pixelscan: no contradictions". Each
  // returns null when consistent (or undecidable), or a description string when two known signals
  // disagree.
  function contradictions(win) {
    var found = [];
    var uaOs = osFromUA(win["navigator.userAgent"]);
    var platOs = osFromPlatform(win["navigator.platform"]);
    var rendOs = osFromRenderer(win["webgl.unmaskedRenderer"]);
    function pair(label, a, aVal, b, bVal) {
      if (a !== "unknown" && b !== "unknown" && a !== b) {
        found.push(label + ": UA=>" + a + " (" + aVal + ") vs " + bVal + "=>" + b);
      }
    }
    pair("ua-vs-platform", uaOs, win["navigator.userAgent"], platOs, win["navigator.platform"]);
    pair("ua-vs-webglRenderer", uaOs, win["navigator.userAgent"], rendOs, win["webgl.unmaskedRenderer"]);
    // oscpu should agree with the UA OS when present and non-empty.
    var oscpu = win["navigator.oscpu"];
    if (oscpu && oscpu !== "(empty)") {
      var oscpuOs = osFromPlatform(oscpu);
      pair("ua-vs-oscpu", uaOs, win["navigator.userAgent"], oscpuOs, oscpu);
    }
    return found;
  }

  // For every signal the worker also reports, does it match the window? A mismatch means the worker
  // leaks a different value than the page shows (the v1 gap the harness records).
  function parity(win, worker) {
    var shared = Object.keys(worker);
    var mismatches = [];
    for (var i = 0; i < shared.length; i++) {
      var key = shared[i];
      if (Object.prototype.hasOwnProperty.call(win, key) && String(win[key]) !== String(worker[key])) {
        mismatches.push({ signal: key, window: String(win[key]), worker: String(worker[key]) });
      }
    }
    return { checked: shared.length, mismatches: mismatches };
  }

  function render(verdict) {
    var root = document.getElementById("out");
    if (!root) return;
    var win = verdict.window;
    var worker = verdict.worker;
    var html = "";
    var active = verdict.extensionActive ? "likely ON" : "likely OFF";
    html += '<p class="status">Extension: <strong>' + active + "</strong> &middot; " +
      "worker parity mismatches: <strong>" + verdict.parity.mismatches.length + "</strong> &middot; " +
      "contradictions: <strong>" + verdict.contradictions.length + "</strong></p>";

    html += "<table><caption>Signals (window vs worker)</caption><thead><tr>" +
      "<th>Signal</th><th>Window</th><th>Worker</th></tr></thead><tbody>";
    var keys = Object.keys(win);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var w = Object.prototype.hasOwnProperty.call(worker, k) ? worker[k] : "—";
      var mismatch = Object.prototype.hasOwnProperty.call(worker, k) && String(win[k]) !== String(w);
      html += "<tr" + (mismatch ? ' class="bad"' : "") + "><td>" + k + "</td><td>" +
        escapeHtml(String(win[k])) + "</td><td>" + escapeHtml(String(w)) + "</td></tr>";
    }
    html += "</tbody></table>";

    if (verdict.contradictions.length) {
      html += "<h2>Contradictions</h2><ul>";
      for (var c = 0; c < verdict.contradictions.length; c++) {
        html += '<li class="bad">' + escapeHtml(verdict.contradictions[c]) + "</li>";
      }
      html += "</ul>";
    }
    root.innerHTML = html;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  function finish(worker) {
    var win = collectWindow();
    var verdict = {
      window: win,
      worker: worker,
      extensionActive: win["navigator.userAgent"] === EXPECTED_UA,
      parity: parity(win, worker),
      contradictions: contradictions(win),
    };
    window.__HARNESS_RESULT__ = verdict;
    render(verdict);
    document.body.dataset.harnessReady = "true";
  }

  function run() {
    var done = false;
    var complete = function (workerResult) {
      if (done) return;
      done = true;
      finish(workerResult);
    };
    try {
      var worker = new Worker("harness.worker.js");
      worker.onmessage = function (ev) { complete(ev.data); };
      worker.onerror = function (err) {
        complete({ error: "worker error: " + (err && err.message ? err.message : String(err)) });
      };
      worker.postMessage("go");
      // Safety net: never hang the harness if the worker stays silent.
      setTimeout(function () { complete({ error: "worker timeout" }); }, 8000);
    } catch (err) {
      complete({ error: "worker unavailable: " + (err && err.message ? err.message : String(err)) });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
