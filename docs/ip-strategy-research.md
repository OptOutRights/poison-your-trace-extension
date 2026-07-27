# IP strategy research

## Executive summary

Poison your Trace uniformizes the browser fingerprint so its users blend into one crowd, but it
cannot hide the IP address a site sees — and the two goals the team wants (look identical to the
crowd *and* not get blocked) genuinely pull against each other. The honest answer is that **no
in-extension mechanism can hide or share IPs**: a Firefox WebExtension can only point traffic at an
existing proxy server (`host:port`); it has no raw sockets, so it cannot build a peer-to-peer mesh
where users route each other's traffic. The "users become a VPN for each other" idea is technically
impossible inside a WebExtension *and*, even with companion software, it is the exact design that
turned Hola VPN into a botnet whose users unknowingly carried strangers' (sometimes illegal) traffic
and became liable for it — so it should be rejected on both counts. **Recommendation:** keep IP
handling out of the extension (the current stance), but ship two concrete, in-extension wins the
team already has the power to build — close the WebRTC IP leak with `browser.privacy.network`, and
add first-class, in-product guidance (and optional integration) for running **Tor** alongside, whose
"one exit, shared reputation" model is the network-layer twin of this project's fingerprint
philosophy. Datacenter/single-shared-IP egress is explicitly *not* recommended: shared IPs earn a
high threat score and get CAPTCHA-walled and blacklisted.

---

## The core tension, stated precisely

The team's three goals are:

1. **Blend into the crowd** — many users share one apparent identity, so IP does not single anyone out.
2. **Don't get blocked** — a single shared egress IP gets rate-limited, CAPTCHA-walled, and blacklisted.
3. Reconcile 1 and 2.

There is a real, documented reason these conflict, and Tor is the canonical worked example of it.
Tor's own support docs explain that CAPTCHAs appear because *"Many people share the same Tor exit
relays"*, so *"thousands of users worldwide may utilize the same IP address"* and sites read that
concentrated activity as *"Many automated requests or logins from a single IP address"* and
*"Traffic patterns that resemble bots"* (primary:
<https://support.torproject.org/tor-browser/encountering-issues/captchas/>). Cloudflare quantifies
the reputation cost: it stated that *"94% of requests that we see across the Tor network are per se
malicious"*, and therefore *"the IPs of the Tor exit nodes often have a very high threat score"*
(primary: <https://blog.cloudflare.com/the-trouble-with-tor/>). That is goal 1 (crowd) directly
*causing* the failure of goal 2 (blocking): the moment you concentrate many users behind few IPs,
those IPs look like a bot farm.

So "reconcile 1 and 2" has no clean solution at the IP layer — it is an inherent trade-off, the same
one Tor accepts deliberately. This is worth stating plainly in the product rather than promising a
fix that does not exist. It is also, notably, the network-layer mirror of the choice this project
already made at the fingerprint layer: uniformize into a crowd and accept that the crowd is
recognizable *as a crowd* (see `docs/beginners-guide.md`, "uniformizes rather than randomizes").

---

## What a Firefox WebExtension can and cannot do about IP

This section is decisive, because it eliminates several ideas before we even weigh their ethics.

**An extension can redirect traffic to a proxy, but only a standard proxy server.** The `proxy` API
fires `proxy.onRequest` per request and lets the extension return a `ProxyInfo` describing where to
send it (primary: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy>).
The `ProxyInfo` `type` field is restricted to a fixed set: `"direct"`, `"http"`, `"https"`,
`"socks"` (SOCKS5), `"socks4"`, and `"masque"` (a QUIC tunnel per RFC 9298), and every non-direct
type requires a `host` and `port` (primary:
<https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/ProxyInfo>). There
is **no way to name a peer, a WebRTC destination, or a raw socket** — only an existing proxy
endpoint. So the extension can *tell Firefox to use* a SOCKS/HTTP/MASQUE proxy (e.g. a running Tor
daemon on `127.0.0.1:9050`, or a VPN's local proxy), but it cannot *be* the proxy or the transport.

**An extension cannot open raw TCP/UDP sockets.** The WebExtensions surface is limited to
`fetch`/`XMLHttpRequest` and WebSocket; there is no socket API. Mozilla prototyped TCP and UDP socket
APIs under the `libdweb` experiment but abandoned them — they never shipped to Nightly, let alone
release (primary tracking bugs: <https://bugzilla.mozilla.org/show_bug.cgi?id=1247628> "UDP Socket
API for WebExtensions"; project: <https://github.com/mozilla/libdweb>). Reaching raw sockets today
requires a **native-messaging bridge to an external helper binary** (e.g. the `Socketify` approach:
<https://github.com/NetAsmCom/Socketify>) — i.e. companion software outside the extension, and
outside what addons.mozilla.org distributes.

**Consequence:** any design where the extension itself carries other users' packets — a P2P/mesh VPN
— is impossible as a pure WebExtension. It would need a bundled daemon, which changes the product's
threat model, its AMO listing, and its legal exposure entirely.

**But the extension CAN close one real IP leak.** The `browser.privacy.network` API lets an extension
set `peerConnectionEnabled` (a boolean; `false` disables `RTCPeerConnection` entirely) and
`webRTCIPHandlingPolicy` (values from `default` up to `disable_non_proxied_udp` and `proxy_only`)
(primary: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy/network>).
This matters because a browser that uniformizes its fingerprint but leaks the real public IP via a
WebRTC STUN request has undermined its own premise — the leak reveals the user even behind a VPN
(secondary background: <https://www.security.org/vpn/webrtc-leak/>). This is the one IP-adjacent
control that is fully in the extension's power today.

---

## The specific question: "can users become a VPN and share IPs with each other?"

**Technically, inside a WebExtension: no.** As shown above, the extension has no raw sockets and the
`proxy` API can only target a fixed proxy `host:port`, never a peer. There is no API by which
Firefox extension A accepts and forwards Firefox extension B's traffic. Building this at all would
require shipping a native daemon alongside the extension (native messaging + an external socket
binary), i.e. it stops being "a Firefox extension" and becomes a VPN client the team must write,
distribute, and operate.

**Even with companion software: this is the Hola design, and it is a cautionary tale, not a model.**
Hola offered a "free VPN" by turning its ~9.7M users' idle devices into exit nodes and reselling
that traffic through a sibling brand, Luminati, at ~\$20/GB (secondary, well-sourced:
<https://www.theregister.com/2015/05/29/hola_vpn_used_8chan_takedown_botnet_or_not/>). The mechanics
are exactly the "share IPs between each other" idea: *"users route their traffic through each others'
devices"*, and *most users did not realize their machines were the VPN itself*. The consequences the
team must weigh:

- **Your volunteers carry strangers' traffic under their own home IP.** Whatever a stranger does —
  fraud, abuse, illegal content — exits through the volunteer's residential connection and looks like
  the volunteer did it. Security analyst Sean Sullivan's summary of the flaw: *"a peer-to-peer network
  requires trusting all of the peers. And with 9.7 million exit nodes, Hola users undoubtedly route
  some of their traffic through computers infected with malware"* (same Register source).
- **It becomes an attack tool.** In May 2015 an attacker rented Luminati access and used the Hola
  residential IPs to DDoS 8chan; because the requests came from *residential* IPs they were hard to
  distinguish from real users (same source). A crowd of trusted residential IPs is precisely what
  attackers pay for.
- **Consent and liability.** The commercial residential-proxy industry that grew out of this (Bright
  Data, the former Luminati) now insists the *"only legal and ethical means"* of sourcing residential
  IPs is *"informed user consent"* with explicit, revocable opt-in and no bundling by surprise
  (primary vendor framing: <https://brightdata.com/trustcenter/sourcing>). Hola's original sin was the
  opposite — the sharing was buried and non-consensual. Independent 2026 reporting shows this model
  keeps causing scandals when consent is unclear (secondary:
  <https://thehackernews.com/2026/06/free-apps-are-quietly-turning-smart-tvs.html>).

**Verdict on the idea:** reject it. It is impossible to do as a WebExtension, and where it *is*
possible (a bundled daemon) it exposes your own privacy-focused users to criminal liability for
traffic they never saw, converts the userbase into a rentable botnet, and demands a consent, vetting,
and abuse-handling apparatus far beyond a volunteer extension project. For a project whose users
install it *specifically to reduce their exposure*, making them an exit node for strangers is the
opposite of the promise.

---

## Solutions compared

| Approach | Feasible as pure WebExtension? | Hides IP? | Blocking risk | Anonymity / crowd | Legal & security risk | Verdict |
|---|---|---|---|---|---|---|
| **Do nothing in-extension; recommend Tor/VPN alongside** (current stance) | Yes (it is the absence of a mechanism) | No (delegated to the tool the user runs) | N/A in-extension; depends on the tool | Depends on the tool | Low — no traffic handled | **Keep as baseline** |
| **Integrate/point at a local Tor daemon** via `proxy` API (SOCKS `127.0.0.1:9050`) | Extension part yes; **Tor daemon is companion software** | Yes, when Tor is running | Medium–high: exit relays are shared and heavily CAPTCHA'd/blocklisted (94% malicious per Cloudflare) | **Strong** — Tor's whole design is one shared crowd | Low for the user; Tor handles exit-node operation | **Recommended companion** |
| **Operate one shared VPN/datacenter egress ("one crowd IP")** | Extension can point at it; **team must run the egress** | Yes | **Very high** — one IP for many users = bot-farm signal, rate limits, blacklists; datacenter ranges pre-flagged | Crowd, but a *recognizable* crowd | Team becomes an ISP-of-record; abuse complaints land on the team | **Reject** |
| **P2P mesh — users route each other's traffic (Hola model)** | **No** — no raw sockets; needs a bundled daemon | Yes (via peers) | Low *for the requester* (residential IPs); that is exactly why attackers abuse it | Crowd of residential IPs | **Severe** — volunteers liable for strangers' traffic; botnet potential; consent/vetting burden | **Reject** |
| **Rotating residential proxy pool** (e.g. buy Bright Data) | Extension can point at the proxy; **team pays/operates** | Yes | Low (residential, rotating) | Weak as "crowd" — each user gets a *different* rented IP, so it does not uniformize | Ethically fraught supply chain; cost; ToS/anti-fraud grey area | **Reject for this project** |
| **Block WebRTC IP leaks** via `browser.privacy.network` | **Yes, fully in-extension** | Prevents a *leak* of the real IP; does not change the IP a site sees over HTTP | N/A | Protects the fingerprint uniformity the project already provides | None | **Recommended — build this** |

Notes on the two "recommended" rows:

- **Tor as companion.** The extension cannot *be* Tor, but the `proxy` API can route Firefox through a
  Tor SOCKS proxy the user runs, and MASQUE/QUIC or SOCKS types are all supported targets
  (<https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/ProxyInfo>). This
  is the honest, philosophy-aligned answer: Tor's "make every user's traffic exit through a shared
  crowd of relays" is the network-layer version of this project's "make every user's fingerprint
  identical." Tor Browser even shares the *fingerprint* uniformity philosophy — reducing users to the
  same *"buckets"* so no one is singled out (primary:
  <https://support.torproject.org/tor-browser/features/fingerprinting-protections/>). The price (goal
  2) is real and should be disclosed: shared exit reputation means CAPTCHAs and some blocked sites.

- **WebRTC leak blocking.** This is the single new thing worth *building into the extension*. It costs
  a small `privacy.network` call and closes a hole that would otherwise defeat the whole product for
  users who *do* run a VPN/Tor.

---

## Recommendation

1. **Keep IP out of the extension's transport path.** Do not operate an egress, do not build a mesh,
   do not resell/rent residential IPs. Confirmed by MDN: the extension cannot do the mesh anyway
   without a bundled daemon, and every "operate an egress" variant makes the project an ISP-of-record.
2. **Build WebRTC-leak protection into the extension now.** Set `peerConnectionEnabled`/
   `webRTCIPHandlingPolicy` via `browser.privacy.network` so a uniformized fingerprint is not undone
   by a STUN leak. This is the only IP-related control fully within the extension's power.
3. **Make Tor the first-class recommended companion**, with clear in-product guidance (and, optionally,
   a helper that configures Firefox's proxy toward a local Tor SOCKS port via the `proxy` API). Frame
   it honestly: Tor gives the network-layer "crowd" that matches the extension's fingerprint "crowd,"
   at the cost of CAPTCHAs on some sites — the same trade-off the project already embraces elsewhere.
4. **Say the tension out loud in the README/guide.** Goals 1 and 2 cannot be fully reconciled at the
   IP layer; concentrating a crowd behind few IPs is *why* those IPs get blocked. Honesty here matches
   the project's existing "Honest gaps" voice.
5. **Explicitly reject the "users become a VPN" idea** in the docs, citing Hola, so the question is
   settled with evidence rather than re-litigated.

---

## Sources

Primary (the doc/vendor that owns the claim):

- Firefox `proxy` API — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy>
- Firefox `proxy.ProxyInfo` (supported proxy types, host:port only) — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/ProxyInfo>
- Firefox `privacy.network` (`peerConnectionEnabled`, `webRTCIPHandlingPolicy`) — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy/network>
- Mozilla `libdweb` UDP socket bug (no socket API in WebExtensions) — <https://bugzilla.mozilla.org/show_bug.cgi?id=1247628>
- Mozilla `libdweb` project (abandoned socket experiment) — <https://github.com/mozilla/libdweb>
- Tor Project — CAPTCHAs / shared exit-relay reputation — <https://support.torproject.org/tor-browser/encountering-issues/captchas/>
- Tor Project — fingerprinting protections / uniformity ("buckets") — <https://support.torproject.org/tor-browser/features/fingerprinting-protections/>
- Cloudflare — "The Trouble with Tor" (94% malicious, threat score) — <https://blog.cloudflare.com/the-trouble-with-tor/>
- Bright Data — ethical sourcing / informed-consent framing for residential IPs — <https://brightdata.com/trustcenter/sourcing>

Secondary (reporting and analysis):

- The Register — Hola VPN / Luminati exit-node reselling and the 8chan DDoS — <https://www.theregister.com/2015/05/29/hola_vpn_used_8chan_takedown_botnet_or_not/>
- The Hacker News (2026) — free apps turning devices into scraping proxies (consent recurring issue) — <https://thehackernews.com/2026/06/free-apps-are-quietly-turning-smart-tvs.html>
- Security.org — WebRTC leak explainer — <https://www.security.org/vpn/webrtc-leak/>
- Socketify — native-messaging socket bridge (illustrates that raw sockets require external software) — <https://github.com/NetAsmCom/Socketify>
