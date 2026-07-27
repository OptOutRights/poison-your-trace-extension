# Poison your Trace

A Firefox extension that stops your separate activities from being joined back into one identity.

It works as one brick: a single switch. When it's on, every site you visit opens in its own container — so cookies and logins never cross between sites — and your browser fingerprint is uniformized toward one common profile shared by every user of the extension, so the signals a site reads distinguish no one.

<br/>

**[→ Install for Firefox](https://github.com/OptOutRights/poison-your-trace-web-extension/releases/latest/download/poison-your-trace.xpi)**  ·  signed, auto-updating, works on stock Firefox

<br/>

<img src="screenshots/popup.png" width="300" alt="The toolbar popup" />

---

### What it does

- **Per-site containers** — every site opens in its own Firefox container, so cookies and logins never cross between sites.
- **Uniformized fingerprint** — navigator, screen, timezone, canvas, WebGL, plugins, Web Audio, and the User-Agent and Accept-Language headers are reshaped toward one common profile rather than randomized per site.
- **Burner email autofill** — empty email fields are filled with a unique, stable, per-site throwaway alias at `example.invalid`, so you never hand a site your real address.
- **A single toggle** — one **Enabled** switch in the toolbar popup turns every protection on or off, with a plain recap of what's being hidden on the active site.

### Honest gaps

- **Your IP address is not hidden.** The extension never leaks it, but it can't change the address a site sees. For IP-level protection, run a VPN or Tor alongside it.
- **Email is burner-only.** The filled alias is inert and receives nothing; it hides your real address on signup forms, it is not an inbox.
- **Font metrics are not covered yet.**

### Install

The release is signed through the addons.mozilla.org API, so anyone can install it on a normal Firefox with no developer settings.

1. In Firefox, open **[the permanent install link](https://github.com/OptOutRights/poison-your-trace-web-extension/releases/latest/download/poison-your-trace.xpi)**.
2. Firefox downloads the `.xpi` and offers to add it — confirm **Add**.

The link always points at the newest signed release, and installed copies auto-update from there. No reinstall is ever needed.

### Build from source

You need Node.js and Firefox.

```
npm install
npm run build      # typecheck, then bundle into dist/
npm start          # build, then launch Firefox with the extension loaded
```

### Documentation

For the full reasoning — why uniformize rather than randomize, how page-world injection works, why `.invalid`, what the popup shows, and how to read the fingerprint test page — see the **[beginner's guide](../../docs/beginners-guide.md)**.
