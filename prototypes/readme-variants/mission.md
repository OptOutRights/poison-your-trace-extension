<div align="center">

<img src="../../icons/seringuewhite-512.png" width="88" alt="Poison your Trace" />

# Poison your Trace

**You are not one profile. Stop letting the web treat you like one.**

</div>

Every site you visit is quietly trying to answer the same question: *is this the same person we saw somewhere else?* Cookies follow you between pages, and a **fingerprint** — your screen, timezone, fonts, graphics card, and dozens of other signals — is enough to recognize you even when the cookies are gone. Piece by piece, your separate activities get stitched back into a single identity.

**Poison your Trace refuses that stitch.** One switch, and every site opens in its own sealed container while your fingerprint is uniformized toward a profile shared by everyone else running the extension. You stop being a unique dot. You become part of a crowd that all looks the same.

<div align="center">

**[Install for Firefox — one click](https://github.com/OptOutRights/poison-your-trace-web-extension/releases/latest/download/poison-your-trace.xpi)**

<img src="screenshots/popup.png" width="300" alt="The toolbar popup: a single Enabled toggle" />

</div>

## How it protects you

- **Per-site containers** — each site lives in its own Firefox container. Cookies and logins can't leak from one site to another.
- **A shared fingerprint** — navigator, screen, timezone, canvas, WebGL, plugins, Web Audio, and your request headers are reshaped toward *one common profile*. Not randomized — **uniformized**, because a random value nobody else has is just another way to be unique. Sameness is the disguise.
- **Burner emails** — empty email fields fill with a stable, per-site throwaway alias at `example.invalid`. Your real address stays yours.
- **One honest switch** — a single **Enabled** toggle, and a plain recap of exactly what the current site can and can't see.

## What we won't pretend

Privacy tools that overpromise get people hurt. Here's the truth:

- **Your IP address is still visible.** We never leak it, but we can't change it. Run a VPN or Tor alongside this for network-level cover.
- **The burner email is a shield, not an inbox.** It's inert by design and receives nothing — it keeps your real address off signup forms, that's all.
- **Font metrics aren't covered yet.** We're working on it.

## Install in under a minute

The release is signed by Mozilla's addons.mozilla.org, so it installs on any normal Firefox — no developer mode, no trust in the maintainer, just Firefox checking the signature.

1. Open **[the install link](https://github.com/OptOutRights/poison-your-trace-web-extension/releases/latest/download/poison-your-trace.xpi)** in Firefox.
2. Confirm **Add**.

It auto-updates from there. Install once; it keeps itself current.

## For the curious and the skeptical

Good privacy tools invite inspection. Read exactly how this works — page-world injection, why `.invalid`, the before/after capture contract, and every honest gap in full — in the **[beginner's guide](../../docs/beginners-guide.md)**. Or build it yourself:

```bash
npm install && npm run build && npm start
```

<div align="center">
<sub>Free software by <a href="https://github.com/OptOutRights">OptOutRights</a> · Apache-2.0 · no accounts, no telemetry, no tracking of the people it protects.</sub>
</div>
