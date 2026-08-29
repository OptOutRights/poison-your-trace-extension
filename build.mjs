// Bundle each WebExtension entry point into a standalone IIFE so it can load as a classic
// background/content/popup script (Firefox MV2). Type checking is done separately by tsc.
//
// Named entry points keep the output flat in dist/ (dist/background.js, dist/fingerprint.js, ...)
// even though the sources live in nested folders, so the manifest and background can reference
// stable file names.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { generateIcons } from "./scripts/generate-icons.mjs";

// Refresh the toolbar/page-action/manager PNGs from the source SVG so the packaged icons always
// match the current syringe artwork.
await generateIcons();

// Bundle the Outfit Variable font into the extension. node_modules is not shipped, so copy the
// woff2 to a packaged location the popup stylesheet can @font-face.
await mkdir("fonts", { recursive: true });
await copyFile(
  "node_modules/@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2",
  "fonts/outfit.woff2",
);

await build({
  entryPoints: {
    background: "src/background.ts",
    popup: "src/popup.ts",
    fingerprint: "src/fingerprint/inject.ts",
    "fingerprint-workers": "src/fingerprint/workers.ts",
    "fingerprint-webgl": "src/fingerprint/webgl.ts",
    "fingerprint-audio": "src/fingerprint/audio.ts",
    "fingerprint-plugins": "src/fingerprint/plugins.ts",
    "fingerprint-report-relay": "src/fingerprint/report-relay.ts",
    "email-autofill": "src/email/autofill.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "iife",
  // Keep the output unminified so the shipped scripts stay readable when debugging in the page
  // (the fingerprint overrides run in the page's MAIN world, where the page can read them anyway).
  minify: false,
  target: "firefox128",
  platform: "browser",
  logLevel: "info",
});
