// Resize the authored 512px firesnake PNG into the sizes Firefox needs.
//
// One full-colour source (icons/firesnake-512.png) drives every slot: the extensions-manager entry
// (manifest `icons`, 16-96), the address-bar page action (16/32), the toolbar icon's default
// fallback (16/32), and BOTH theme_icons variants (a colour logo reads on light and dark chrome
// alike, so light and dark point at the same PNGs). The popup and about page reference the 32px
// PNG in their masthead, sized by CSS.
//
// Firefox caches toolbar icons and rasterizes SVGs unevenly at 16px, so shipping pre-rendered PNGs
// keeps the chrome crisp and cache-clean. The 512px PNG stays the only hand-edited icon asset.
// Regenerate with `npm run generate-icons`; the build runs this automatically.
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const SOURCES = [
  { src: "icons/firesnake-512.png", base: "icons/firesnake", sizes: [16, 32, 48, 96] },
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
