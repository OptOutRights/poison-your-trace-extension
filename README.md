# Poison your Trace

A Firefox extension that stops your separate activities from being joined back into one identity.

It works as one brick: a single switch. When it is on, every site you visit is opened in its own
container (so cookies and logins never cross between sites) and your browser fingerprint is
uniformized toward one common profile shared by every user of the extension (so the signals a site
reads distinguish no one).

## How it works (for a JavaScript newcomer)

A browser extension is made of small scripts that run in two places. A **background script** runs
once, in the background, for the whole extension: it holds the on and off setting, watches your
navigation, and rewrites request headers. A **content script** runs inside a web page you visit:
here the content scripts read and reshape the page's fingerprint and fill email fields.

Some of that reshaping has to reach the page's own JavaScript, not just the extension. Firefox keeps
a content script in a separate, hidden sandbox (an "isolated world") that the page cannot see. To
override what the site's own code reads (for example `navigator.userAgent` or a canvas readback),
the content script injects a tiny `<script>` into the "page world", the same place the site's
scripts live. That is what "page world injection" means: running our override right next to the
site's code so the site sees the shared value, not your real one.

Finally, one detail that trips people up: the extension **uniformizes** rather than randomizes. A
random fingerprint per site or per visit sounds safer but is worse, because a value nobody else has
is itself a unique label. Instead every user of the extension presents the SAME common profile, so
the crowd blends together and the signals point at no one in particular.

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

## Burner email autofill

On signup and email fields, the extension fills a unique throwaway address for you, so you do not
hand a site your real email. The address is built from two everyday dictionary words plus an optional
number, at the reserved domain `example.invalid`, for example `amber.otter42@example.invalid`.

Why `.invalid`: RFC 2606 and RFC 6761 permanently reserve the `.invalid` top level domain so that it
can never resolve in the global DNS. No one can register it and no mail server can exist under it, so
a burner address there is inert by construction. The extension owns no domain, the address reaches no
real person, and it receives nothing: it is a label, not an inbox.

The address is stable and per site. The same site always gets the same address (so a return visit or
a login still matches), while different sites get different addresses (so two sites cannot use a
shared email to link you). It is derived from the site's registrable domain, so every subdomain of a
site shares one address. The two words are common adjectives and nouns only, never a first or last
name, so the address reads as an anonymous label rather than anything tied to you.

How it is built: `src/email/generator.ts` turns a domain into the address deterministically,
`src/email/store.ts` remembers each site's address in `browser.storage.local` so it stays stable
across visits, and `src/email/autofill.ts` is the content script that finds empty email fields on a
page and fills them (it never overwrites anything you have already typed).

## What the popup shows

Click the toolbar icon to open the popup. At the top is the **Enabled** toggle, the single on and off
switch for every protection. Below it is a plain recap of what is being hidden on the site in the
active tab:

- **This site**: the active container name, and the burner email in use for the site.
- **The fingerprint, before to after**: every in scope signal grouped by category (Navigator,
  Screen, Timezone, Canvas, WebGL, Plugins, Audio, Request headers), each shown as its real value
  "to" the shared common value. Canvas and Audio have no readable value, so they show as "device
  signature" to "neutralized".
- **Not hidden**: the honest gaps, stated plainly (the IP is not hidden, use a VPN or Tor for that;
  email is a burner alias so no mail comes back to you).

Two behaviors to expect:

- **The fingerprint rows fill in after the page loads.** If a tab was already open before you enabled
  the extension (or before it captured anything), the recap may read "Nothing captured yet on this
  tab". Reload the page and the rows appear.
- **The container shows as none at first.** A tab reports "none yet, opens in its own container on
  next load" until the site's per container tab opens on the next navigation. After that the recap
  shows the container name.

## Honest gaps

Being honest about what this does NOT do matters as much as what it does.

- **Your IP address is not hidden.** The extension shows no IP value in its popup and makes no third
  party call to look one up, so it never leaks your address by asking about it. But it also cannot
  change the address a site sees when your browser connects. If you want IP level protection, run a
  VPN or Tor alongside this extension.
- **Email is burner only.** The address the extension fills is a throwaway alias at a domain that
  can never receive mail (see the burner email autofill section above), so no message ever returns to
  you through it. It hides your real address on signup forms; it is not an inbox.
- **The extension uniformizes; it does not randomize.** A shared, common profile is what makes the
  crowd blend together. A random value per site would be a unique label instead, so uniform is the
  goal, not variety.
- **Font metrics are not covered yet.**

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
    report.ts          the before and after capture contract (shape, message tags)
    report-relay.ts    isolated world relay: forwards page world captures to the background
    captures-store.ts  background: per tab before and after snapshot the popup reads
  email/
    generator.ts       derives a site's burner address from its domain (two words plus a number)
    store.ts           remembers each site's burner address in storage so it stays stable
    autofill.ts        content script: fills empty email fields with the site's burner address
testpage/
  fingerprint.html     a standalone page that shows every in scope signal
  fingerprint-test.js  reads the signals and renders them grouped
```

## Before and after captures (for the popup)

Every override, before it replaces a signal, reads the real value the page would have seen and
posts a `{ signal, group, before, after }` entry out of the page world. The relay forwards these to
the background, which keeps the latest snapshot per tab. The popup (ticket #6) reads a tab's
snapshot by sending a runtime message:

```
browser.runtime.sendMessage({ type: "poison:getCaptures", tabId })
// resolves to { captures: SignalCapture[] }
// SignalCapture = { signal, group, before, after }, all strings
```

Signals with no scalar value (canvas, Web Audio) report `before: "device signature"` and
`after: "neutralized"`. The snapshot is cleared when the tab navigates or closes. See `report.ts`
for the full contract.

## Fingerprint test page

Open `testpage/fingerprint.html` directly in Firefox (drag it into a tab, or use a `file://` URL).
It reads every in scope signal and shows what your browser reports right now. With the extension
enabled you see the shared common profile (Windows 10 Firefox 128, UTC, en US, a fixed canvas and
audio hash); with the extension disabled you see your machine's real values. Toggle the extension
from the toolbar and reload the page to compare the two.

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
