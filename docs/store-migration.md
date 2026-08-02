# Moving Poison your Trace to the Firefox Add-ons store

This guide is for the **person who owns (or will own) the addons.mozilla.org account** that hosts
the extension. Read it together with the maintainer once, then you rarely need to touch it again.

## What's changing, and why

Until now the extension was **self-hosted**: we signed it ourselves and served the `.xpi` and an
update file from GitHub. We're switching to the **official Firefox Add-ons store** (addons.mozilla.org,
"AMO"), on the **listed** channel.

The payoff: **Mozilla handles updates for everyone, automatically.** Once you publish a new version,
every user's Firefox picks it up on its own — no update file for us to maintain, no reinstall, no
GitHub download link to keep alive. The one cost is that each new version goes through Mozilla's
review before it reaches users (usually minutes; sometimes a manual review takes longer).

Two facts that drive everything below:

- A listed add-on **must not** carry its own `update_url` — AMO rejects it, because AMO *is* the
  update source. (We've already removed it from the manifest.)
- Firefox auto-updates a listed add-on **however it was installed** — from the store button or a
  file — by matching the add-on's ID against AMO. So there is nothing custom for us to keep working.

## The add-on ID (read this first)

The extension's identity is fixed in `manifest.json`:

```
poison-your-trace-extension@optoutrights.org
```

**The store listing must be created under your account with this exact ID.** An add-on ID belongs
to one AMO account and can't be silently moved to another — if the wrong account claims it first,
untangling it needs Mozilla support. So before anything else: confirm the listing will live on
*your* account, and that no one has already uploaded this ID elsewhere.

## One-time setup

### 1. Account prerequisites
- A Firefox Account signed in at <https://addons.mozilla.org/developers/>.
- Two-factor authentication enabled (Mozilla requires it for developers).
- Accept the Firefox Add-on Distribution Agreement (prompted on first submission).

### 2. Create the listing
The very first version needs listing information that only exists in the web form, so do the first
submission by hand:

1. Go to **Developer Hub → Submit a New Add-on**.
2. Choose **On this site** (that's the *listed* channel).
3. Upload a build of the extension (the maintainer can produce one, or you can use the source zip
   from a GitHub Release and build it). Firefox will read the ID from the manifest.
4. Fill in the listing metadata:
   - **Name / summary / description**
   - **Categories** (e.g. Privacy & Security)
   - **Screenshots** (at least one — the toolbar popup is a good choice)
   - **Privacy policy** and **data collection: none** (the extension collects nothing)
   - **Support email**: `poisonyourtrace@optoutrights.org`
5. Submit for review.

### 3. Provide the source code
Our extension is **bundled** with a build tool (esbuild), so Mozilla's reviewers require the
original source. When AMO asks:

- Grab the `poison-your-trace-source-<version>.zip` attached to the matching **GitHub Release**
  (our release workflow produces it on every version tag), and upload it in the source-code field.
- The reviewers use it to reproduce our `dist/` from source; they don't publish it.

### 4. Create API credentials for automated releases
So the maintainer's tag-push can submit new versions automatically:

1. Go to **Developer Hub → Manage API Keys** (<https://addons.mozilla.org/developers/addon/api/key/>).
2. Generate a **JWT issuer** and **JWT secret**.
3. Hand both to the maintainer **securely** (treat them like passwords — anyone with them can
   publish under your account). They go into the GitHub repo as two Actions secrets:
   - `AMO_JWT_ISSUER`
   - `AMO_JWT_SECRET`

That's it for setup.

## How releases work from now on

1. The maintainer bumps the `version` in `manifest.json` and pushes a matching tag, e.g. `v0.2.0`.
2. GitHub Actions builds the extension and runs `web-ext sign --channel=listed`, which **uploads
   the new version to your AMO account** for review, then publishes a small GitHub Release with the
   source zip.
3. Mozilla reviews the version (often automated and quick; occasionally a human review adds a day
   or two).
4. On approval, the version goes live and **all users auto-update** — nothing else to do.

You don't need to log in for routine releases. You only revisit the Developer Hub if Mozilla
requests something (e.g. a fresh source upload) or if you want to edit the listing text/screenshots.

## Verifying auto-update

To watch an update land instead of waiting for Firefox's daily check:

1. Install the current store version in Firefox.
2. After a newer version is approved, open `about:addons`, click the **gear icon**, and choose
   **Check for Updates**. Firefox pulls the new version immediately.

There's nothing bespoke to test on our side — the update path is Mozilla's own infrastructure,
keyed only off the `version` field.

## If a release goes wrong

- **Disable a bad version**: Developer Hub → the add-on → **Manage Status & Versions** → disable
  the problem version. Firefox will roll users back to the previous approved version.
- **Rejected review**: Mozilla emails the reason. Fix it, bump the version, push a new tag — a
  version number can't be reused once submitted.

## Quick reference

| Thing | Value |
|---|---|
| Add-on ID | `poison-your-trace-extension@optoutrights.org` |
| Channel | listed (On this site) |
| Developer Hub | <https://addons.mozilla.org/developers/> |
| API keys | <https://addons.mozilla.org/developers/addon/api/key/> |
| GitHub secrets | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` |
| Source for review | `poison-your-trace-source-<version>.zip` on the GitHub Release |
| Support email | `poisonyourtrace@optoutrights.org` |
