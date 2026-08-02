# Robustness improvements research

## Executive summary

Poison your Trace already covers the highest-entropy JavaScript surfaces (UA, screen, timezone,
canvas, WebGL, audio, plugins) plus the network User-Agent / Accept-Language headers. That is a real
baseline, but the current build has three classes of gap that let a determined tracker re-identify a
user anyway: **(a) surfaces with real entropy that are not touched yet** (fonts, `Intl` locale,
`enumerateDevices`, `matchMedia` media features, `maxTouchPoints`, `speechSynthesis`, ClientRects,
AudioContext metadata); **(b) whole execution contexts the page-world `<script>` never reaches** —
Web Workers / Service Workers have their own `WorkerNavigator` and `OffscreenCanvas`, and a strict
page CSP silently blocks the inline `<script>` injection entirely in Firefox; and **(c) a
consistency risk baked into the design** — giving every user a *Windows* profile while their real OS
is macOS or Linux introduces contradictions (font list, WebGL renderer, TLS/JA3, HTTP/2, TCP/IP) that
a spoof-detector reads as a *lie*, and the set of lies is itself a stable identifier.

The single most important finding is that **Firefox already reversed the exact decision this
extension made.** After shipping Windows-UA spoofing in `resistFingerprinting`, Mozilla removed it
and now reveals the *real* OS, because "trying to hide the operating system is really hard" — TCP/IP
stack fingerprinting exposes the spoofed UA regardless (primary:
<https://bugzilla.mozilla.org/show_bug.cgi?id=1404608>; follow-on:
<https://bugzilla.mozilla.org/show_bug.cgi?id=1409269>). A WebExtension controls even *fewer* layers
than Firefox itself (it cannot touch TLS or HTTP/2), so the one-Windows-profile approach gets the
*cost* of OS spoofing without a compensating benefit. The recommendation is to **keep the real OS
family and uniformize within it.**

The second most important finding: **an extension can turn on Firefox's own RFP** via
`browser.privacy.websites.resistFingerprinting` (a real, settable `privacy.websites` property; the
capability landed in Firefox 58, primary: <https://bugzilla.mozilla.org/show_bug.cgi?id=1397611>).
That does not replace this project — RFP is heavy-handed and Mozilla discourages it for typical users
— but it is a lever worth offering, and it covers workers, CSP pages, TLS-consistent OS, timers, and
fonts that a content script cannot cleanly reach.

### Ranked shortlist (top 7 by impact)

1. **Fix the CSP-blocked / worker-blind injection architecture** — move page-world overrides off the
   inline `<script>` (which strict-CSP pages block in Firefox) onto `world: "MAIN"` content scripts
   (Firefox 128+, works in MV2), and add worker/`OffscreenCanvas` coverage. Without this, an unknown
   fraction of the highest-value sites get *zero* JS protection and every worker leaks the real values.
2. **Resolve the one-Windows-profile consistency risk** — keep the real OS family; stop presenting a
   Windows UA/WebGL string to macOS/Linux users. This is a correctness fix, not an addition.
3. **Add fonts + `Intl` locale + `matchMedia` media features** — the three largest untouched
   entropy sources; fonts alone are ~10+ bits and directly betray the real OS.
4. **Cover `MediaDevices.enumerateDevices`, `maxTouchPoints`, `speechSynthesis.getVoices`,
   `mediaCapabilities`, `pdfViewerEnabled`, AudioContext metadata** — cheap page-world prototype
   overrides for real (if smaller) entropy.
5. **Close the WebRTC IP leak** via `browser.privacy.network` — the still-open item from the IP
   research; a uniformized fingerprint is undone by a STUN leak of the real IP.
6. **Offer optional Firefox RFP passthrough** via `browser.privacy.websites.resistFingerprinting`,
   and lean on Firefox's already-default Total Cookie Protection / query-stripping / referrer trimming
   rather than reimplementing them.
7. **Build a regression harness** against CreepJS and pixelscan (spoof-*detectors*), not only Cover
   Your Tracks / amiunique (uniqueness *measurers*) — because the current design's biggest weakness
   (inconsistency, worker leakage) is exactly what CreepJS is built to catch.

---

## 1. Architecture: the injection is CSP-fragile and worker-blind

This is first because it caps the value of *everything else*: on the sites where it fails, none of
the other overrides apply.

**Strict CSP silently disables the inline `<script>` injection in Firefox.** All five fingerprint
scripts (`inject.ts`, `webgl.ts`, `audio.ts`, `plugins.ts`) inject by creating a `<script>` element
and setting `textContent`, then prepending it. Unlike Chrome, **Firefox applies the page's CSP to DOM
content inserted by content scripts**, so an inline script on a page whose CSP lacks `'unsafe-inline'`
does not execute (primary: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_Security_Policy>
— "most DOM-based APIs are subjected to the CSP of the web page"). The underlying meta-bug asking
Firefox to exempt content-script-inserted content from page CSP has been open for a decade and is
still unresolved (primary: <https://bugzilla.mozilla.org/show_bug.cgi?id=1267027>). The code's own
comments already flag this seam. The consequence is that on exactly the security-conscious, high-value
sites most likely to run a strict CSP (banks, large SaaS), the JS-layer protection is off and only
the header rewrite survives.

**Fix:** replace the manual `<script>` injection with **`world: "MAIN"` content scripts**, added in
**Firefox 128** for both `manifest.json` `content_scripts` and `scripting.executeScript`, and
**explicitly supported in Firefox MV2 as well as MV3** (primary:
<https://blog.mozilla.org/addons/2024/07/10/manifest-v3-updates-landed-in-firefox-128/>). A MAIN-world
content script runs directly in the page realm without being loaded as an inline `<script>` element,
so it never goes through the CSP script-source check. The manifest's `strict_min_version` is already
`140.0`, well above 128, so this is available today. (Trade-off: MAIN-world scripts have no access to
WebExtension APIs — but these overrides don't use any; they only `postMessage` to the isolated relay,
which still works.) The `contentScripts.register` path can pass `world: "MAIN"`; note the runtime
registration also carries a small timing race versus a static `content_scripts` declaration, so the
most reliable document_start ordering comes from declaring the MAIN-world scripts statically in the
manifest (primary on registration semantics:
<https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/contentScripts/register>).
An alternative that also sidesteps CSP without page-world injection is manipulating
`window.wrappedJSObject` with `exportFunction`/`cloneInto` directly from the isolated content script
(primary: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts>);
`world: "MAIN"` is simpler and keeps the existing `pageWorldOverride` bodies mostly intact.

**Workers and OffscreenCanvas are entirely uncovered.** A Web Worker / Service Worker has its *own*
global scope with a separate `WorkerNavigator` object — not the `Navigator` on `window` that
`inject.ts` patches — so `WorkerNavigator.userAgent`, `.hardwareConcurrency`, `.languages` and
`OffscreenCanvas`-based canvas/WebGL readback all return the *real* device values from inside a worker
(primary: <https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator>;
<https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope>;
<https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas>). A page-world override of `window`
does not propagate into a worker realm, and there is no simple content-script hook into worker globals
— covering them requires wrapping the `Worker`/`SharedWorker` constructor to prepend the overrides to
the worker source, which brings its own `worker-src`/blob-URL and CSP complications (illustrative
prior art on the difficulty: <https://github.com/freethenation/DFPM/issues/10>). This matters because
**CreepJS specifically re-runs its probes inside a worker and compares them to the window scope** —
window-only spoofing produces a *mismatch* that is itself a stable identifier (see §6).

**iframes:** the fingerprint scripts must be registered with `all_frames: true` to cover ad/tracker
iframes, and `match_about_blank: true` for `about:blank`/`srcdoc` frames — but Firefox additionally
"won't inject into empty iframes at `document_start`," so `srcdoc` and dynamically-created blank
frames remain a partial hole (primary:
<https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts>).
Worth verifying the current registration sets both flags.

**MV2 migration is NOT urgent for Firefox.** Unlike Chrome, **Mozilla will keep supporting MV2
alongside MV3 and keeps blocking `webRequest`** — so the `headers.ts` blocking rewrite does not have
to move to `declarativeNetRequest` even after an eventual MV3 move (primary:
<https://blog.mozilla.org/en/firefox/firefox-manifest-v3-adblockers/> — "Firefox will continue to
support both blockingWebRequest and declarativeNetRequest"). DNR `modifyHeaders` exists as an
option but is not required (primary:
<https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/ModifyHeaderInfo>).
This is settled context, not a priority.

**Feasibility:** high. `world: "MAIN"` is a manifest/registration change plus keeping the existing
override bodies. Worker coverage is the harder part and can be a second phase.

---

## 2. Consistency risk: one Windows profile for everyone (the central design question)

**Recommendation up front: keep the user's real OS family; do not present a Windows profile to
macOS/Linux users.** The current `COMMON_PROFILE` hard-codes a Windows 10 UA, `Win32` platform,
`Windows NT 10.0; Win64; x64` oscpu, and a Direct3D/ANGLE WebGL renderer for *every* user. On a
Windows machine that is fine. On a Mac or Linux box it manufactures contradictions across layers the
extension cannot reach, and detectors specifically hunt for those contradictions.

The decisive evidence is that **Mozilla already tried this and reversed it.** `resistFingerprinting`
originally spoofed the OS to Windows; Mozilla removed OS spoofing and now reports the real OS family,
because "trying to hide the operating system is really hard" — the OS is exposed through TCP/IP stack
analysis regardless, making the spoofed UA inconsistent, and universal Windows spoofing also broke
sites (primary: <https://bugzilla.mozilla.org/show_bug.cgi?id=1404608>, RESOLVED FIXED). The
follow-on bug is literally this scenario: "spoofed useragent from privacy.resistfingerprinting
conflicts with OS revealed by TCP/IP fingerprinting … By restricting the default useragent to
Windows, TCP/IP fingerprinting easily reveals the spoofed useragent" (primary:
<https://bugzilla.mozilla.org/show_bug.cgi?id=1409269>).

The cross-checks a detector applies:

- **Fonts betray the real OS.** Each OS ships a distinct default font catalog (Windows: Segoe UI,
  Calibri, Cambria; macOS: Helvetica Neue / San Francisco; Linux: DejaVu, Liberation). A page that
  claims Windows but whose font enumeration exposes macOS-only fonts is caught — font detection alone
  is ~10+ bits (primary reference for font-detection entropy and per-surface testing:
  <https://browserleaks.com/fonts>; the OS-mismatch principle — a profile that "claim[s] to be a
  Windows desktop, while the host machine exposes Linux-style font behavior" is detectable — is
  documented at <https://botbrowser.io/en/blog/font-fingerprinting/>). Because this extension does
  **not** cover fonts yet (README and `beginners-guide.md` both admit it), the real macOS/Linux font
  list is fully visible *and* contradicts the Windows UA.
- **WebGL renderer betrays the real GPU stack.** `UNMASKED_RENDERER_WEBGL` reflects the actual
  graphics subsystem: on Windows, ANGLE→Direct3D; on macOS, Metal/Apple GPU; on Linux, OpenGL. The
  extension currently forces the Direct3D ANGLE string for everyone, which on a Mac contradicts the
  real Metal/Apple renderer that leaks through other paths, and detectors flag exactly this ("GPU
  linked to Mac but OS in user agent is not Mac") (primary/technical:
  <https://blog.castle.io/the-role-of-webgl-renderer-in-browser-fingerprinting/>).
- **platform / oscpu / UA are cross-checked.** Reverse-engineering of a real production detector
  (LinkedIn's `getHasLiedOs`) shows it compares `navigator.userAgent` OS keywords against
  `navigator.platform` and `navigator.oscpu` and flags mismatches, with the explicit rationale that
  "once you start lying about one thing, you often forget to lie consistently about everything else"
  (technical writeup:
  <https://securityboulevard.com/2026/01/detecting-forged-browser-fingerprints-for-bot-detection-lessons-from-linkedin/>).
- **TLS (JA3/JA4) and HTTP/2 fingerprints cannot be changed by a WebExtension** and are fixed by the
  real Firefox build/OS. A spoofed Windows UA over a macOS-built Firefox's TLS ClientHello and HTTP/2
  SETTINGS is a server-visible contradiction: "JavaScript and extensions operate at the application
  layer above HTTP/2, so they cannot modify these protocol-level fingerprint components" (primary
  technical: <https://lwthiker.com/networks/2022/06/17/http2-fingerprinting.html>; JA3/JA4 background:
  <https://engineering.salesforce.com/tls-fingerprinting-with-ja3-and-ja3s-247362855967/>). This is
  the same reason Mozilla gave in bug 1409269.
- **Timezone/locale vs IP.** Forcing every user to `UTC` / `en-US` while they browse from, say, a
  French residential IP is itself a flaggable mismatch; anti-fraud vendors expose `timezone_mismatch`
  / `os_mismatch` signals for exactly this (vendor reference:
  <https://docs.fingerprint.com/docs/smart-signals-reference>).

Even **Tor Browser is moving away from blanket Windows spoofing**: Tor Browser 14.0 added
`privacy.resistFingerprinting.spoofOsInUserAgentHeader`, and when off it reports the real OS family,
because asymmetric OS spoofing "causes website breakage seemingly due to bot-detection scripts" for
"only a negligible amount of benefit" (primary discussion:
<https://gitlab.torproject.org/tpo/applications/tor-browser/-/issues/42111>; corroborated on tor-dev:
<https://lists.torproject.org/mailman3/hyperkitty/list/tor-dev@lists.torproject.org/thread/QWFGPSVH2ZRB4BRCB3EHEIHKFP5MNLSZ/>).
Crucially, Tor can afford a foreign-OS header *only because* it also controls the network path and
ships one identical binary to a large anonymity set; a WebExtension controls neither the network
layer nor the binary, so it pays the mismatch cost with none of Tor's compensating uniformity.

**Concrete direction:** turn `COMMON_PROFILE` into a small set of profiles keyed by real OS family —
detect the OS from the *real* `navigator.platform`/`oscpu` before overriding, then pick the common
Windows / macOS / Linux profile (common UA version, common screen bucket, common per-OS WebGL renderer
string, per-OS font uniformization target). Keep the uniformization philosophy — one common value per
OS crowd — but never lie *across* OS. This directly mirrors what RFP's platform-specific spoofing does
(four OS families, per bug 1404608). Timezone/locale: consider whether forcing UTC/en-US is net
positive given the IP-mismatch signal; a defensible alternative is to uniformize language to a common
value but leave timezone matching the real locale, or gate the UTC choice behind "user also runs
Tor/VPN." (Left as an open product decision — flagged, not resolved here.)

**Trade-off:** more profiles means a smaller crowd *per* profile than one giant crowd. But the
one-giant-crowd only exists in theory: in practice the Windows profile on a Mac is not *in* the
Windows crowd because the mismatch signals eject it into a tiny "spoofed" bucket. Real per-OS crowds
are larger and more stable than one detectably-fake crowd.

---

## 3. Fonts, `Intl` locale, and `matchMedia` media features — the largest untouched entropy

These three are grouped because together they are the biggest remaining *measurable* entropy and the
biggest OS-mismatch amplifiers.

**Fonts (~10+ bits, admitted gap).** Trackers enumerate installed fonts by rendering text in a named
font and measuring `measureText()` / `getBoundingClientRect()` fallback dimensions; FingerprintJS
documents detecting hundreds of fonts this way (primary:
<https://github.com/fingerprintjs/fingerprintjs>; EFF lists fonts among its core metrics:
<https://coveryourtracks.eff.org/about>). Firefox's own RFP restricts font visibility to a base
system set (shipped FF80, primary: <https://bugzilla.mozilla.org/show_bug.cgi?id=1653987>); Firefox
declined to bundle a Tor-style whitelist (primary WONTFIX:
<https://bugzilla.mozilla.org/show_bug.cgi?id=1336208>). From a content script you cannot change which
fonts are actually installed, but you *can* override `CanvasRenderingContext2D.prototype.measureText`
and the geometry accessors to report metrics for only a fixed, common per-OS font set — imperfect
(many measurement paths) but it removes the crude enumeration and, combined with §2, stops the font
list from contradicting the OS. The cleaner native fix is RFP font-visibility (§6).

**`Intl` locale leaks.** `resolvedOptions()` on `Intl.DateTimeFormat` / `Collator` / `NumberFormat` /
`Segmenter` exposes `locale`, `calendar`, `numberingSystem`, and `timeZone` (primary:
<https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/resolvedOptions>).
`inject.ts` already patches `Intl.DateTimeFormat.prototype.resolvedOptions` for `timeZone` only — it
should also normalize `locale` (and the same on `Collator`/`NumberFormat`) to `en-US` to match the
spoofed `navigator.language`, otherwise a French `Intl` locale contradicts an `en-US` navigator.
`Intl.Segmenter` shipped in Firefox 125 and is in scope (primary:
<https://caniuse.com/mdn-javascript_builtins_intl_segmenter>). All spoofable via page-world prototype
override.

**`matchMedia` media features.** `prefers-color-scheme` (OS theme bit), `prefers-reduced-motion` and
`prefers-contrast` (accessibility bits), and `resolution` (DPI/zoom, high entropy on HiDPI) all leak
through `matchMedia` (primary:
<https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme>;
<https://developer.mozilla.org/en-US/docs/Web/CSS/@media/resolution>). RFP normalizes all of these
(color-scheme→light, reduced-motion/contrast→no-preference). From a content script you can override
`window.matchMedia` / `MediaQueryList` to report uniform values — **but with an important limitation:
CSS `@media` rule evaluation and `getComputedStyle` are NOT interceptable from JS**, so a detector
that gates a style on `@media (prefers-color-scheme: dark)` and reads it back via `getComputedStyle`
will see the *real* preference even after you spoof `matchMedia`. This is a genuine partial gap; the
only complete fix is RFP. Spoof `matchMedia` for the common JS path, and document the CSS blind spot.

**Feasibility:** high for the JS paths (prototype overrides, same pattern as existing code); partial
because of the CSS-side blind spots on fonts and media features.

---

## 4. Cheap, clean page-world overrides worth adding

Each of these is a small prototype override in the page world (same mechanism as the existing scripts)
carrying real, if smaller, entropy. Group them into `inject.ts` or a sibling script.

- **`MediaDevices.enumerateDevices()`** — leaks camera/mic/speaker *count* (labels are blank without
  permission). Normalize to a common device count. Spoofable via
  `MediaDevices.prototype.enumerateDevices` (primary:
  <https://developer.mozilla.org/en-US/docs/Web/API/MediaDeviceInfo/label>).
- **`navigator.maxTouchPoints` + touch `matchMedia`** — desktop should report `0`; a nonzero value
  contradicts the desktop profile (primary:
  <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/maxTouchPoints>). Spoofable (Navigator
  getter).
- **`speechSynthesis.getVoices()`** — the voice list is OS + installed-language bound and betrays the
  real OS; normalize to a common set (primary:
  <https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices>). Caveat: `speak()`
  timing and the `voiceschanged` event can betray a faked list.
- **`navigator.mediaCapabilities.decodingInfo` / `HTMLMediaElement.canPlayType`** — codec support
  matrix plus `powerEfficient`/`smooth` (hardware-decode dependent) leaks GPU/OS (primary:
  <https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/decodingInfo>). Spoofable.
- **`navigator.pdfViewerEnabled`** — should be consistent with the spoofed `plugins`/`mimeTypes` the
  extension already sets; low entropy but cheap to keep coherent (primary:
  <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/pdfViewerEnabled>).
- **AudioContext metadata** — beyond the readback the extension already neutralizes, `sampleRate`
  (44100 vs 48000), `baseLatency`/`outputLatency`, and `destination.maxChannelCount` also leak
  (primary: <https://bugzilla.mozilla.org/show_bug.cgi?id=1358149>). Normalize the getters to constant
  values; keep any spoofed buffer length consistent with the spoofed `sampleRate`.
- **`screen.orientation`** — normalize `type`→`landscape-primary`, `angle`→`0` for the desktop
  profile (primary: <https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation>).

**Surfaces to deliberately leave alone (re-adding them would be a spoofer tell):** these are *absent*
in Firefox and must stay absent — `navigator.deviceMemory` (Chromium-only, primary:
<https://caniuse.com/mdn-api_navigator_devicememory>), `navigator.userAgentData` and `Sec-CH-UA*`
client hints (Chromium-only; Firefox sends none, primary:
<https://caniuse.com/mdn-api_navigator_useragentdata>), `navigator.connection` (removed from Firefox
desktop, primary: <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/connection>), and the
Battery API (`navigator.getBattery` removed from Firefox web content at FF52, primary:
<https://bugzilla.mozilla.org/show_bug.cgi?id=1259335>). **WebGPU** (`navigator.gpu`) shipped
enabled-by-default only on Windows in Firefox 141 and is off elsewhere; in the 140 baseline the
default-matching state is `navigator.gpu` undefined (primary:
<https://mozillagfx.wordpress.com/2025/07/15/shipping-webgpu-on-windows-in-firefox-141/>) — do not add
it, and if targeting 141+ Windows, treat WebGPU adapter info as a *higher*-entropy surface than WebGL
that would need its own coverage.

**`ClientRects` / `getBoundingClientRect` subpixel precision** is a real rendering fingerprint that
Firefox does **not** yet round (bug still NEW: <https://bugzilla.mozilla.org/show_bug.cgi?id=1507879>).
Spoofing it fully means patching every geometry accessor consistently and risks breaking layout logic;
treat it as lower priority / RFP-territory rather than a quick win.

---

## 5. WebRTC IP leak — finish the still-open item from the IP research

The IP-strategy research already concluded that IP transport stays out of the extension, but flagged
**one** in-extension win: closing the WebRTC leak. A uniformized fingerprint is undone if a STUN
request leaks the real public/local IP. Set `peerConnectionEnabled` / `webRTCIPHandlingPolicy` (and
optionally `networkPredictionEnabled`) via `browser.privacy.network` — a real, extension-settable API
(primary: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy/network>).
This needs the `privacy` permission (not currently in `manifest.json`). Feasibility: trivial; it is a
single settings call in the background. This is the highest-leverage IP-adjacent control fully within
the extension's power.

---

## 6. Lean on Firefox: optional RFP passthrough + already-default protections

**An extension can enable Firefox's own RFP.** `resistFingerprinting` *is* a real property of
`browser.privacy.websites`, and it is extension-settable (capability added Firefox 58, primary bug:
<https://bugzilla.mozilla.org/show_bug.cgi?id=1397611>; API surface:
<https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy/websites>). RFP
normalizes what a content script *cannot* cleanly reach: it reveals a *consistent* OS (no TLS/UA
mismatch), rounds window size (letterboxing), forces timezone UTC, restricts fonts to a base set,
disables `WEBGL_debug_renderer_info`, spoofs `hardwareConcurrency`, reduces timer precision, forces
`prefers-color-scheme: light`, and — critically — **applies inside workers and regardless of page
CSP** (authoritative enumeration: <https://wiki.mozilla.org/Security/Fingerprinting>; MDN summary:
<https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy/websites>).

The cost is why Mozilla does *not* default it on and steers users to the gentler ETP fingerprinting
protection instead: letterboxing gray bars, wrong (UTC) clock, forced light theme, canvas breakage
(primary: <https://support.mozilla.org/en-US/kb/resist-fingerprinting>;
<https://bugzilla.mozilla.org/show_bug.cgi?id=1407366>). Note also that the newer, granular
`privacy.fingerprintingProtection` (ETP) is **not** exposed to WebExtensions — only the legacy RFP
boolean is; and RFP is a single global `BrowserSetting` only one extension can own at a time.

**Recommendation:** offer RFP as an **opt-in "hardened mode" toggle** in the popup (with a clear
warning about the breakage), rather than the default. It is the most robust single lever for the CSP
and worker gaps this project cannot fully close from a content script, and it guarantees OS
consistency — but its breakage makes it wrong as a silent default for a general-audience extension.

**Do not reimplement what Firefox already does by default** (all of these ship on for all users, so
the extension's marginal value here is low — cite them in docs, don't rebuild them):

- **Total Cookie Protection** / dynamic state partitioning — per-site cookie jars blocking cross-site
  tracking, **default for all desktop users since June 2022** (primary:
  <https://blog.mozilla.org/en/mozilla/firefox-rolls-out-total-cookie-protection-by-default-to-all-users-worldwide/>).
  This substantially **overlaps the containers feature** for *cross-site* tracking: TCP already
  isolates third-party state per top-level site automatically. The containers' remaining
  non-redundant value is **same-site multi-account separation** and explicit user-controlled identity
  isolation — worth framing the containers feature around that, since "stops cross-site tracking" is
  now largely Firefox's default job.
- **Cross-origin referrer trimming** to origin-only, **default since Firefox 87** (primary:
  <https://blog.mozilla.org/security/2021/03/22/firefox-87-trims-http-referrers-by-default-to-protect-user-privacy/>).
- **Query-parameter stripping** (`utm_*`, `fbclid`, …) — shipped FF102 but **only in ETP Strict**
  (primary:
  <https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/query-stripping/index.html>).
  Because it is *not* on in Standard mode, a **link-decoration / tracking-parameter stripper is a
  legitimate in-scope addition** for this extension for users not on ETP Strict (strip known tracking
  params from navigations via `webRequest`/`webNavigation`).
- **Bounce-tracking protection** — on in ETP Strict since FF133 (primary:
  <https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/bounce-tracking-protection/index.html>).
  In scope only if targeting non-Strict users.

---

## 7. Regression test checklist

Build a repeatable checklist. The key insight: **uniqueness measurers and spoof-detectors test
different things, and this design's biggest weakness (inconsistency, worker leakage) is caught only by
the detectors.** Pass *both* categories.

Spoof/inconsistency detectors (catch the extension's own tells — prioritize these):

- **CreepJS** — <https://github.com/abrahamjuliot/creepjs> (demo:
  <https://abrahamjuliot.github.io/creepjs>). Built "to shed light on weaknesses … among modern
  anti-fingerprinting extensions." It inspects native prototypes / `toString` to detect overridden
  getters, **re-runs probes inside Web/Service Workers and compares them to the window scope**, and
  cross-checks UA/platform/GPU/fonts. **Pass criterion: 0 lies, window==worker scope, overrides
  survive prototype/`toString` inspection.** This is the single most important gate for §1 (worker
  coverage) and §2 (OS consistency).
- **pixelscan.net** — <https://pixelscan.net/fingerprint-check> (methodology:
  <https://pixelscan.net/manifest>). Cross-references JS-claimed OS/GPU vs canvas/WebGL rendering,
  timezone vs IP, UA vs platform; flags identical/absent canvas noise as manipulation. **Pass
  criterion: no contradictions flagged.** Directly tests the §2 Windows-on-Mac risk.

Uniqueness measurers (do you blend into a crowd?):

- **EFF Cover Your Tracks** — <https://coveryourtracks.eff.org> (methodology:
  <https://coveryourtracks.eff.org/about>). Reports "one in X" uniqueness and "bits of identifying
  information" across UA/headers, screen, timezone, fonts, canvas, WebGL, audio, plus a live
  tracker-blocking test. **Pass criterion: low bits, not "nearly unique," full tracker blocking.**
- **amiunique.org** — <https://amiunique.org/fingerprint> (attribute list: <https://amiunique.org/faq>;
  research basis, Laperdrix et al., "Hiding in the Crowd":
  <https://dl.acm.org/doi/fullHtml/10.1145/3178876.3186097>). Per-attribute similarity ratios. **Pass
  criterion: high similarity ratio on each attribute (esp. canvas/WebGL/fonts).**

Per-surface debugger and end-to-end check:

- **browserleaks.com** — <https://browserleaks.com/> — per-surface pages (canvas, webgl, webrtc,
  fonts, javascript, css, rects, tls) to confirm each individual override took effect and to read raw
  values / the TLS JA3 the server sees (relevant to §2's TLS-mismatch point).
- **fingerprint.com/demo** — <https://fingerprint.com/demo> — end-to-end: does the visitorId stay
  stable across private windows / cache clears despite the extension? **Pass criterion: visitorId is
  not stable across sessions.**
- **deviceinfo.me** — <https://www.deviceinfo.me> — broad single-page leak smoke test (flags Firefox
  extension detection and fingerprinting-resistance state).

Minimum viable regression gate before each release: CreepJS (0 lies, worker==window) + pixelscan (no
contradictions) + Cover Your Tracks (low bits) on Windows, macOS, and Linux — because §2's whole point
is that the result differs by real OS.

---

## Notes on verification limits

- The per-OS *default font name* lists (Segoe UI / San Francisco / DejaVu) and the "Windows-UA-but-
  macOS-fonts is caught" claim are assembled from technical vendor blogs plus browserleaks, not a
  single peer-reviewed primary quote; the *principle* (font enumeration reveals the real OS and
  contradicts a spoofed UA) is well-supported, the exact name-to-OS mapping less so from one source.
- The Akamai HTTP/2 fingerprinting whitepaper PDF could not be text-extracted; its claims were
  verified via lwthiker's writeup instead.
- The Tor GitLab issue 42111 returned 403 on direct fetch; corroborated via the tor-dev mailing list.
- No primary sentence states outright that `world: "MAIN"` scripts bypass page CSP; it follows by
  construction (they are not loaded as inline `<script>` elements) and from Firefox 128 adding the
  feature, but it is reasoned rather than quoted — worth a quick empirical confirmation on a strict-CSP
  test page before relying on it.
- The non-RFP default `performance.now` clamp value (1 ms vs a historically-stated 2 ms) should be
  confirmed live in `about:config` on Firefox 140.

---

## Sources

Mozilla / MDN (primary):

- OS spoofing reversed in RFP — <https://bugzilla.mozilla.org/show_bug.cgi?id=1404608>
- Spoofed UA vs TCP/IP OS fingerprint — <https://bugzilla.mozilla.org/show_bug.cgi?id=1409269>
- Extensions can toggle RFP (FF58) — <https://bugzilla.mozilla.org/show_bug.cgi?id=1397611>
- `privacy.websites` (resistFingerprinting property) — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy/websites>
- `privacy.network` (WebRTC IP handling) — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy/network>
- RFP normalization list — <https://wiki.mozilla.org/Security/Fingerprinting>
- RFP breakage / user guidance — <https://support.mozilla.org/en-US/kb/resist-fingerprinting>
- Page CSP applies to content-script DOM insertions — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_Security_Policy>
- CSP-exempt content-script insertion meta-bug (open) — <https://bugzilla.mozilla.org/show_bug.cgi?id=1267027>
- `world: "MAIN"` in Firefox 128 (MV2+MV3) — <https://blog.mozilla.org/addons/2024/07/10/manifest-v3-updates-landed-in-firefox-128/>
- Sharing objects with page scripts (wrappedJSObject/exportFunction) — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts>
- content_scripts (all_frames, match_about_blank, srcdoc caveat, runAt) — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts>
- WorkerNavigator / WorkerGlobalScope / OffscreenCanvas — <https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator>, <https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope>, <https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas>
- Firefox keeps MV2 + blocking webRequest — <https://blog.mozilla.org/en/firefox/firefox-manifest-v3-adblockers/>
- Font visibility restriction (FF80) — <https://bugzilla.mozilla.org/show_bug.cgi?id=1653987>; font whitelist WONTFIX — <https://bugzilla.mozilla.org/show_bug.cgi?id=1336208>
- AudioContext metadata leak — <https://bugzilla.mozilla.org/show_bug.cgi?id=1358149>
- ClientRects rounding (still open) — <https://bugzilla.mozilla.org/show_bug.cgi?id=1507879>
- Battery API removal (FF52) — <https://bugzilla.mozilla.org/show_bug.cgi?id=1259335>
- WebGPU on Windows in FF141 — <https://mozillagfx.wordpress.com/2025/07/15/shipping-webgpu-on-windows-in-firefox-141/>
- Total Cookie Protection default (2022) — <https://blog.mozilla.org/en/mozilla/firefox-rolls-out-total-cookie-protection-by-default-to-all-users-worldwide/>
- Referrer trimming default (FF87) — <https://blog.mozilla.org/security/2021/03/22/firefox-87-trims-http-referrers-by-default-to-protect-user-privacy/>
- Query-param stripping (ETP Strict) — <https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/query-stripping/index.html>
- Bounce-tracking protection — <https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/bounce-tracking-protection/index.html>

Specs / MDN surface docs (primary):

- `Intl…resolvedOptions` — <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/resolvedOptions>
- `matchMedia` features — <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme>, <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/resolution>
- `enumerateDevices` labels — <https://developer.mozilla.org/en-US/docs/Web/API/MediaDeviceInfo/label>
- `maxTouchPoints` — <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/maxTouchPoints>
- `speechSynthesis.getVoices` — <https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices>
- `mediaCapabilities.decodingInfo` — <https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/decodingInfo>
- `pdfViewerEnabled` — <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/pdfViewerEnabled>
- `ScreenOrientation` — <https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation>
- deviceMemory (not in FF) — <https://caniuse.com/mdn-api_navigator_devicememory>; userAgentData (not in FF) — <https://caniuse.com/mdn-api_navigator_useragentdata>; connection (removed) — <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/connection>
- `Intl.Segmenter` (FF125) — <https://caniuse.com/mdn-javascript_builtins_intl_segmenter>

Detection / fingerprinting technical sources:

- WebGL renderer reveals real GPU/OS — <https://blog.castle.io/the-role-of-webgl-renderer-in-browser-fingerprinting/>
- LinkedIn getHasLiedOs cross-checks — <https://securityboulevard.com/2026/01/detecting-forged-browser-fingerprints-for-bot-detection-lessons-from-linkedin/>
- HTTP/2 fingerprint unreachable from extensions — <https://lwthiker.com/networks/2022/06/17/http2-fingerprinting.html>
- JA3/JA4 TLS fingerprinting — <https://engineering.salesforce.com/tls-fingerprinting-with-ja3-and-ja3s-247362855967/>
- Font fingerprinting / OS mismatch — <https://browserleaks.com/fonts>, <https://botbrowser.io/en/blog/font-fingerprinting/>
- Timezone/OS mismatch smart signals — <https://docs.fingerprint.com/docs/smart-signals-reference>
- Tor 14.0 stops spoofing OS — <https://gitlab.torproject.org/tpo/applications/tor-browser/-/issues/42111>, <https://lists.torproject.org/mailman3/hyperkitty/list/tor-dev@lists.torproject.org/thread/QWFGPSVH2ZRB4BRCB3EHEIHKFP5MNLSZ/>

Test suites:

- EFF Cover Your Tracks — <https://coveryourtracks.eff.org/about>
- amiunique — <https://amiunique.org/fingerprint>; "Hiding in the Crowd" — <https://dl.acm.org/doi/fullHtml/10.1145/3178876.3186097>
- browserleaks — <https://browserleaks.com/>
- CreepJS — <https://github.com/abrahamjuliot/creepjs>
- pixelscan — <https://pixelscan.net/fingerprint-check>
- FingerprintJS — <https://github.com/fingerprintjs/fingerprintjs>, <https://fingerprint.com/demo>
- deviceinfo.me — <https://www.deviceinfo.me>
