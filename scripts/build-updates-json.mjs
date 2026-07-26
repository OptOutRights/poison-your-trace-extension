// Generate the Mozilla AMO update manifest (updates.json) that Firefox polls to auto update a
// self distributed (unlisted) extension.
//
// Firefox reads browser_specific_settings.gecko.update_url from the installed extension, fetches
// that URL, and looks up its own gecko id inside the returned JSON. For each listed version it
// compares against the installed one and, when a newer version exists, downloads the signed xpi
// named by update_link.
//
// Schema reference: https://extensionworkshop.com/documentation/manage/updating-your-extension/
//
// Usage: node scripts/build-updates-json.mjs <version> <xpiFileName> [outPath]
//   version      the extension version, for example 0.2.0 (no leading v)
//   xpiFileName  the signed xpi asset file name uploaded to the release
//   outPath      where to write updates.json (defaults to ./updates.json)
//
// The update_link points at the tagged release asset (releases/download/vX.Y.Z/<xpi>), a stable
// per version URL, while manifest.json points Firefox at the latest release for updates.json
// itself.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "OptOutRights/poison-your-trace-web-extension";

const [, , versionArg, xpiFileName, outPathArg] = process.argv;

if (!versionArg || !xpiFileName) {
  console.error(
    "Usage: node scripts/build-updates-json.mjs <version> <xpiFileName> [outPath]",
  );
  process.exit(1);
}

const version = versionArg.replace(/^v/, "");
const here = dirname(fileURLToPath(import.meta.url));

const manifestPath = join(here, "..", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const geckoId = manifest?.browser_specific_settings?.gecko?.id;

if (!geckoId) {
  console.error("manifest.json is missing browser_specific_settings.gecko.id");
  process.exit(1);
}

const updateLink = `https://github.com/${REPO}/releases/download/v${version}/${xpiFileName}`;

const updates = {
  addons: {
    [geckoId]: {
      updates: [
        {
          version,
          update_link: updateLink,
        },
      ],
    },
  },
};

const outPath = outPathArg ?? join(here, "..", "updates.json");
await writeFile(outPath, `${JSON.stringify(updates, null, 2)}\n`, "utf8");

console.log(`Wrote ${outPath} for gecko id ${geckoId} version ${version}.`);
console.log(`update_link: ${updateLink}`);
