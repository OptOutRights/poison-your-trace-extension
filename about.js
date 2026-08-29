/*
  Interactive crowd demo for the "How it works" page. Builds a grid of device "fingerprints" (a
  small pixel block plus a one-line signature) and morphs them on toggle:

    Exposed   — every tile is unique; the ringed "you" tile stands out and the tracker locks on.
    Protected — every tile snaps to ONE shared profile; the crowd blends and the tracker loses you.

  This is a teaching visual, not the real fingerprinting engine: the point is to make "uniformize,
  not randomize" something you can feel by flipping the same switch the popup shows. Runs as an
  external script because extension pages forbid inline JS.
*/

const CROWD_SIZE = 40; // enough to read as a crowd, small enough to stay crisp on a phone
const PIXELS = 16; // 4x4 block per tile
const YOU = 17; // a middle tile, so "you" sits inside the crowd rather than at an edge

// The single common profile every user presents once protection is on — mirrors profile.ts.
const SHARED_SIGNATURE = "1920×1080 · UTC · Firefox 140 · en-US";
// A fixed pixel pattern (1 = inked) that every tile converges to. Reads as a small syringe glyph.
const SHARED_PIXELS = [0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0];

// Pools the exposed (unique) tiles draw from, so each one looks like a plausible real device.
const SCREENS = ["1440×900", "2560×1440", "1366×768", "1512×982", "3440×1440", "1080×2340"];
const ZONES = ["CET", "PST", "JST", "GMT+5:30", "EST", "AEDT", "BRT"];
const BROWSERS = ["Chrome 141", "Safari 18", "Firefox 139", "Edge 141", "Chrome 140"];
const LOCALES = ["en-GB", "fr-FR", "de-DE", "ja-JP", "es-ES", "pt-BR", "en-US"];
const INK = ["var(--accent)", "var(--zinc-800)", "var(--accent-hover)", "var(--zinc-600)"];

const reduceMotion =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** A random 16-bit on/off pattern for one exposed tile, biased so tiles aren't all-empty. */
function randomPixels() {
  return Array.from({ length: PIXELS }, () => (Math.random() < 0.45 ? 1 : 0));
}

function randomSignature() {
  return `${pick(SCREENS)} · ${pick(ZONES)} · ${pick(BROWSERS)} · ${pick(LOCALES)}`;
}

/** Build one tile's DOM once; its pixels/signature are (re)painted by paintTile. */
function buildTile(index) {
  const tile = document.createElement("div");
  tile.className = "crowd-tile" + (index === YOU ? " is-you" : "");
  if (index === YOU) tile.dataset.you = "you";

  const block = document.createElement("div");
  block.className = "crowd-pixels";
  for (let i = 0; i < PIXELS; i++) block.appendChild(document.createElement("span"));
  tile.appendChild(block);

  const sig = document.createElement("div");
  sig.className = "crowd-sig";
  tile.appendChild(sig);

  return tile;
}

/** Paint a tile for the given state, optionally staggered so the crowd converges as a wave. */
function paintTile(tile, protectedState, delay) {
  const cells = tile.querySelectorAll(".crowd-pixels span");
  const sig = tile.querySelector(".crowd-sig");
  const pixels = protectedState ? SHARED_PIXELS : (tile._pixels ||= randomPixels());
  const ink = protectedState ? "var(--accent)" : (tile._ink ||= pick(INK));

  const apply = () => {
    cells.forEach((cell, i) => {
      cell.style.background = pixels[i] ? ink : "transparent";
    });
    sig.textContent = protectedState
      ? SHARED_SIGNATURE
      : (tile._sig ||= randomSignature());
  };

  if (reduceMotion || !delay) apply();
  else setTimeout(apply, delay);
}

function render(protectedState) {
  const demo = document.getElementById("crowd-demo");
  const grid = document.getElementById("crowd-grid");
  const status = document.getElementById("crowd-status");
  const eye = document.getElementById("crowd-eye");
  const trackerText = document.getElementById("crowd-tracker-text");

  demo.dataset.state = protectedState ? "protected" : "exposed";

  const tiles = grid.querySelectorAll(".crowd-tile");
  tiles.forEach((tile, i) => {
    // Ripple outward from "you" so the wave visibly reaches your tile last.
    const delay = reduceMotion ? 0 : Math.abs(i - YOU) * 18;
    paintTile(tile, protectedState, delay);
  });

  status.textContent = protectedState ? "Protected" : "Exposed";
  status.classList.toggle("active", protectedState);
  status.classList.toggle("paused", !protectedState);

  eye.textContent = protectedState ? "🔀" : "🎯";
  if (protectedState) {
    setTracker(trackerText, "Every fingerprint is identical now — the tracker points at ", "no one in particular", ".");
  } else {
    setTracker(trackerText, "A tracker looks for the odd one out — and locks onto ", "you", ".");
  }
}

/* Set "text <strong>emphasis</strong> tail" without innerHTML (web-ext flags any innerHTML write). */
function setTracker(el, lead, emphasis, tail) {
  el.textContent = lead;
  const strong = document.createElement("strong");
  strong.textContent = emphasis;
  el.append(strong, tail);
}

function init() {
  const grid = document.getElementById("crowd-grid");
  const toggle = document.getElementById("crowd-toggle");
  if (!grid || !toggle) return; // page markup changed; fail quiet, caption still explains it

  for (let i = 0; i < CROWD_SIZE; i++) grid.appendChild(buildTile(i));
  render(false);

  toggle.addEventListener("change", () => render(toggle.checked));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
