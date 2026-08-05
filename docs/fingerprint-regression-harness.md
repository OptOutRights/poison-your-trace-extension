# Fingerprint regression harness

_Measure before we change anything._ This is the repeatable protocol that turns "robust" into a
number. It records a **baseline** for the current build so every later v2 ticket (#36–#43) can prove
it did not regress — and, crucially, so an addition can prove it actually *helped* the uniformization.
Part of epic #34.

There are two layers:

1. **Automated, local, deterministic** — `npm run harness` drives Firefox under Selenium and runs, in
   the same session, two things against the extension (ON and OFF):
   - **Our own page** (`testpage/harness.html`) — reads every in-scope signal in the **window** and in
     a **Web Worker**, then checks the two pass targets we can assert offline: `worker == window` and
     `no cross-signal contradictions`.
   - **A version-pinned, self-hosted CreepJS** (the spoof *detector*) served locally — read its
     structured verdict (`window.Fingerprint.lies`) to get a real **lie count** for the surfaces we
     override.

   This is offline and CSP-free, so it re-runs on every ticket and in CI. Output:
   [`fingerprint-baseline.json`](./fingerprint-baseline.json) +
   [`fingerprint-baseline.md`](./fingerprint-baseline.md).
2. **Manual, external suites** — pixelscan, Cover Your Tracks, browserleaks. These sit behind
   anti-bot and/or need a human eye, so they are a documented checklist, not automation. Automating
   them would measure a *headless bot* fingerprint, not a real user's — the exact kind of contradiction
   we are trying to avoid recording.

## Why these suites

| Suite | How | What it probes | Authority for |
| --- | --- | --- | --- |
| **CreepJS** | **automated** (self-hosted, pinned) | The key spoof-**detector**: catches "lies" (overridden getters, prototype tampering) and compares the **worker** context against the **window** context. | `0 lies` + `worker == window` |
| **pixelscan** | manual | Cross-signal **consistency**: UA vs. real OS, timezone vs. IP, WebGL/fonts vs. claimed platform. Flags contradictions a single-surface test misses. | `no contradictions` |
| **Cover Your Tracks** (EFF) | manual | **Uniqueness / entropy in bits** — how identifying the fingerprint is against EFF's dataset. Measures the uniformization goal directly. | entropy trend (lower is better) |
| **browserleaks** | manual | Per-surface **drill-down** (canvas, WebGL, fonts, WebRTC, audio, JS navigator). Use to attribute *which* surface moved when a headline number changes. | per-surface diagnosis |

Our own page adds a third, automation-agnostic angle: it asserts `worker == window` and
`no contradictions` on our exact signal set, deterministically, without depending on any suite.

## Pass targets

| Target | Where measured | Definition |
| --- | --- | --- |
| **CreepJS: 0 lies** | automated CreepJS pass (`window.Fingerprint.lies.totalLies`) | No detected spoofing lies. An override a detector can *see* is itself entropy. v1 fails this: every overridden surface is a detectable lie. |
| **worker == window** | our page **and** CreepJS worker section | The worker's `WorkerNavigator` / `OffscreenCanvas` report the same values as the page. v1 **fails by design** — the page-world override never reaches workers (ticket #38). The harness records the gap so #38 can close it against a number. |
| **pixelscan: no contradictions** | pixelscan **and** our page's intra-window contradiction check | No signal disagrees with another about the OS (UA vs. `platform` vs. `oscpu` vs. WebGL renderer). The core risk in v1's one-Windows-profile approach on macOS/Linux hosts (ticket #37). |
| **Cover Your Tracks entropy** | Cover Your Tracks | Tracked as a trend, not a hard gate — the goal is fewer identifying bits over the v2 arc. |

## Running the automated harness

Prerequisites: Firefox installed, `npm install` done (pulls `selenium-webdriver` + `geckodriver`).
The first run fetches the pinned CreepJS commit into a gitignored `vendor/creepjs/` (needs network
once; cached after).

```sh
npm run harness            # headless: build, run our page + CreepJS ON/OFF, write the baseline
npm run harness -- --headed    # watch the browser drive itself
npm run harness -- --no-build  # reuse the current dist/ + packaged xpi
npm run harness -- --no-creep  # our page only, skip the CreepJS pass
```

What it does:

1. `npm run build` then `web-ext build` to package the current extension as an `.xpi`.
2. Serves `testpage/` at `http://127.0.0.1:8971/` and the pinned CreepJS at `/creepjs/` (the extension
   only injects on http/https, never `file://`, so a local http origin is mandatory; both pages share
   one origin so the auto-container feature hands the tab off once, not twice).
3. Launches Firefox **twice**: once with **no addon** (the machine's real values), once with the
   extension **installed** (uniformized). It waits until the page's overridden UA proves the extension
   is actually active before recording the ON run, then runs the CreepJS pass in the same container.
4. Reads `window.__HARNESS_RESULT__` (our page) and `window.Fingerprint` (CreepJS) and writes
   [`fingerprint-baseline.json`](./fingerprint-baseline.json) and the marked block in
   [`fingerprint-baseline.md`](./fingerprint-baseline.md).

Env overrides: `FIREFOX_BINARY=/path/to/firefox`, `HARNESS_PORT=8971`.

### CreepJS automation caveat (read the delta, not the absolute)

Selenium/Marionette sets `navigator.webdriver`, which CreepJS detects. It reports that automation as a
separate **`headlessRating` / `stealthRating`**, *not* as lies — so in practice the OFF run shows **0
lies** and the ON lie count is attributable to the extension. Always read the **ON − OFF lie delta**
and treat `headlessRating` as the automation baseline. For an absolute "0 lies" number free of any
automation trace, cross-check with a manual CreepJS run (below) on a normal Firefox profile.

### What our page checks (`testpage/harness.html`)

- **Signal capture** in both contexts: `navigator` (UA, platform, oscpu, language(s),
  hardwareConcurrency, maxTouchPoints, plugins), `screen`, `devicePixelRatio`, timezone + offset,
  canvas readback hash, audio metadata, WebGL vendor/renderer (masked + unmasked).
- **Worker parity** — every signal the worker also reports is compared to the window; mismatches are
  listed. `worker == window` passes only when the list is empty.
- **Contradictions** — coarse OS family derived from UA, `platform`, `oscpu`, and the WebGL renderer;
  any two known-but-disagreeing signals are flagged. This is the local stand-in for pixelscan's
  consistency check. Note it is **intra-window only**: v1 makes the page internally consistent (all
  Windows), so a Windows profile on a macOS/Linux host passes this check but betrays the real OS via
  the **worker parity failure** (the worker is untouched) — and, off-page, via TLS/HTTP that pixelscan
  reads. Read the two checks together.

The page is also human-openable: serve `testpage/` over http and open `harness.html` with the
extension on, then off, to eyeball the table (red rows = worker disagrees with window).

## Manual protocol (external suites)

Run once per build, per OS, on a **real** Firefox profile (not automated — anti-bot will distort a
headless run). For each suite: record with the extension **ON**, then **OFF** for reference.

1. **CreepJS** — <https://abrahamjuliot.github.io/creepjs/>. The automated pass already records lies;
   use a manual run for the authoritative, automation-free number and the worker/window verdict.
2. **pixelscan** — <https://pixelscan.net/fingerprint-check>. Record: "Consistent / Inconsistent"
   verdict and every flagged contradiction. Target: consistent, no contradictions.
3. **Cover Your Tracks** — <https://coveryourtracks.eff.org/>. Click "Test your browser". Record: "one
   in x browsers have this fingerprint" and the bits of identifying information. Track the trend.
4. **browserleaks** — <https://browserleaks.com/> (canvas, webgl, fonts, webrtc, javascript). Use to
   pinpoint which surface changed when a headline number moves.

Record the numbers in [`fingerprint-baseline.md`](./fingerprint-baseline.md) under the matching OS
section. Re-run this whole protocol at the end of each v2 ticket and compare against the baseline.

## OS coverage

The baseline should ideally be captured on **Windows, macOS, and Linux**, because v1's single Windows
profile is consistent on a Windows host but contradictory on macOS/Linux (the #37 correctness fix).
The automated run records whichever OS you run it on; the external-suite tables in the baseline doc
have a section per OS to fill in.

## Vendored CreepJS

The automated CreepJS pass runs a copy pinned to commit
[`10aa6724`](https://github.com/abrahamjuliot/creepjs/commit/10aa6724cd33a1015db1574211890518cd04f0cc)
of [abrahamjuliot/creepjs](https://github.com/abrahamjuliot/creepjs) (MIT). It is fetched on demand
into a gitignored `vendor/creepjs/`, never committed, so the number moves only when *our* extension
changes — not when upstream does. Bump the pin (`CREEP_SHA` in `scripts/fingerprint-harness.mjs`)
deliberately, and re-baseline when you do.
