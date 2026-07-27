# Poison your Trace

> Firefox MV2 extension that breaks cross-site identity correlation via per-site containers and a **uniformized** (not randomized) browser fingerprint. One config boolean, page-world injection, zero telemetry.

![Firefox 128+](https://img.shields.io/badge/Firefox-128%2B-6b4d21?logo=firefoxbrowser&logoColor=white)
![Manifest V2](https://img.shields.io/badge/Manifest-V2-52525b)
![TypeScript](https://img.shields.io/badge/TypeScript-esbuild-3178c6)
![License Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-0a7d3c)

**[Install the signed release →](https://github.com/OptOutRights/poison-your-trace-web-extension/releases/latest/download/poison-your-trace.xpi)** (auto-updating, installs on stock Firefox)

## Threat model

| Linkage vector | Site sees | Mitigation |
|---|---|---|
| Cookies / storage shared across sites | Third-party cookies follow you across domains | **Per-site containers** — each site gets its own `contextualIdentity`; storage never crosses |
| Fingerprint entropy | Screen, timezone, canvas, WebGL, audio, plugins, UA | **Uniformization** toward one shared profile; you match the crowd rather than carry a unique value |
| Signup email | Your real address on every form | **Burner autofill** — stable per-site alias at reserved `example.invalid` |
| IP address | Your network origin | **Out of scope** — never leaked, but not changed. Layer a VPN/Tor. |

## Why uniformize, not randomize

A random fingerprint per site or per visit sounds safer but is worse: a value nobody else has is itself a unique label. Every user of the extension presents the **same** common profile (`src/fingerprint/profile.ts`), so the crowd blends together and the signals point at no one.

## What is reshaped

`navigator` basics (userAgent, platform, language, languages, hardwareConcurrency, oscpu, appVersion) · `screen` (dimensions, colorDepth, pixelDepth, devicePixelRatio) · timezone (`Intl` zone + `getTimezoneOffset`) · canvas readback · WebGL vendor/renderer · `navigator.plugins`/`mimeTypes` · Web Audio readback · `User-Agent` and `Accept-Language` request headers.

*Font metrics are not covered yet.*

## Architecture

A **background script** holds the single `{ enabled }` config, watches navigation, and rewrites request headers. **Content scripts** run inside each page; to override what the site's *own* JavaScript reads (e.g. `navigator.userAgent`, a canvas readback), a tiny `<script>` is injected into the **page world** next to the site's code. Captures flow page-world → isolated-world relay → background store, which the popup reads for its before/after recap.

```
src/
  background.ts          wires protections on/off from the one config boolean
  config.ts              the single on-device setting: { enabled }
  popup.ts               the toggle behaviour
  containers/
    manager.ts           creates one Firefox container per site
    auto.ts              reopens every navigation in its per-site container
  fingerprint/
    profile.ts           the common profile every user shares
    headers.ts           rewrites User-Agent and Accept-Language
    inject.ts            page-world overrides: navigator, screen, timezone, canvas
    webgl.ts / audio.ts / plugins.ts   further page-world overrides
    report.ts            before/after capture contract (shape, message tags)
    report-relay.ts      isolated-world relay to the background
    captures-store.ts    per-tab snapshots the popup reads
  email/
    generator.ts         derives a burner from the domain (two words + a number)
    store.ts             keeps each site's burner stable in storage
    autofill.ts          fills empty email fields with the site's burner
testpage/
  fingerprint.html       standalone page showing every in-scope signal
```

## Build

Requires Node.js and Firefox.

```bash
npm install
npm run build      # tsc --noEmit, then esbuild bundle → dist/
npm start          # build + web-ext run
npm run lint:ext   # build + web-ext lint --self-hosted
```

Load unpacked: `about:debugging` → This Firefox → Load Temporary Add-on → pick `manifest.json`. (Temporary add-ons unload on restart; use the signed release for a permanent, auto-updating install.)

## Releases

Versions are `MAJOR.MINOR.PATCH`; the source of truth is `manifest.json`'s `version`. Pushing a matching `vX.Y.Z` tag runs `.github/workflows/release.yml`, which verifies tag == manifest version, builds, signs via `web-ext sign --channel=unlisted`, and publishes a GitHub Release with the signed `.xpi` and a regenerated `updates.json`. Installed copies poll that `updates.json` and auto-update.

*Maintainer setup: repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (addons.mozilla.org API credentials) are required before the signing step can run.*

## Docs

**[Beginner's guide](../../docs/beginners-guide.md)** — the full rationale, page-world injection explained, the `.invalid` choice, the capture contract, and reading the fingerprint test page.
