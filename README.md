# Poison your Trace

A Firefox extension that stops your separate activities from being joined back into one identity.

It works as one brick: a single switch. When it is on, every site you visit is opened in its own
container (so cookies and logins never cross between sites) and your browser fingerprint is
uniformized toward one common profile shared by every user of the extension (so the signals a site
reads distinguish no one).

## What is uniformized

When enabled, the extension reshapes these signals toward one shared profile:

- navigator basics: userAgent, platform, language, languages, hardwareConcurrency, oscpu, appVersion
- screen: width, height, availWidth, availHeight, colorDepth, pixelDepth, devicePixelRatio
- timezone: the Intl zone and getTimezoneOffset
- canvas readback
- WebGL vendor and renderer
- navigator plugins and mimeTypes
- Web Audio readback
- the User Agent and Accept Language request headers

Font metrics are not covered yet.

## Honest gaps

- Your IP address is not hidden.
- The extension uniformizes; it does not randomize. A shared, common profile is what makes the
  crowd blend together.

## Layout

```
manifest.json          extension manifest (Firefox MV2)
popup.html             the toolbar popup, one toggle
icons/syringe.svg      the toolbar and addon icon
build.mjs              bundles each entry point into dist/ with esbuild
scripts/
  build-updates-json.mjs   writes the Mozilla AMO update manifest for a release
.github/workflows/
  release.yml          signs and publishes a release when a vX.Y.Z tag is pushed
src/
  background.ts        wires protections on or off from the one config boolean
  config.ts            the single on device setting: { enabled }
  popup.ts             the toggle behaviour
  containers/
    manager.ts         creates one Firefox container per site
    auto.ts            reopens every navigation in its per site container
  fingerprint/
    profile.ts         the common profile every user shares
    headers.ts         rewrites the User Agent and Accept Language headers
    inject.ts          page world overrides: navigator, screen, timezone, canvas
    webgl.ts           page world override: WebGL vendor and renderer
    audio.ts           page world override: Web Audio readback
    plugins.ts         page world override: navigator plugins and mimeTypes
```

## Build and run

You need Node.js and Firefox.

```
npm install
npm run build      # typecheck, then bundle into dist/
npm start          # build, then launch Firefox with the extension loaded (web-ext run)
npm run lint:ext   # build, then run web-ext lint
```

To load it by hand in your normal Firefox, open `about:debugging`, choose This Firefox, then Load
Temporary Add on, and pick `manifest.json`. A temporary add on is unloaded when Firefox restarts,
so use it only for quick development. For a copy that survives restarts and auto updates, install a
signed release (see below).

## Install a signed release (auto updating)

Firefox only auto updates signed extensions, so releases are signed through the addons.mozilla.org
API and self distributed (unlisted). You install the signed xpi once, and every later release lands
automatically.

One time install:

1. Open the latest release: https://github.com/OptOutRights/poison-your-trace-web-extension/releases/latest
2. Download the `.xpi` asset.
3. Drag the `.xpi` file onto a Firefox window (or open it with File, Open File), then confirm the
   install prompt.

That is the only manual step. The installed extension carries an `update_url` pointing at the
release copy of `updates.json`, so Firefox checks it periodically and pulls in newer signed builds
on its own. No reinstall is ever needed for updates.

## How versioning and releases work

Versions follow `MAJOR.MINOR.PATCH`. The single source of truth is the `version` field in
`manifest.json`. A release is cut by tagging that version:

1. Bump `version` in `manifest.json` to the new value (for example `0.2.0`).
2. Commit the bump.
3. Tag the commit with a matching `v` prefix and push the tag:

   ```
   git tag v0.2.0
   git push origin v0.2.0
   ```

Pushing a `vX.Y.Z` tag runs the release workflow (`.github/workflows/release.yml`). The workflow
checks the tag against the manifest version (and fails if they disagree), builds the extension,
signs it with `web-ext sign --channel=unlisted`, then publishes a GitHub Release for the tag. It
attaches two assets: the signed `.xpi` and a freshly generated `updates.json`. Because the extension
polls the latest release copy of `updates.json`, already installed copies auto update to the new
`.xpi`.

### Maintainer setup (required once)

The signing step reads addons.mozilla.org API credentials from two repository secrets. A maintainer
must add both under Settings, Secrets and variables, Actions before the pipeline can sign:

- `AMO_JWT_ISSUER`: the JWT issuer from the addons.mozilla.org API credentials page.
- `AMO_JWT_SECRET`: the matching JWT secret.

Until both secrets exist, the release workflow stops at the signing step with a clear message.
