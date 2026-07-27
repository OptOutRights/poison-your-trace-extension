// Resize the authored 512px syringe PNGs into the sizes Firefox needs.
//
// Two colours, from two hand-drawn 512px sources:
//   - white (icons/seringuewhite-512.png): the browser-chrome icon. Used for the extensions-manager
//     entry (manifest `icons`, 16-96), the address-bar page action (16/32), and as the dark-theme
//     variant of the toolbar icon (theme_icons `light`).
//   - black (icons/seringueblack-512.png): the light-theme variant of the toolbar icon
//     (theme_icons `dark`) and its default fallback (16/32). The popup and about page reference the
//     512px black source directly, sized down by CSS.
//
// Firefox caches toolbar icons and rasterizes SVGs unevenly at 16px, so shipping pre-rendered PNGs
// keeps the chrome crisp and cache-clean. The 512px PNGs stay the only hand-edited icon assets.
// Regenerate with `npm run generate-icons`; the build runs this automatically.
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const SOURCES = [
  { src: "icons/seringuewhite-512.png", base: "icons/seringuewhite", sizes: [16, 32, 48, 96] },
  { src: "icons/seringueblack-512.png", base: "icons/seringueblack", sizes: [16, 32] },
];

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

export async function generateIcons() {
  for (const { src, base, sizes } of SOURCES) {
    const source = await readFile(src);
    for (const size of sizes) {
      const png = await sharp(source)
        .resize(size, size, { fit: "contain", background: TRANSPARENT })
        .png()
        .toBuffer();
      await writeFile(`${base}-${size}.png`, png);
      console.log(`generated ${base}-${size}.png`);
    }
  }
}

// Allow standalone use: `node scripts/generate-icons.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  await generateIcons();
}
