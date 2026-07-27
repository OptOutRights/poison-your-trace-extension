// Rasterize the single source syringe SVG into the PNG sizes Firefox uses for the toolbar
// (browser_action), the address-bar page action, and the extensions manager. Firefox caches
// toolbar icons aggressively and rasterizes SVGs unevenly at 16px, so we ship pre-rendered PNGs
// referenced by fresh file names: the toolbar then loads a crisp, cache-clean icon.
//
// The SVG stays the only hand-edited asset, so the PNGs never drift from it. Regenerate with
// `npm run generate-icons`; the build also runs this automatically.
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const SVG = "icons/syringe.svg";
const SIZES = [16, 32, 48, 96];

export async function generateIcons() {
  const svg = await readFile(SVG);
  for (const size of SIZES) {
    // A high render density keeps the small sizes sharp: the SVG is rasterized large, then
    // downscaled by sharp, which reads better than rendering straight to 16px.
    const png = await sharp(svg, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    await writeFile(`icons/syringe-${size}.png`, png);
    console.log(`generated icons/syringe-${size}.png`);
  }
}

// Allow standalone use: `node scripts/generate-icons.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  await generateIcons();
}
