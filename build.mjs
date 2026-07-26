// Bundle each WebExtension entry point into a standalone IIFE so it can load as a classic
// background/content/popup script (Firefox MV2). Type checking is done separately by tsc.
//
// Named entry points keep the output flat in dist/ (dist/background.js, dist/fingerprint.js, ...)
// even though the sources live in nested folders, so the manifest and background can reference
// stable file names.
import { build } from "esbuild";

await build({
  entryPoints: {
    background: "src/background.ts",
    popup: "src/popup.ts",
    fingerprint: "src/fingerprint/inject.ts",
    "fingerprint-webgl": "src/fingerprint/webgl.ts",
    "fingerprint-audio": "src/fingerprint/audio.ts",
    "fingerprint-plugins": "src/fingerprint/plugins.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "iife",
  // The fingerprint scripts serialize a function with toString() to inject it into the page world,
  // so the output must stay unminified (identifiers and whitespace preserved) for that source to
  // survive the round trip.
  minify: false,
  target: "firefox128",
  platform: "browser",
  logLevel: "info",
});
