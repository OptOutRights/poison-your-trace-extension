// Content script, registered dynamically at document_start when the extension is enabled.
//
// Uniformizes the Web Audio fingerprint. Like inject.ts it injects a page world <script> so the
// overrides are visible to the site's own scripts.
//
// The audio fingerprint is derived from the PCM a site renders through an OfflineAudioContext
// (oscillator into DynamicsCompressor into destination) and reads back via getChannelData. Tiny
// per device differences in the compressor and oscillator math produce a stable, distinguishing
// hash. We neutralize it at the READBACK path rather than the DSP path: whatever was rendered, the
// samples handed to the page are a FIXED constant, so the derived hash carries zero bits and is
// identical across every machine (uniformize, not randomize).
//
// Caveat (documented seam): this deliberately breaks legitimate Web Audio readback (visualisers,
// waveform analysis, offline export). Ordinary playback is unaffected, we patch only the buffer and
// analyser read APIs, not the audio graph or its output to speakers. Inline injection can also be
// blocked by a strict page Content Security Policy (same seam as inject.ts).

/**
 * Runs in the PAGE world. Must be fully self contained: it is serialized with `toString()` and may
 * reference only its arguments (`fill`) and standard globals, never module scope symbols.
 *
 * @param fill the single fixed sample value every readback is flattened to (0 means a silent
 *   buffer, so a sum of absolute samples becomes exactly zero).
 */
function pageWorldOverride(fill: number): void {
  // Replace a prototype method, tolerating a missing or frozen prototype rather than throwing.
  const patch = (proto: object | undefined, name: string, impl: (...args: never[]) => unknown): void => {
    try {
      if (proto && name in proto) {
        (proto as Record<string, unknown>)[name] = impl;
      }
    } catch {
      /* engine rejected the assignment (non writable or missing), leave that path untouched */
    }
  };

  // Offline read path: getChannelData is the canonical fingerprint source. Return a fresh, fully
  // constant Float32Array of the buffer's real length so downstream length based math is unchanged
  // while every sample is identical across devices.
  patch(
    (typeof AudioBuffer !== "undefined" && AudioBuffer.prototype) || undefined,
    "getChannelData",
    function getChannelData(this: AudioBuffer): Float32Array {
      const out = new Float32Array(this.length);
      if (fill !== 0) out.fill(fill);
      return out;
    },
  );

  // copyFromChannel is the alternative offline read path (fills a caller provided array). Flatten it
  // to the same constant so it cannot be used to recover the real PCM.
  patch(
    (typeof AudioBuffer !== "undefined" && AudioBuffer.prototype) || undefined,
    "copyFromChannel",
    function copyFromChannel(this: AudioBuffer, destination: Float32Array): void {
      if (destination && typeof destination.length === "number") {
        if (fill !== 0) destination.fill(fill);
        else destination.fill(0);
      }
    },
  );

  // Realtime read path: AnalyserNode feeds most in page visualisers. Uniformize its outputs too so
  // the realtime spectrum and waveform carry no distinguishing bits.
  const analyser = typeof AnalyserNode !== "undefined" ? AnalyserNode.prototype : undefined;
  patch(analyser, "getFloatFrequencyData", function getFloatFrequencyData(array: Float32Array): void {
    // dB scale: negative infinity is the natural silence floor; use a finite constant to stay safe.
    if (array && typeof array.length === "number") array.fill(fill !== 0 ? fill : -100);
  });
  patch(analyser, "getByteFrequencyData", function getByteFrequencyData(array: Uint8Array): void {
    if (array && typeof array.length === "number") array.fill(0);
  });
  patch(analyser, "getFloatTimeDomainData", function getFloatTimeDomainData(array: Float32Array): void {
    if (array && typeof array.length === "number") array.fill(fill);
  });
  patch(analyser, "getByteTimeDomainData", function getByteTimeDomainData(array: Uint8Array): void {
    // Time domain byte data is centred at 128 (zero amplitude), matching a silent signal.
    if (array && typeof array.length === "number") array.fill(128);
  });
}

// Fixed constant shared by every user: a silent buffer. This makes the audio readback value
// (sum of absolute samples over getChannelData(0)) deterministically zero on all machines.
const AUDIO_FILL = 0;

function inject(): void {
  const code = `(${pageWorldOverride.toString()})(${JSON.stringify(AUDIO_FILL)});`;
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
