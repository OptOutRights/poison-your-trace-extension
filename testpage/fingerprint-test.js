// Self contained fingerprint reader for the Poison your Trace test page.
//
// It probes every signal in scope and renders a grouped table. Open this page with the extension
// enabled to see the shared common profile, and with the extension disabled to see your machine's
// real values. No build step: it is a plain classic script loaded by fingerprint.html.

(function () {
  "use strict";

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

  function safe(fn) {
    try {
      return fn();
    } catch (err) {
      return "unavailable (" + (err && err.message ? err.message : String(err)) + ")";
    }
  }

  // Draw a small mixed scene, then hash the PNG bytes. Uniformized, the readback is a blank canvas
  // of the same size, so this hash is identical for every user; real, it encodes the device.
  function canvasHash() {
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
      var url = canvas.toDataURL();
      var comma = url.indexOf(",");
      var b64 = comma >= 0 ? url.slice(comma + 1) : url;
      var raw = atob(b64);
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return hash(bytes) + " (" + bytes.length + " bytes)";
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
  // the samples are a fixed constant so the hash is identical for every user; real it encodes the
  // device audio stack.
  function audioHash() {
    return new Promise(function (resolve) {
      try {
        var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Ctx) return resolve("no OfflineAudioContext");
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
          resolve(hash(bytes) + " (sum of abs samples " + sum.toFixed(6) + ")");
        }, function () {
          resolve("rendering failed");
        });
      } catch (err) {
        resolve("unavailable (" + (err && err.message ? err.message : String(err)) + ")");
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

  function buildTable(caption, rows) {
    var table = document.createElement("table");
    var cap = document.createElement("caption");
    cap.textContent = caption;
    table.appendChild(cap);
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      var th = document.createElement("th");
      th.textContent = row[0];
      var td = document.createElement("td");
      td.className = "value";
      td.textContent = String(row[1]);
      tr.appendChild(th);
      tr.appendChild(td);
      table.appendChild(tr);
    });
    return table;
  }

  function render(audio) {
    var gl = webgl();
    var container = document.getElementById("report");
    container.textContent = "";

    container.appendChild(
      buildTable("navigator", [
        ["userAgent", navigator.userAgent],
        ["appVersion", navigator.appVersion],
        ["platform", navigator.platform],
        ["language", navigator.language],
        ["languages", (navigator.languages || []).join(", ")],
        ["hardwareConcurrency", navigator.hardwareConcurrency],
        ["oscpu", navigator.oscpu || "(not exposed)"],
      ]),
    );

    container.appendChild(
      buildTable("screen and window", [
        ["screen.width", screen.width],
        ["screen.height", screen.height],
        ["screen.availWidth", screen.availWidth],
        ["screen.availHeight", screen.availHeight],
        ["screen.colorDepth", screen.colorDepth],
        ["screen.pixelDepth", screen.pixelDepth],
        ["devicePixelRatio", window.devicePixelRatio],
      ]),
    );

    container.appendChild(
      buildTable("timezone", [
        ["Intl timeZone", safe(function () { return new Intl.DateTimeFormat().resolvedOptions().timeZone; })],
        ["getTimezoneOffset (minutes)", new Date().getTimezoneOffset()],
      ]),
    );

    container.appendChild(buildTable("canvas", [["readback hash", canvasHash()]]));

    container.appendChild(
      buildTable("WebGL", [
        ["vendor (masked)", gl.vendor],
        ["renderer (masked)", gl.renderer],
        ["unmasked vendor", gl.unmaskedVendor || "(not exposed)"],
        ["unmasked renderer", gl.unmaskedRenderer || "(not exposed)"],
      ]),
    );

    container.appendChild(
      buildTable("plugins and mimeTypes", [
        ["navigator.plugins", pluginNames()],
        ["navigator.mimeTypes", mimeTypeList()],
      ]),
    );

    container.appendChild(buildTable("Web Audio", [["readback hash", audio]]));
  }

  audioHash().then(render);
})();
