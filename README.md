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
Temporary Add on, and pick `manifest.json`.
