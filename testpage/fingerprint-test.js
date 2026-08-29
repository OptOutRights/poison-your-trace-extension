// Self verifying fingerprint reader for the Poison your Trace test pages.
//
// It probes every signal in scope, compares each against the expected shared common profile, and
// colours each row green (uniformized = protected) or red (your real device is leaking through).
// It also probes whether this page's CSP blocks inline <script> injection (the mechanism the old
// build relied on) and prints a plain language verdict at the top. No build step: a plain classic
// script loaded by fingerprint.html and fingerprint-csp.html.

(function () {
  "use strict";

  // Expected uniformized values. This mirrors the extension source (src/fingerprint/profile.ts,
  // webgl.ts, plugins.ts); those files are the source of truth, this copy is kept in sync by hand
  // because the test page has no build step and cannot import them.
  var EXPECTED = {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
    appVersion: "5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
    platform: "Win32",
    language: "en-US",
    languages: "en-US, en",
    hardwareConcurrency: "8",
    oscpu: "Windows NT 10.0; Win64; x64",
    screenWidth: "1920",
    screenHeight: "1080",
    availWidth: "1920",
    availHeight: "1040",
    colorDepth: "24",
    devicePixelRatio: "1",
    timezone: "UTC",
    offset: "0",
    webglUnmaskedVendor: "Google Inc. (Intel)",
    webglUnmaskedRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    plugins: "PDF Viewer, Chrome PDF Viewer, Chromium PDF Viewer, Microsoft Edge PDF Viewer, WebKit built-in PDF",
    mimeTypes: "application/pdf, text/pdf",
  };

  // Running tally of protected (pass) vs leaking (fail) signals, filled in by buildTable.
  var TALLY = { pass: 0, fail: 0 };

  // true when actual stringifies to the expected uniformized value.
  function is(actual, expected) {
    return String(actual) === String(expected);
  }

  function safe(fn) {
    try {
      return fn();
    } catch (err) {
      return "unavailable (" + (err && err.message ? err.message : String(err)) + ")";
    }
  }

  // A tiny stable hash so a canvas or audio readback becomes one short comparable string. It is a
  // display convenience, not a security primitive. Identical input bytes give an identical hash, so
  // a uniformized readback shows the same hash on every machine.
  function hash(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h * 0x01000193) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
  }

  // Draw a small mixed scene, then hash the PNG bytes for display. Separately, read the pixels back
  // with getImageData: when the extension neutralizes canvas, the readback is fully transparent
  // (all zero) despite what we drew, so `neutralized` is the reliable pass/fail signal.
  function canvasProbe() {
    return safe(function () {
      var canvas = document.createElement("canvas");
      canvas.width = 220;
      canvas.height = 40;
      var ctx = canvas.getContext("2d");
      ctx.textBaseline = "top";
      ctx.font = "16px system-ui";
      ctx.fillStyle = "#f60";
      ctx.fillRect(2, 2, 120, 22);
      ctx.fillStyle = "#069";
      ctx.fillText("Poison your Trace \u{1F489}", 4, 4);

      var pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      var neutralized = true;
      for (var p = 0; p < pixels.length; p++) {
        if (pixels[p] !== 0) {
          neutralized = false;
          break;
        }
      }

      var url = canvas.toDataURL();
      var comma = url.indexOf(",");
      var b64 = comma >= 0 ? url.slice(comma + 1) : url;
      var raw = atob(b64);
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return { text: hash(bytes) + " (" + bytes.length + " bytes)", ok: neutralized };
    });
  }

  function webgl() {
    return safe(function () {
      var canvas = document.createElement("canvas");
      var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (!gl) return { vendor: "no WebGL", renderer: "no WebGL", unmaskedVendor: "", unmaskedRenderer: "" };
      var out = {
        vendor: String(gl.getParameter(gl.VENDOR)),
        renderer: String(gl.getParameter(gl.RENDERER)),
        unmaskedVendor: "",
        unmaskedRenderer: "",
      };
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        out.unmaskedVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
        out.unmaskedRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      }
      return out;
    });
  }

  // Render a short oscillator through a compressor offline, then hash a slice of the PCM. Uniformized
  // the samples are a fixed constant (silence) so the sum of absolute samples is exactly 0 on every
  // machine; real, it encodes the device audio stack. The zero sum is the reliable pass/fail signal.
  function audioProbe() {
    return new Promise(function (resolve) {
      try {
        var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Ctx) return resolve({ text: "no OfflineAudioContext", ok: null });
        var ctx = new Ctx(1, 44100, 44100);
        var osc = ctx.createOscillator();
        var comp = ctx.createDynamicsCompressor();
        osc.type = "triangle";
        osc.frequency.value = 10000;
        osc.connect(comp);
        comp.connect(ctx.destination);
        osc.start(0);
        ctx.startRendering().then(function (buffer) {
          var data = buffer.getChannelData(0);
          var sum = 0;
          for (var i = 0; i < data.length; i++) sum += Math.abs(data[i]);
          var bytes = new Uint8Array(new Float32Array(data.slice(0, 512)).buffer);
          resolve({ text: hash(bytes) + " (sum of abs samples " + sum.toFixed(6) + ")", ok: sum === 0 });
        }, function () {
          resolve({ text: "rendering failed", ok: null });
        });
      } catch (err) {
        resolve({ text: "unavailable (" + (err && err.message ? err.message : String(err)) + ")", ok: null });
      }
    });
  }

  // Source for a dedicated worker that reads the same signals from INSIDE a worker realm and posts
  // them back. A worker has its own WorkerNavigator and OffscreenCanvas, so without the extension's
  // worker injection these return the real device values while the window shows the common profile —
  // the window-vs-worker mismatch CreepJS flags. With the extension on and issue #38 applied, the
  // worker reports the SAME common profile as the window. Runs immediately on startup and postMessages
  // one result object. Kept as a string so the page can spawn it from a Blob with no build step.
  var WORKER_SOURCE = [
    "(function(){",
    "  var out = {};",
    "  function read(k, fn){ try { out[k] = String(fn()); } catch (e) { out[k] = 'err'; } }",
    "  read('userAgent', function(){ return navigator.userAgent; });",
    "  read('appVersion', function(){ return navigator.appVersion; });",
    "  read('platform', function(){ return navigator.platform; });",
    "  read('language', function(){ return navigator.language; });",
    "  read('languages', function(){ return (navigator.languages || []).join(', '); });",
    "  read('hardwareConcurrency', function(){ return navigator.hardwareConcurrency; });",
    "  read('timezone', function(){ return new Intl.DateTimeFormat().resolvedOptions().timeZone; });",
    "  read('offset', function(){ return new Date().getTimezoneOffset(); });",
    "  try {",
    "    if (typeof OffscreenCanvas !== 'undefined') {",
    "      var c = new OffscreenCanvas(220, 40);",
    "      var ctx = c.getContext('2d');",
    "      ctx.fillStyle = '#f60'; ctx.fillRect(2, 2, 120, 22);",
    "      ctx.fillStyle = '#069'; ctx.fillText('Poison \\u{1F489}', 4, 4);",
    "      var px = ctx.getImageData(0, 0, c.width, c.height).data;",
    "      var neutral = true;",
    "      for (var i = 0; i < px.length; i++) { if (px[i] !== 0) { neutral = false; break; } }",
    "      out.canvasNeutralized = neutral;",
    "      var gc = new OffscreenCanvas(1, 1);",
    "      var gl = gc.getContext('webgl');",
    "      if (gl) {",
    "        var dbg = gl.getExtension('WEBGL_debug_renderer_info');",
    "        if (dbg) {",
    "          out.webglUnmaskedVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));",
    "          out.webglUnmaskedRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));",
    "        }",
    "      }",
    "    }",
    "  } catch (e) { /* no OffscreenCanvas in this worker */ }",
    "  self.postMessage(out);",
    "})();",
  ].join("\n");

  // Spawn the worker from a Blob and resolve with its posted signals, or with { unavailable } if the
  // worker cannot run — under a strict CSP (default-src/worker-src without blob:) the browser blocks
  // blob workers entirely, so this degrades to an info row rather than a false failure.
  function workerProbe() {
    return new Promise(function (resolve) {
      var w = null;
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        try {
          if (w) w.terminate();
        } catch (e) {
          /* already gone */
        }
        resolve(v);
      }
      try {
        var url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
        w = new Worker(url);
        w.onmessage = function (ev) {
          finish(ev.data);
        };
        w.onerror = function (ev) {
          finish({ unavailable: (ev && ev.message) || "worker blocked (likely CSP)" });
        };
        setTimeout(function () {
          finish({ unavailable: "worker timed out (blocked or unsupported)" });
        }, 2000);
      } catch (e) {
        finish({ unavailable: "cannot create worker (" + (e && e.message ? e.message : String(e)) + ")" });
      }
    });
  }

  function pluginNames() {
    return safe(function () {
      var names = [];
      for (var i = 0; i < navigator.plugins.length; i++) names.push(navigator.plugins[i].name);
      return names.length ? names.join(", ") : "(none)";
    });
  }

  function mimeTypeList() {
    return safe(function () {
      var types = [];
      for (var i = 0; i < navigator.mimeTypes.length; i++) types.push(navigator.mimeTypes[i].type);
      return types.length ? types.join(", ") : "(none)";
    });
  }

  // Reproduce exactly what the OLD extension did: append an inline <script> to the document. Under a
  // header delivered strict CSP (script-src without 'unsafe-inline') the browser refuses to run it,
  // so the flag stays false. This is the very mechanism the world:"MAIN" migration replaced, so it
  // tells us whether this page is a genuine strict-CSP environment.
  function inlineScriptsBlocked() {
    try {
      var flag = "__poisonCspProbe";
      window[flag] = false;
      var s = document.createElement("script");
      s.textContent = "window['" + flag + "']=true;";
      (document.documentElement || document.head || document.body).appendChild(s);
      s.remove();
      var ran = window[flag] === true;
      try {
        delete window[flag];
      } catch (e) {
        /* non configurable on some engines; leave it */
      }
      return !ran;
    } catch (e) {
      return true;
    }
  }

  // rows are [label, value, ok] where ok is true (protected), false (leaking), or null (info only,
  // not counted toward the verdict).
  function buildTable(caption, rows) {
    var table = document.createElement("table");
    var cap = document.createElement("caption");
    cap.textContent = caption;
    table.appendChild(cap);
    rows.forEach(function (row) {
      var ok = row[2];
      var tr = document.createElement("tr");
      if (ok === true) {
        tr.className = "pass";
        TALLY.pass++;
      } else if (ok === false) {
        tr.className = "fail";
        TALLY.fail++;
      }
      var th = document.createElement("th");
      th.textContent = row[0];
      var td = document.createElement("td");
      td.className = "value";
      td.textContent = String(row[1]);
      var st = document.createElement("td");
      st.className = "status";
      st.textContent = ok === true ? "✓" : ok === false ? "✗" : "";
      tr.appendChild(th);
      tr.appendChild(td);
      tr.appendChild(st);
      table.appendChild(tr);
    });
    return table;
  }

  function renderConclusion(container, cspBlocked) {
    var total = TALLY.pass + TALLY.fail;
    var allPass = TALLY.fail === 0 && total > 0;
    var banner = document.createElement("div");
    banner.id = "conclusion";
    var lines = [];

    if (cspBlocked) {
      lines.push("🔒 This page enforces a strict Content Security Policy: inline <script> injection is BLOCKED here (verified live).");
      if (allPass) {
        banner.className = "pass";
        lines.push("✅ PASS — all " + total + " fingerprint signals still show the shared common profile.");
        lines.push("The extension applies its overrides even though the page CSP blocks inline scripts. This is exactly what issue #36 set out to prove: the world:\"MAIN\" content script is CSP-proof, unlike the old inline injection.");
      } else {
        banner.className = "fail";
        lines.push("❌ FAIL — " + TALLY.fail + " of " + total + " signals still expose your real device.");
        lines.push("The page CSP blocks inline scripts and the overrides are absent — the old inline-injection behaviour. Check that the extension is enabled and running this branch.");
      }
    } else {
      banner.className = allPass ? "pass" : "info";
      lines.push("ℹ️ This page is NOT enforcing a strict CSP (inline scripts run here), so it does not exercise the CSP-proofing. Serve it with a CSP header via `npm run testpage:csp` for the real test.");
      if (allPass) {
        lines.push("✅ All " + total + " signals show the common profile — the extension is active.");
      } else {
        lines.push("⚠️ " + TALLY.fail + " of " + total + " signals expose your real device — the extension is off or not applied here.");
      }
    }

    lines.forEach(function (text, i) {
      var p = document.createElement("p");
      p.textContent = text;
      if (i > 0) p.style.marginTop = "0.4rem";
      p.style.margin = i === 0 ? "0" : "0.4rem 0 0";
      banner.appendChild(p);
    });
    container.insertBefore(banner, container.firstChild);
  }

  // Build the "workers" table from the dedicated worker's posted signals. Each navigator/timezone row
  // compares against the SAME common profile the window rows use, so green here means worker == window
  // (both uniformized). Canvas readback is pass/fail on whether the worker's OffscreenCanvas came back
  // transparent; the WebGL unmasked strings compare to the common GPU identity. When the worker could
  // not run, a single info row explains why (no false failure).
  function workersTable(worker) {
    if (!worker || worker.unavailable) {
      return buildTable("workers (dedicated)", [
        ["worker status", worker && worker.unavailable ? worker.unavailable : "no result", null],
      ]);
    }
    var canvasOk = worker.canvasNeutralized === true ? true : worker.canvasNeutralized === false ? false : null;
    var hasWebgl = typeof worker.webglUnmaskedRenderer === "string" && worker.webglUnmaskedRenderer.length > 0;
    return buildTable("workers (dedicated)", [
      ["navigator.userAgent", worker.userAgent, is(worker.userAgent, EXPECTED.ua)],
      ["navigator.appVersion", worker.appVersion, is(worker.appVersion, EXPECTED.appVersion)],
      ["navigator.platform", worker.platform, is(worker.platform, EXPECTED.platform)],
      ["navigator.language", worker.language, is(worker.language, EXPECTED.language)],
      ["navigator.languages", worker.languages, is(worker.languages, EXPECTED.languages)],
      ["navigator.hardwareConcurrency", worker.hardwareConcurrency, is(worker.hardwareConcurrency, EXPECTED.hardwareConcurrency)],
      ["Intl timeZone", worker.timezone, is(worker.timezone, EXPECTED.timezone)],
      ["getTimezoneOffset (minutes)", worker.offset, is(worker.offset, EXPECTED.offset)],
      ["OffscreenCanvas readback", canvasOk === true ? "transparent (neutralized)" : canvasOk === false ? "leaking real pixels" : "no OffscreenCanvas", canvasOk],
      ["WebGL unmasked vendor", hasWebgl ? worker.webglUnmaskedVendor : "(not exposed)", hasWebgl ? is(worker.webglUnmaskedVendor, EXPECTED.webglUnmaskedVendor) : null],
      ["WebGL unmasked renderer", hasWebgl ? worker.webglUnmaskedRenderer : "(not exposed)", hasWebgl ? is(worker.webglUnmaskedRenderer, EXPECTED.webglUnmaskedRenderer) : null],
    ]);
  }

  function render(audio, worker) {
    var gl = webgl();
    var canvas = canvasProbe();
    var canvasOk = canvas && typeof canvas === "object" ? canvas.ok : null;
    var canvasText = canvas && typeof canvas === "object" ? canvas.text : String(canvas);
    var container = document.getElementById("report");
    container.textContent = "";
    TALLY.pass = 0;
    TALLY.fail = 0;

    container.appendChild(
      buildTable("navigator", [
        ["userAgent", navigator.userAgent, is(navigator.userAgent, EXPECTED.ua)],
        ["appVersion", navigator.appVersion, is(navigator.appVersion, EXPECTED.appVersion)],
        ["platform", navigator.platform, is(navigator.platform, EXPECTED.platform)],
        ["language", navigator.language, is(navigator.language, EXPECTED.language)],
        ["languages", (navigator.languages || []).join(", "), is((navigator.languages || []).join(", "), EXPECTED.languages)],
        ["hardwareConcurrency", navigator.hardwareConcurrency, is(navigator.hardwareConcurrency, EXPECTED.hardwareConcurrency)],
        ["oscpu", navigator.oscpu || "(not exposed)", is(navigator.oscpu, EXPECTED.oscpu)],
      ]),
    );

    container.appendChild(
      buildTable("screen and window", [
        ["screen.width", screen.width, is(screen.width, EXPECTED.screenWidth)],
        ["screen.height", screen.height, is(screen.height, EXPECTED.screenHeight)],
        ["screen.availWidth", screen.availWidth, is(screen.availWidth, EXPECTED.availWidth)],
        ["screen.availHeight", screen.availHeight, is(screen.availHeight, EXPECTED.availHeight)],
        ["screen.colorDepth", screen.colorDepth, is(screen.colorDepth, EXPECTED.colorDepth)],
        ["screen.pixelDepth", screen.pixelDepth, is(screen.pixelDepth, EXPECTED.colorDepth)],
        ["devicePixelRatio", window.devicePixelRatio, is(window.devicePixelRatio, EXPECTED.devicePixelRatio)],
      ]),
    );

    var tz = safe(function () { return new Intl.DateTimeFormat().resolvedOptions().timeZone; });
    container.appendChild(
      buildTable("timezone", [
        ["Intl timeZone", tz, is(tz, EXPECTED.timezone)],
        ["getTimezoneOffset (minutes)", new Date().getTimezoneOffset(), is(new Date().getTimezoneOffset(), EXPECTED.offset)],
      ]),
    );

    container.appendChild(buildTable("canvas", [["readback hash", canvasText, canvasOk]]));

    container.appendChild(
      buildTable("WebGL", [
        // Masked VENDOR/RENDERER report "Mozilla" on a real Firefox too, so they are info only, not a
        // discriminator. The unmasked ANGLE strings are the ones that single out a machine.
        ["vendor (masked)", gl.vendor, null],
        ["renderer (masked)", gl.renderer, null],
        ["unmasked vendor", gl.unmaskedVendor || "(not exposed)", is(gl.unmaskedVendor, EXPECTED.webglUnmaskedVendor)],
        ["unmasked renderer", gl.unmaskedRenderer || "(not exposed)", is(gl.unmaskedRenderer, EXPECTED.webglUnmaskedRenderer)],
      ]),
    );

    container.appendChild(
      buildTable("plugins and mimeTypes", [
        ["navigator.plugins", pluginNames(), is(pluginNames(), EXPECTED.plugins)],
        ["navigator.mimeTypes", mimeTypeList(), is(mimeTypeList(), EXPECTED.mimeTypes)],
      ]),
    );

    container.appendChild(buildTable("Web Audio", [["readback hash", audio.text, audio.ok]]));

    // Worker parity (issue #38): the same signals read from inside a dedicated worker.
    container.appendChild(workersTable(worker));

    // Probe CSP last so the earlier tables are not disturbed, then print the verdict at the top.
    renderConclusion(container, inlineScriptsBlocked());
  }

  Promise.all([audioProbe(), workerProbe()]).then(function (results) {
    render(results[0], results[1]);
  });
})();
