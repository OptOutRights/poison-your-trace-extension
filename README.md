<div align="center">

<img src="icons/firesnake-512.png" width="96" alt="Poison your Trace" />

# Poison your Trace

### Free yourself from constant web tracking.
#### You're not you. You are everyone. 

One switch. Every site gets its own container, and Firefox's own fingerprint protection makes your browser report common values shared by a crowd, so you're not the one anyone is looking at.

<br/>

<!-- TODO(store): replace <slug> below once the addons.mozilla.org listing is created (see docs/store-migration.md). -->
[![Install for Firefox](https://img.shields.io/badge/Install%20for-Firefox-0a7d3c?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/poison-your-trace/)

![Firefox 140+](https://img.shields.io/badge/Firefox-140%2B-6b4d21?logo=firefoxbrowser&logoColor=white)
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

## Install

Poison your Trace is on the official Firefox Add-ons store, so **anyone can install it on stock Firefox**.

1. Open the listing in Firefox:
   **[Poison your Trace on Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/poison-your-trace/)**.
2. Click **Add to Firefox**, then **Add**.

If something goes wrong, contact: poisonyourtrace@optoutrights.org.

Firefox keeps the extension up to date automatically from addons.mozilla.org. Install once, forget about it.


## What it does

Poison your Trace ships as one brick: a single on/off switch arms everything. Under it, a **Details** disclosure lets you turn any one protection off (useful if a site breaks) without losing the rest. Everything defaults on.

| | |
|---|---|
| **Per-site containers** | Every site opens in its own Firefox container. Cookies and logins never cross between sites. |
| **Uniformized fingerprint** | Firefox's built-in Resist Fingerprinting (RFP) reshapes what a site can measure (canvas, screen, timezone, processor cores, audio, fonts and more) toward *one common profile* many users share. Values are not randomized per site: you become part of a crowd. |
| **Privacy switches** | WebRTC is stopped from leaking your real or local IP, tracking protection is forced on everywhere, hyperlink-auditing beacons are killed, and speculative network prediction is turned off. |
| **Burner email** | Right-click any email field and pick **Insert a throwaway email** to fill it with a stable, per-site alias at `example.invalid`. Your real address never leaves your keyboard. |

Poison your Trace does not run its own fingerprint engine. It turns on protections Firefox already ships but leaves off by default, so the values a site sees come from the browser itself and stay consistent all the way down the stack.

> **Why uniformize, not randomize?** A random value nobody else has is itself a unique label. Presenting the *same* common profile as every other user is what actually makes you disappear.


## Current limitations

- **Your IP address is not hidden.** The extension never leaks it, but it can't change what a site sees. Pair it with a VPN or Tor for IP-level cover.
- **Your OS family stays visible.** The browser still reports whether you are on Mac, Windows or Linux. Everything else in that label is already common to everyone on your Firefox version.
- **Some friction sign-ups and sign-ins.** You may occasionally experience difficulty signing up or signing in. Try temporarily deactivating the extension for that site, then try again. We are working to improve this.
- **The burner email only sends, it never receives.** For a signup that must receive mail, the popup can hand off to Firefox Relay, which gives you a real masked address.

## Build from source

You need Node.js and Firefox.

```bash
npm install
npm run build      # typecheck, then bundle into dist/
npm start          # build + launch Firefox with the extension loaded
npm run lint:ext   # build + web-ext lint (validates as a listed store add-on)
```

To load it by hand: open `about:debugging` > **This Firefox** > **Load Temporary Add-on**, and pick `manifest.json`. A temporary add-on unloads when Firefox restarts, so use it only for quick development. The store version above is the permanent, auto-updating path.

---

### Architecture

A single **background script** is the only control point. It reads the on-device config and, for each protection, either flips the matching Firefox `privacy.*` setting on or clears it back to your own preference. Fingerprint uniformization is `privacy.websites.resistFingerprinting`, so there is no in-page script rewriting `navigator` or canvas: the browser reshapes those values itself, in every world, before a site can read them. The only mechanisms that live inside the extension are the per-site containers and the on-demand burner email. The popup writes the config and asks the background to re-apply it.

```
manifest.json          extension manifest (Firefox MV2)
popup.html / popup.css the toolbar popup: one hero toggle + a per-protection Details panel
about.html / about.css the "How it works" page linked from the popup
build.mjs              bundles each entry point into dist/ with esbuild
src/
  background.ts        the single control point: applies every protection from the config
  config.ts            the on-device config: { enabled, protections }
  popup.ts             the popup toggles and their wiring
  containers/
    manager.ts         creates one Firefox container per site
    auto.ts            reopens every navigation in its per-site container
  email/
    generator.ts       derives a burner alias from the domain (two words + a number)
    store.ts           keeps each site's burner stable in storage
    insert.ts          content script: fills the right-clicked field with the burner
testpage/
  fingerprint.html     a standalone page that shows every in-scope signal
```

### Releases

Versions are `MAJOR.MINOR.PATCH`; the single source of truth is the `version` field in `manifest.json`. Pushing a matching `vX.Y.Z` tag runs `.github/workflows/release.yml`, which verifies tag == manifest version, builds, and submits the version to addons.mozilla.org with `web-ext sign --channel=listed`. Once Mozilla approves it, every installed copy auto-updates from the store: no `updates.json`, no reinstall. The workflow also publishes a minimal GitHub Release carrying the source zip that AMO reviewers may request.

> **Maintainer setup (once):** the submit step reads addons.mozilla.org API credentials from two repository secrets, `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, belonging to the account that owns the store listing. Until both exist, the release workflow stops at the submit step with a clear message. See [docs/store-migration.md](docs/store-migration.md) for the one-time AMO setup.

Local testing needs no store round-trip: `npm start` loads the extension into a throwaway Firefox instantly, and `about:debugging > Load Temporary Add-on` works too. `npm run sign` produces an instantly-signed unlisted `.xpi` if you want to test the signed-install flow on stock Firefox (use a throwaway version number, since a version can live in only one AMO channel).

<div align="center">
<sub>Built by <a href="https://github.com/OptOutRights">OptOutRights</a> with <a href="https://github.com/mh2d">MH2D</a> · Apache-2.0 · No tracking, no telemetry, no accounts.</sub>
</div>
</content>
</invoke>
