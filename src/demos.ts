// Honest "before -> after" illustrations shown inside each protection's "See how" drop-down.
//
// These are teaching aids drawn on device, NOT live readings of the current page (the extension
// fabricates no metrics). But they are tuned to match what Firefox's RFP actually does, measured
// on device with privacy.resistFingerprinting=true (Firefox 158):
//   - RFP does NOT change what you see on screen. It changes what a *script* gets when it reads the
//     canvas back (getImageData/toDataURL): the read-back is heavily randomised (measured ~100% of
//     pixels changed, mean channel deviation ~90/255) and different every session. That is why an
//     image a site processes through a canvas — e.g. resized before upload — can come out visibly
//     grainy. The picture demo shows exactly this: clean on the "off" side, heavy grain on the "on"
//     side, with the read-back id changing each time.
//   - The time-zone demo IS real: it reads your actual zone and shows the UTC value RFP makes sites
//     see.
//   - Web Audio fingerprinting is treated the same way (the measured waveform is roughened).
//   - The tracker, IP, click-ping and pre-connect demos use clearly-labelled EXAMPLE values; we never
//     claim to have detected these specific trackers or addresses on the site in front of you.

// Every protection carries a visual, so each row in the merged panel gets a "See how" drop-down.
export type ReadoutKey =
  | "container"
  | "rfp"
  | "trackingProtection"
  | "webrtc"
  | "hyperlinkAuditing"
  | "networkPrediction";

// Terse DOM builder: element with a class and optional text, so the builders below read as structure.
function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A labelled "before -> after" row: a small heading, the two visuals with an arrow between, and a
// one-line caption under each. Used by every demo so the drop-downs share one visual grammar.
function facet(
  label: string,
  before: { visual: HTMLElement; cap: string },
  after: { visual: HTMLElement; cap: string },
): HTMLElement {
  const wrap = make("div", "demo-facet");
  wrap.append(make("div", "demo-facet-label", label));

  const row = make("div", "demo-row");
  const cell = (side: { visual: HTMLElement; cap: string }, tone: string): HTMLElement => {
    const col = make("div", `demo-cell ${tone}`);
    col.append(side.visual, make("div", "demo-cap", side.cap));
    return col;
  };
  row.append(cell(before, "demo-before"), make("div", "demo-arrow", "→"), cell(after, "demo-after"));
  wrap.append(row);
  return wrap;
}

// --- RFP picture: the Palestinian flag, drawn on device, then read back as a fingerprint ------------

const FLAG_W = 104;
const FLAG_H = 62;

// Draw the flag: three bands (black / white / green) and the red hoist triangle. Official-ish colours.
function drawFlag(ctx: CanvasRenderingContext2D): void {
  const band = FLAG_H / 3;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, FLAG_W, band);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, band, FLAG_W, band);
  ctx.fillStyle = "#007a3d";
  ctx.fillRect(0, band * 2, FLAG_W, band);
  ctx.fillStyle = "#ce1126";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(FLAG_W * 0.42, FLAG_H / 2);
  ctx.lineTo(0, FLAG_H);
  ctx.closePath();
  ctx.fill();
}

// Add strong per-pixel noise to mirror what RFP returns from a canvas read-back: heavy grain that
// still leaves the picture recognisable — the "really noisy" image people see when a site processes
// an upload through a canvas. (Measured RFP read-back is even harsher; we keep the flag legible so the
// point reads.)
function addNoise(ctx: CanvasRenderingContext2D, amp: number): void {
  const img = ctx.getImageData(0, 0, FLAG_W, FLAG_H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() * 2 - 1) * amp;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

// FNV-1a over a sample of the pixels -> 6 hex chars. This is a real hash of what the canvas reads
// back, so it genuinely changes whenever the pixels do — exactly how a canvas fingerprint behaves.
function signature(ctx: CanvasRenderingContext2D): string {
  const d = ctx.getImageData(0, 0, FLAG_W, FLAG_H).data;
  let hash = 0x811c9dc5;
  for (let i = 0; i < d.length; i += 97) {
    hash ^= d[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

function flagCanvas(): HTMLCanvasElement {
  const canvas = make("canvas", "demo-canvas");
  canvas.width = FLAG_W;
  canvas.height = FLAG_H;
  return canvas;
}

// --- RFP sound: an audio waveform, clean vs jittered -----------------------------------------------

const WAVE_W = 104;
const WAVE_H = 34;

function drawWave(ctx: CanvasRenderingContext2D, jitter: boolean): void {
  ctx.clearRect(0, 0, WAVE_W, WAVE_H);
  ctx.strokeStyle = jitter ? "#0a7d3c" : "#71717a";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = 0; x <= WAVE_W; x++) {
    const base = Math.sin((x / WAVE_W) * Math.PI * 4) * (WAVE_H * 0.3);
    const j = jitter ? (Math.random() * 2 - 1) * (WAVE_H * 0.14) : 0;
    const y = WAVE_H / 2 + base + j;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function waveCanvas(): HTMLCanvasElement {
  const canvas = make("canvas", "demo-canvas");
  canvas.width = WAVE_W;
  canvas.height = WAVE_H;
  return canvas;
}

// Build the RFP drop-down: picture (id changes), clock (zone -> UTC), sound (waveform scrambled),
// and a "Scramble again" button that re-rolls the picture and sound so the moving target is obvious.
function buildRfpDemo(): HTMLElement {
  const demo = make("div", "demo");

  // Picture: left = without us (one stable id = a durable label), right = with us (new id each load).
  const cleanCanvas = flagCanvas();
  const noisyCanvas = flagCanvas();
  // willReadFrequently: these contexts are read back repeatedly (noise + signature on every scramble).
  const cleanCtx = cleanCanvas.getContext("2d", { willReadFrequently: true });
  const noisyCtx = noisyCanvas.getContext("2d", { willReadFrequently: true });

  const cleanWrap = make("div", "demo-stack");
  const noisyWrap = make("div", "demo-stack");
  const cleanSig = make("code", "demo-sig");
  const noisySig = make("code", "demo-sig");
  cleanWrap.append(cleanCanvas, cleanSig);
  noisyWrap.append(noisyCanvas, noisySig);

  // Left = protection OFF: a tracker reads your real pixels, a stable id that tags you (fixed here).
  // Right = protection ON: it reads randomised noise, a new id every time (re-rolled on Scramble).
  const paintPicture = (): void => {
    if (cleanCtx) {
      drawFlag(cleanCtx);
      cleanSig.textContent = "id 7c1a9f";
    }
    if (noisyCtx) {
      drawFlag(noisyCtx);
      addNoise(noisyCtx, 150);
      noisySig.textContent = `id ${signature(noisyCtx)}`;
    }
  };

  demo.append(
    facet(
      "A picture a script reads back",
      { visual: cleanWrap, cap: "Off: your real pixels, same id every visit" },
      { visual: noisyWrap, cap: "On: randomised read-back, new id every visit" },
    ),
  );

  // Clock: real local zone -> the UTC value RFP makes sites see. If the browser already reports UTC
  // (e.g. RFP is on for this page too) we say so rather than show an identical pair.
  const now = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "your zone";
  const fmt = (utc: boolean): string =>
    now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(utc ? { timeZone: "UTC" } : {}) });
  const localClock = make("div", "demo-clock", fmt(false));
  const utcClock = make("div", "demo-clock", fmt(true));
  demo.append(
    facet(
      "Your clock (live)",
      { visual: localClock, cap: zone },
      { visual: utcClock, cap: "UTC: shared with all tool users" },
    ),
  );

  // Sound: Web Audio fingerprinting. RFP does NOT add noise here — it FLATTENS the measurement toward
  // a value everyone shares (locked sample rate, de-randomised float maths). So "off" is your slightly
  // idiosyncratic waveform; "on" is the common, shared one. Drawn once (it is not re-rolled per load).
  const uniqueWave = waveCanvas();
  const flatWave = waveCanvas();
  const uniqueCtx = uniqueWave.getContext("2d");
  const flatCtx = flatWave.getContext("2d");
  if (uniqueCtx) drawWave(uniqueCtx, true);
  if (flatCtx) drawWave(flatCtx, false);
  demo.append(
    facet(
      "A sound a script measures",
      { visual: uniqueWave, cap: "Off: your exact values, a unique number" },
      { visual: flatWave, cap: "On: flattened to the common value" },
    ),
  );

  // Honest framing: none of this is anything you see or hear — it only changes what a script reads back.
  demo.append(
    make(
      "p",
      "demo-honest",
      "You never see or hear any of this change. It only affects what a website reads it. Warning ! This is also why sharing an image to a site with the extension can cause issues.",
    ),
  );

  paintPicture();
  return demo;
}

// --- Hyperlink auditing: a click's hidden ping is dropped -------------------------------------------

function buildHyperlinkDemo(): HTMLElement {
  const demo = make("div", "demo");
  const page = make("div", "demo-page");
  page.append(make("div", "demo-page-label", "You click a link; it tries to…"));
  const list = make("div", "demo-chip-col");
  list.append(
    make("span", "demo-chip demo-chip-ok", "take you to the page  ✓"),
    make("span", "demo-chip demo-chip-blocked", "ping tracker.example  ✕ dropped"),
  );
  page.append(list);
  demo.append(
    page,
  );
  return demo;
}

// --- Network prediction: speculative early contact is stopped ---------------------------------------

function buildPredictionDemo(): HTMLElement {
  const demo = make("div", "demo");
  const page = make("div", "demo-page");
  page.append(make("div", "demo-page-label", "Before you open anything, Firefox would…"));
  const list = make("div", "demo-chip-col");
  list.append(
    make("span", "demo-chip demo-chip-blocked", "pre-connect  ad.example  ✕ stopped"),
    make("span", "demo-chip demo-chip-blocked", "pre-resolve  track.example  ✕ stopped"),
  );
  page.append(list);
  demo.append(
    page
  );
  return demo;
}

// --- Container: each site in its own cookie jar ----------------------------------------------------

function siteChips(shared: boolean): HTMLElement {
  const scene = make("div", `demo-scene ${shared ? "demo-scene-shared" : "demo-scene-boxed"}`);
  const sites = ["shop", "news", "social"];
  if (shared) {
    const row = make("div", "demo-chip-row");
    for (const s of sites) row.append(make("span", "demo-chip", s));
    const jar = make("div", "demo-jar", "one shared jar");
    scene.append(row, make("div", "demo-arrow-down", "↓"), jar);
  } else {
    for (const s of sites) {
      const pair = make("div", "demo-pair");
      pair.append(make("span", "demo-chip", s), make("span", "demo-jar demo-jar-mini", "own jar"));
      scene.append(pair);
    }
  }
  return scene;
}

function buildContainerDemo(): HTMLElement {
  const demo = make("div", "demo");
  demo.append(
    facet(
      "Where this site's cookies live",
      { visual: siteChips(true), cap: "All sites share cookies in one jar" },
      { visual: siteChips(false), cap: "One jar per site" },
    ),
    // make("p", "demo-honest", "Illustration. Each site really does get its own Firefox container."),
  );
  return demo;
}

// --- Trackers: known third-party trackers are blocked ----------------------------------------------

function buildTrackerDemo(): HTMLElement {
  const demo = make("div", "demo");
  const page = make("div", "demo-page");
  page.append(make("div", "demo-page-label", "A page you open loads…"));
  const list = make("div", "demo-chip-col");
  const blocked = ["ads-track.example", "metrics.example", "beacon.example"];
  list.append(make("span", "demo-chip demo-chip-ok", "this-site.example  ✓ loads"));
  for (const t of blocked) list.append(make("span", "demo-chip demo-chip-blocked", `${t}  ✕ blocked`));
  page.append(list);
  demo.append(page);
  return demo;
}

// --- WebRTC: a call can't read your addresses ------------------------------------------------------

function buildWebrtcDemo(): HTMLElement {
  const demo = make("div", "demo");
  const page = make("div", "demo-page");
  page.append(make("div", "demo-page-label", "A video/voice call tries to read…"));
  const list = make("div", "demo-chip-col");
  list.append(
    make("span", "demo-chip demo-chip-blocked", "local  192.168.1.42  ✕ hidden"),
    make("span", "demo-chip demo-chip-blocked", "real  83.200.14.7  ✕ hidden"),
  );
  page.append(list);
  demo.append(page);
  return demo;
}

// Build the visual for a readout protection, or null if it has none.
export function buildDemo(key: ReadoutKey): HTMLElement | null {
  switch (key) {
    case "rfp":
      return buildRfpDemo();
    case "container":
      return buildContainerDemo();
    case "trackingProtection":
      return buildTrackerDemo();
    case "webrtc":
      return buildWebrtcDemo();
    case "hyperlinkAuditing":
      return buildHyperlinkDemo();
    case "networkPrediction":
      return buildPredictionDemo();
    default:
      return null;
  }
}
