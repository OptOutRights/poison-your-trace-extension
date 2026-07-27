<div align="center">

<img src="../../icons/seringuewhite-512.png" width="96" alt="Poison your Trace" />

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

<div align="center">

<img src="screenshots/popup.png" width="320" alt="The toolbar popup: a single Enabled toggle and a recap of what the active site sees" />

<em>One toggle. A plain recap of what's being hidden on the site you're on.</em>

</div>

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

```bash
npm install
npm run build      # typecheck, then bundle into dist/
npm start          # build + launch Firefox with the extension loaded
```

## Learn more

📖 **[Beginner's guide](../../docs/beginners-guide.md)** — why uniformize over randomize, how page-world injection works, why `.invalid`, what the popup shows, and how to read the fingerprint test page.

<div align="center">
<sub>Built by <a href="https://github.com/OptOutRights">OptOutRights</a> · Apache-2.0 · No tracking, no telemetry, no accounts.</sub>
</div>
