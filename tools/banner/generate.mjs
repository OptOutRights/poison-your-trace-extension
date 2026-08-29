// THROWAWAY GENERATOR (not shipped). Produces animated, rectangular banners whose elements are
// Conway's Game of Life spaceships.
//
//   Act 1 "Exposed"   — assorted ships (gliders in all four diagonals + lightweight spaceships)
//                        flying every which way: each device unique, a tracker can single you out.
//   Act 2 "Protected" — identical ships in an even, lockstep formation: everyone shows the one
//                        shared profile, so the crowd blends together.
//
// The Life rule does the animation; ships are real Life objects, validated here so a mistyped
// pattern can't quietly decay into soup. Frames are rendered as SVG (crisp text + one rect per live
// cell), rasterised with sharp, then encoded with ffmpeg.
//
// Run:  node tools/banner/generate.mjs           (renders every variant in VARIANTS)
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ACT1 = 42,
  FLASH = 8,
  ACT2 = 48;

// ---- themes ---------------------------------------------------------------
const LIGHT = {
  field: "#fafafa",
  header: "#ffffff",
  line: "#e4e4e7",
  title: "#18181b",
  tag: "#52525b",
  cell: "#0a7d3c",
  exposed: { bg: "#fff8eb", line: "#d6c3a4", text: "#6b4d21", label: "Exposed" },
  ok: { bg: "#ecfdf5", line: "#a7f3d0", text: "#065f46", label: "Protected" },
  iconFile: "icons/seringueblack-32.png",
};
const DARK = {
  field: "#0d1210",
  header: "#0a0e0c",
  line: "#1f2a24",
  title: "#f4f4f5",
  tag: "#a1a1aa",
  cell: "#3ad07f",
  exposed: { bg: "#2a2113", line: "#5c4a1f", text: "#f0c674", label: "Exposed" },
  ok: { bg: "#0f2b1e", line: "#1f5c3f", text: "#6ee7a8", label: "Protected" },
  iconFile: "icons/seringuewhite-512.png",
};

// ---- variants to render ---------------------------------------------------
const VARIANTS = [
  { name: "banner-dark", out: "docs/banner-dark.gif", theme: DARK, cols: 120, rows: 30, cell: 8, header: 60, fleet: "mixed" },
  { name: "banner-glider", out: "docs/banner-glider.gif", theme: LIGHT, cols: 120, rows: 30, cell: 8, header: 60, fleet: "gliders" },
  { name: "banner-og", out: "docs/banner-og.gif", theme: DARK, cols: 120, rows: 54, cell: 10, header: 90, fleet: "mixed" },
];

// ---- seeded PRNG (reproducible) -------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- ship patterns + validation (grid-size independent) -------------------
const parse = (rows) => {
  const cells = [];
  rows.forEach((row, r) => [...row].forEach((ch, c) => ch === "O" && cells.push([r, c])));
  return cells;
};
const rot90 = (cells) => {
  const maxC = Math.max(...cells.map(([, c]) => c));
  return cells.map(([r, c]) => [c, maxC - r]);
};
const mirror = (cells) => {
  const maxC = Math.max(...cells.map(([, c]) => c));
  return cells.map(([r, c]) => [r, maxC - c]);
};
const norm = (cells) => {
  const mr = Math.min(...cells.map(([r]) => r));
  const mc = Math.min(...cells.map(([, c]) => c));
  return cells.map(([r, c]) => [r - mr, c - mc]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
};
// Run 4 gens on a scratch torus; return velocity, or null if not a clean period-4 spaceship.
function velocity(cells) {
  const N = 24;
  const seed = () => new Set(norm(cells).map(([r, c]) => `${r + 8},${c + 8}`));
  const stepSet = (set) => {
    const cnt = new Map();
    for (const k of set) {
      const [r, c] = k.split(",").map(Number);
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const kk = `${(r + dr + N) % N},${(c + dc + N) % N}`;
          cnt.set(kk, (cnt.get(kk) || 0) + 1);
        }
    }
    const nx = new Set();
    for (const [k, n] of cnt) if (n === 3 || (n === 2 && set.has(k))) nx.add(k);
    return nx;
  };
  let s = seed();
  for (let i = 0; i < 4; i++) s = stepSet(s);
  const start = norm(cells);
  const end = norm([...s].map((k) => k.split(",").map(Number)));
  if (start.length !== end.length) return null;
  for (let i = 0; i < start.length; i++)
    if (start[i][0] !== end[i][0] || start[i][1] !== end[i][1]) return null;
  const minOf = (set) => {
    let mr = 99,
      mc = 99;
    for (const k of set) {
      const [r, c] = k.split(",").map(Number);
      mr = Math.min(mr, r);
      mc = Math.min(mc, c);
    }
    return [mr, mc];
  };
  let t = seed();
  const [ar, ac] = minOf(t);
  for (let i = 0; i < 4; i++) t = stepSet(t);
  const [br, bc] = minOf(t);
  const dr = br - ar,
    dc = bc - ac;
  return dr === 0 && dc === 0 ? null : { cells: norm(cells), dr, dc };
}

const GLIDER = parse([".O.", "..O", "OOO"]);
const LWSS = parse(["O..O.", "....O", "O...O", ".OOOO"]);

const fleetAll = [];
let g = GLIDER;
for (let i = 0; i < 4; i++) {
  const v = velocity(g);
  if (v) fleetAll.push(v);
  g = rot90(g);
}
for (const cand of [LWSS, mirror(LWSS)]) {
  const v = velocity(cand);
  if (v) fleetAll.push(v);
}
const gliders = fleetAll.filter((s) => s.cells.length === 5);
const lwssRight = fleetAll.find((s) => s.dr === 0 && s.cells.length === 9);
const gliderDownRight = gliders.find((s) => s.dr === 1 && s.dc === 1) || gliders[0];

// ---- one variant ----------------------------------------------------------
async function render(cfg) {
  const { cols: COLS, rows: ROWS, cell: CELL, header: HEADER, theme: T } = cfg;
  const W = COLS * CELL,
    H = HEADER + ROWS * CELL;
  const frameDir = `/tmp/banner-frames-${cfg.name}`;
  const rnd = mulberry32(0xc0ffee);
  const fleet = cfg.fleet === "gliders" ? gliders : fleetAll;
  const uniformShip = cfg.fleet === "gliders" ? gliderDownRight : lwssRight;

  let grid = new Uint8Array(COLS * ROWS);
  const idx = (r, c) => ((r + ROWS) % ROWS) * COLS + ((c + COLS) % COLS);
  const stamp = (cells, r0, c0) => cells.forEach(([r, c]) => (grid[idx(r0 + r, c0 + c)] = 1));

  function step() {
    const next = new Uint8Array(COLS * ROWS);
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        let n = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            n += grid[idx(r + dr, c + dc)];
          }
        next[idx(r, c)] = n === 3 || (n === 2 && grid[idx(r, c)]) ? 1 : 0;
      }
    grid = next;
  }
  function seedExposed() {
    grid = new Uint8Array(COLS * ROWS);
    for (let sr = 2; sr < ROWS - 4; sr += 8)
      for (let sc = 2; sc < COLS - 6; sc += 15) {
        const ship = fleet[Math.floor(rnd() * fleet.length)];
        stamp(ship.cells, sr + Math.floor(rnd() * 3), sc + Math.floor(rnd() * 4));
      }
  }
  function seedProtected() {
    grid = new Uint8Array(COLS * ROWS);
    for (let r = 2; r < ROWS - 3; r += 7)
      for (let c = 0; c < COLS; c += 16) stamp(uniformShip.cells, r, c);
  }

  // Header type scales with the band height so the OG card reads as a card, not a stretched banner.
  const iconSize = HEADER >= 80 ? 40 : 30;
  const titleSize = HEADER >= 80 ? 30 : 22;
  const tagSize = HEADER >= 80 ? 15 : 13;
  const titleX = 20 + iconSize + 12;
  const titleY = Math.round(HEADER * 0.44);
  const tagY = Math.round(HEADER * 0.72);
  const iconPath = resolve(ROOT, T.iconFile);
  const iconData = existsSync(iconPath)
    ? `data:image/png;base64,${readFileSync(iconPath).toString("base64")}`
    : null;

  function svgFrame(state, flash) {
    const s = state === "protected" ? T.ok : T.exposed;
    const rects = [];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (grid[idx(r, c)])
          rects.push(`<rect x="${c * CELL + 1}" y="${HEADER + r * CELL + 1}" width="${CELL - 2}" height="${CELL - 2}" rx="1"/>`);
    const chipW = (state === "protected" ? 78 : 72) * (HEADER >= 80 ? 1.25 : 1);
    const chipH = HEADER >= 80 ? 30 : 24;
    const chipX = W - chipW - 24;
    const chipY = (HEADER - chipH) / 2;
    const icon = iconData ? `<image href="${iconData}" x="20" y="${(HEADER - iconSize) / 2}" width="${iconSize}" height="${iconSize}"/>` : "";
    const font = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect x="0" y="${HEADER}" width="${W}" height="${H - HEADER}" fill="${T.field}"/>
      <g fill="${T.cell}">${rects.join("")}</g>
      ${flash > 0 ? `<rect x="0" y="${HEADER}" width="${W}" height="${H - HEADER}" fill="${T.cell}" opacity="${flash.toFixed(3)}"/>` : ""}
      <rect x="0" y="0" width="${W}" height="${HEADER}" fill="${T.header}"/>
      <line x1="0" y1="${HEADER - 0.5}" x2="${W}" y2="${HEADER - 0.5}" stroke="${T.line}"/>
      ${icon}
      <text x="${titleX}" y="${titleY}" font-family="${font}" font-size="${titleSize}" font-weight="700" fill="${T.title}">Poison your Trace</text>
      <text x="${titleX}" y="${tagY}" font-family="${font}" font-size="${tagSize}" font-weight="500" fill="${T.tag}">You're not you. You are everyone.</text>
      <rect x="${chipX}" y="${chipY}" width="${chipW}" height="${chipH}" rx="6" fill="${s.bg}" stroke="${s.line}"/>
      <text x="${chipX + chipW / 2}" y="${chipY + chipH / 2 + 5}" text-anchor="middle" font-family="${font}" font-size="${HEADER >= 80 ? 15 : 13}" font-weight="600" fill="${s.text}">${s.label}</text>
    </svg>`;
  }

  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const TOTAL = ACT1 + FLASH + ACT2;
  seedExposed();
  for (let frame = 0; frame < TOTAL; frame++) {
    let state = "exposed",
      flash = 0;
    if (frame >= ACT1 && frame < ACT1 + FLASH) {
      const t = (frame - ACT1) / FLASH;
      flash = Math.sin(t * Math.PI);
      state = t < 0.5 ? "exposed" : "protected";
    } else if (frame >= ACT1 + FLASH) {
      state = "protected";
    }
    const png = `${frameDir}/f${String(frame).padStart(4, "0")}.png`;
    await sharp(Buffer.from(svgFrame(state, flash))).png().toFile(png);
    if (frame === ACT1 + Math.floor(FLASH / 2) - 1) seedProtected();
    else step();
  }

  const out = resolve(ROOT, cfg.out);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-framerate", "15",
      "-i", `${frameDir}/f%04d.png`,
      "-vf", "split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
      "-loop", "0",
      out,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  console.log(`  ${cfg.name}: ${W}x${H}, ${TOTAL} frames -> ${cfg.out}`);
}

console.log(`fleet: ${fleetAll.length} ships (${gliders.length} gliders, lwss=${!!lwssRight})`);
for (const v of VARIANTS) await render(v);
console.log("done");
