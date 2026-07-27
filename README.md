<div align="center">

<img src="icons/seringuewhite-512.png" width="96" alt="Poison your Trace" />

# Poison your Trace

### Stop your separate activities from being joined into one identity.

One switch. Every site gets its own container, and your browser fingerprint is uniformized toward a profile shared by every user of the extension — so the signals a site reads point at no one.

<br/>

[![Install for Firefox](https://img.shields.io/badge/Install%20for-Firefox-0a7d3c?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://github.com/OptOutRights/poison-your-trace-web-extension/releases/latest/download/poison-your-trace.xpi)

![Firefox 128+](https://img.shields.io/badge/Firefox-128%2B-6b4d21?logo=firefoxbrowser&logoColor=white)
![Manifest V2](https://img.shields.io/badge/Manifest-V2-52525b)
![License Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-0a7d3c)
![No telemetry](https://img.shields.io/badge/telemetry-none-0a7d3c)

</div>

---

<!-- TODO(screenshot): drop the toolbar popup PNG at docs/screenshots/popup.png, then uncomment.
<div align="center">

<img src="docs/screenshots/popup.png" width="320" alt="The toolbar popup: a single Enabled toggle and a recap of what the active site sees" />

<em>One toggle. A plain recap of what's being hidden on the site you're on.</em>

</div>
-->

## Why you'd want it

Sites don't just watch you on their page — they stitch your activity across the web into a single profile using cookies that follow you and a **fingerprint** built from your screen, timezone, fonts, graphics card, and dozens of other quiet signals. Poison your Trace breaks both joins at once.

## What it does

| | |
|---|---|
| 🧫 **Per-site containers** | Every site opens in its own Firefox container. Cookies and logins never cross between sites. |
| 🌫️ **Uniformized fingerprint** | Navigator, screen, timezone, canvas, WebGL, plugins, Web Audio, User-Agent and Accept-Language are reshaped toward *one shared profile* — not randomized per site. You blend into the crowd instead of standing out. |
| 📮 **Burner email autofill** | Empty email fields get a unique, stable, per-site throwaway alias at `example.invalid`. Your real address never leaves your keyboard. |
| 🎚️ **A single switch** | One **Enabled** toggle turns every protection on or off. No dashboards, no dials. |

> **Why uniformize, not randomize?** A random value nobody else has is itself a unique label. Presenting the *same* common profile as every other user is what actually makes you disappear.

## Install (30 seconds, any Firefox)

The release is signed by addons.mozilla.org, so **anyone can install it on stock Firefox** — no developer mode, nothing from the maintainer.

1. Open the permanent install link in Firefox:
   **[poison-your-trace.xpi](https://github.com/OptOutRights/poison-your-trace-web-extension/releases/latest/download/poison-your-trace.xpi)**
2. Firefox offers to add it — click **Add**.

That link always points at the newest signed release, and the extension auto-updates itself from there. Install once, forget about it.

## Honest gaps

We'd rather tell you what this *doesn't* do.

- **Your IP address is not hidden.** The extension never leaks it, but it can't change what a site sees. Pair it with a VPN or Tor for IP-level cover.
- **Email is burner-only.** The alias is inert and receives nothing — it hides your address on signup forms; it is not an inbox.
- **Font metrics aren't covered yet.**

## Build from source

You need Node.js and Firefox.

```bash
npm install
npm run build      # typecheck, then bundle into dist/
npm start          # build + launch Firefox with the extension loaded
npm run lint:ext   # build + web-ext lint --self-hosted
```

To load it by hand: open `about:debugging` → **This Firefox** → **Load Temporary Add-on**, and pick `manifest.json`. A temporary add-on unloads when Firefox restarts, so use it only for quick development — the signed release above is the permanent, auto-updating path.

---

## Under the hood

For the full narrative — why uniformize over randomize, how page-world injection works, why `.invalid`, and the honest gaps in depth — see the **[beginner's guide](docs/beginners-guide.md)**. The essentials:

### Threat model

| Linkage vector | What a site sees | Mitigation |
|---|---|---|
| Cookies / storage shared across sites | Third-party cookies follow you across domains | **Per-site containers** — each site gets its own `contextualIdentity`; storage never crosses |
| Fingerprint entropy | Screen, timezone, canvas, WebGL, audio, plugins, UA | **Uniformization** toward one shared profile; you match the crowd rather than carry a unique value |
| Signup email | Your real address on every form | **Burner autofill** — a stable per-site alias at the reserved `example.invalid` |
| IP address | Your network origin | **Out of scope** — never leaked, but not changed. Layer a VPN or Tor. |

### What is reshaped

`navigator` basics (userAgent, platform, language, languages, hardwareConcurrency, oscpu, appVersion) · `screen` (dimensions, colorDepth, pixelDepth, devicePixelRatio) · timezone (`Intl` zone + `getTimezoneOffset`) · canvas readback · WebGL vendor/renderer · `navigator.plugins`/`mimeTypes` · Web Audio readback · `User-Agent` and `Accept-Language` request headers. *Font metrics are not covered yet.*

### Architecture

A **background script** holds the single `{ enabled }` config, watches navigation, and rewrites request headers. **Content scripts** run inside each page; to override what a site's *own* JavaScript reads (e.g. `navigator.userAgent`, a canvas readback), a tiny `<script>` is injected into the **page world** next to the site's code. Captures flow page-world → isolated-world relay → background store, which the popup reads for its before/after recap.

```
manifest.json          extension manifest (Firefox MV2)
popup.html             the toolbar popup, one toggle
build.mjs              bundles each entry point into dist/ with esbuild
src/
  background.ts        wires protections on/off from the one config boolean
  config.ts            the single on-device setting: { enabled }
  popup.ts             the toggle behaviour
  containers/
    manager.ts         creates one Firefox container per site
    auto.ts            reopens every navigation in its per-site container
  fingerprint/
    profile.ts         the common profile every user shares
    headers.ts         rewrites the User-Agent and Accept-Language headers
    inject.ts          page-world overrides: navigator, screen, timezone, canvas
    webgl.ts           page-world override: WebGL vendor and renderer
    audio.ts           page-world override: Web Audio readback
    plugins.ts         page-world override: navigator plugins and mimeTypes
    report.ts          the before/after capture contract (shape, message tags)
    report-relay.ts    isolated-world relay: forwards captures to the background
    captures-store.ts  background: per-tab snapshots the popup reads
  email/
    generator.ts       derives a burner from the domain (two words + a number)
    store.ts           keeps each site's burner stable in storage
    autofill.ts        content script: fills empty email fields with the burner
testpage/
  fingerprint.html     a standalone page that shows every in-scope signal
```

### Releases

Versions are `MAJOR.MINOR.PATCH`; the single source of truth is the `version` field in `manifest.json`. Pushing a matching `vX.Y.Z` tag runs `.github/workflows/release.yml`, which verifies tag == manifest version, builds, signs with `web-ext sign --channel=unlisted`, and publishes a GitHub Release carrying the signed `.xpi` and a freshly generated `updates.json`. Installed copies poll that `updates.json` and auto-update — no reinstall is ever needed.

> **Maintainer setup (once):** the signing step reads addons.mozilla.org API credentials from two repository secrets — `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Until both exist, the release workflow stops at the signing step with a clear message.

<div align="center">
<sub>Built by <a href="https://github.com/OptOutRights">OptOutRights</a> · Apache-2.0 · No tracking, no telemetry, no accounts.</sub>
</div>
