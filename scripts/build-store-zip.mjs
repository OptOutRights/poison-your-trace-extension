// Build the AMO "listed" (store) package.
//
// It is the same package as the self-hosted build with ONE difference: it removes
// browser_specific_settings.gecko.update_url. That field is required for a self-distributed
// extension (Firefox polls it for updates) but is a hard error for a Mozilla-hosted add-on
// (web-ext lint: MANIFEST_UPDATE_URL "is not allowed"). Listed add-ons auto-update from AMO
// itself, so they must not carry an update_url.
//
// The strip is done on a transient copy of manifest.json and always restored in a finally block,
// so the working tree is left byte-for-byte unchanged (the self-hosted release path still sees
// its update_url).
//
// Usage: node scripts/build-store-zip.mjs
// Prerequisite: `npm run build` must have produced dist/, fonts/, and the resized icons first.
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const manifestPath = "manifest.json";
const original = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(original);

const gecko = manifest.browser_specific_settings?.gecko;
if (gecko?.update_url) {
  delete gecko.update_url;
} else {
  console.warn("manifest has no gecko.update_url to strip; building as-is.");
}

try {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  execFileSync(
    "npx",
    [
      "web-ext",
      "build",
      "--overwrite-dest",
      "--filename",
      "poison-your-trace-store-{version}.zip",
    ],
    { stdio: "inherit" },
  );
} finally {
  await writeFile(manifestPath, original, "utf8");
}
