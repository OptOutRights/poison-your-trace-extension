<div align="center">

<img src="icons/seringuewhite-512.png" width="96" alt="Poison your Trace" />

# Poison your Trace

### Free yourself from constant web tracking.
#### You're not you. You are everyone. 

One switch. Every site gets its own container, and your browser fingerprint is uniformized toward a profile shared by every user of the extension, you're part of the crowd.

<br/>

[![Install for Firefox](https://img.shields.io/badge/Install%20for-Firefox-0a7d3c?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://github.com/OptOutRights/poison-your-trace-web-extension/releases/latest/download/poison-your-trace.xpi)

![Firefox 128+](https://img.shields.io/badge/Firefox-128%2B-6b4d21?logo=firefoxbrowser&logoColor=white)
![Manifest V2](https://img.shields.io/badge/Manifest-V2-52525b)
![License Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-0a7d3c)

</div>

---

<!-- TODO(screenshot): drop the toolbar popup PNG at docs/screenshots/popup.png, then uncomment.
<div align="center">

<img src="docs/screenshots/popup.png" width="320" alt="The toolbar popup: a single Enabled toggle and a recap of what the active site sees" />

<em>One toggle. A plain recap of what's being hidden on the site you're on.</em>

</div>
-->

## The purpose

Websites collect and sell your activity across the web to form a single profile of you and follow you everywhere you go. For this, some ways they use are:
- cookies that follow you 
- **your fingerprint** built from your screen, timezone, fonts, graphics card, and dozens of other quiet signals. 

Poison your Trace neutralizes both joins at once.

## Install (30 seconds, any Firefox)

The release is signed by addons.mozilla.org, so **anyone can install it on stock Firefox**: no developer mode needed.

1. Open the permanent install link in Firefox:
   **[poison-your-trace.xpi](https://github.com/OptOutRights/poison-your-trace-web-extension/releases/latest/download/poison-your-trace.xpi)**.
   Click normally, if you cmd+click to open the link it might fail.
2. Firefox offers to add it: click **Add**.

If it doesn't work, you can try to copy the link and paste it manually, and press 1 or 2 times enter, or contact: mh2d.projets@gmail.com.

That link always points at the newest signed release, and the extension auto-updates itself from there. Install once, forget about it.


## What it does

| | |
|---|---|
| **Per-site containers** | Every site opens in its own Firefox container. Cookies and logins never cross between sites. |
| **Uniformized fingerprint** | Navigator, screen, timezone, canvas, WebGL, plugins, Web Audio, User-Agent and Accept-Language are reshaped toward *one shared profile*. They are not randomized per site. Be part of the big crowd |
| **Burner email autofill** | Empty email fields get a unique, stable, per-site throwaway alias at `example.invalid`. Your real address never leaves your keyboard. |

> **Why uniformize, not randomize?** A random value nobody else has is itself a unique label. Presenting the *same* common profile as every other user is what actually makes you disappear.


## Current limitations

- **Your IP address is not hidden.** The extension never leaks it, but it can't change what a site sees. Pair it with a VPN or Tor for IP-level cover.
- **Some friction sign-ups and sign-ins.** it might happen that you struggle sometimes a bit to sign-up. Try deactivating the extension for the URL and try again. We are working on it. 
- **Font metrics aren't covered yet.**

## Build from source

You need Node.js and Firefox.

```bash
npm install
npm run build      # typecheck, then bundle into dist/
npm start          # build + launch Firefox with the extension loaded
npm run lint:ext   # build + web-ext lint --self-hosted
```

To load it by hand: open `about:debugging` → **This Firefox** → **Load Temporary Add-on**, and pick `manifest.json`. A temporary add-on unloads when Firefox restarts, so use it only for quick development. The signed release above is the permanent, auto-updating path.

---

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
<sub>Built by <a href="https://github.com/OptOutRights">OptOutRights</a> with <a href="https://github.com/mh2d">MH2D</a> · Apache-2.0 · No tracking, no telemetry, no accounts.</sub>
</div>
