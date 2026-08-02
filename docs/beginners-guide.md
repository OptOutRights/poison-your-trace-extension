# Beginner's guide

An in-depth, beginner-friendly tour of how Poison your Trace works, what it reshapes, and where it is
honest about its limits. If you just want to install and use the extension, the [README](../README.md)
covers that; this guide is for readers who want to understand the how and the why.

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
enabled you see the shared common profile (Windows 10 Firefox 140, UTC, en US, a fixed canvas and
audio hash); with the extension disabled you see your machine's real values. Toggle the extension
from the toolbar and reload the page to compare the two.
