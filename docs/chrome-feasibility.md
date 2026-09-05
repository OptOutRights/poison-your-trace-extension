# Can we port Poison your Trace to Chrome?

Short answer: **not as a port.** The two features that make this extension what it is — per-site
container isolation and fingerprint uniformization — both rest on **Firefox-only** browser APIs
with **no Chrome equivalent**. Shipping on Chrome means *reinventing* isolation with a different,
weaker mechanism, not flipping a build flag. This note lays out why, and what Chrome could
realistically offer.

## What the extension actually depends on

Two Firefox-specific pillars:

- **Per-site containers.** `src/containers/auto.ts` reopens every top-level navigation in a
  container keyed to the site's registrable domain, using the `contextualIdentities` permission
  (see `manifest.json`) and per-tab `cookieStoreId`. That gives each site its own cookie jar,
  storage, and login state — isolation enforced *by the browser*. This API is **Firefox-only**.
- **Fingerprint protection.** The current approach leans on Firefox's
  `browser.privacy.websites.resistFingerprinting` (RFP) BrowserSetting — a Firefox-only toggle that
  makes the browser itself normalize the values sites can read.

Neither of these exists in Chrome. Chrome (Manifest V3) has **no containers API**, **no per-tab
cookie store**, and **no RFP-equivalent exposed to extensions**. So there is nothing to "port" for
the parts that matter most.

## What Chrome *could* do instead

None of these reproduce the Firefox guarantee; they are the honest alternatives, with their limits.

- **Separate Chrome profiles.** Chrome's real isolation boundary is the *profile*. You could ask
  users to run one profile per site — but profiles are heavyweight, created manually, and not
  automatic or per-site the way our container flow is. This is a workflow, not a feature we can
  drive from an extension.
- **Cookie partitioning / CHIPS.** Chrome partitions *third-party* cookies by top-level site
  (CHIPS, plus storage partitioning). This limits some cross-site tracking, but it is partial and
  automatic — it is **not** the "each site is its own sealed jar" guarantee containers give, and
  it's not something the extension controls.
- **`declarativeNetRequest` (MV3).** Header rewriting and tracker/request blocking are possible on
  Chrome, but through MV3's declarative rules rather than MV2 `webRequestBlocking`. Different model,
  different limits (static rulesets, no synchronous blocking) — usable for *some* hardening, not for
  the container reopen-and-cancel trick.
- **Email burner.** The disposable-email feature is just DOM + `storage`. It is **portable** to
  Chrome essentially as-is, since it doesn't touch any Firefox-only API.

## Feature → mechanism → Chrome viability

| Feature | Firefox mechanism | Chrome viability |
|---|---|---|
| Per-site isolation | `contextualIdentities` + `cookieStoreId` | **None.** No containers API; nearest is manual per-site *profiles* or partial *CHIPS* — neither equivalent |
| Fingerprint uniformization | `privacy.websites.resistFingerprinting` (RFP) | **None** exposed to extensions; would need bespoke, weaker JS spoofing |
| Header / tracker hardening | `webRequestBlocking` (MV2) | **Partial** via `declarativeNetRequest` (MV3), different model |
| Email burner | DOM + `storage` | **Full** — portable as-is |

## Conclusion

Chrome is a **separate project**, not a build flag. The core value proposition doesn't translate:
Chrome can't give browser-enforced per-site isolation to an extension, and can't expose RFP. A
Chrome build would be a different product with weaker guarantees, resting on profiles/CHIPS and
MV3 declarative rules, with only the email burner carrying over cleanly.

Recommendation: **Firefox-first.** Treat Chrome (and other Chromium browsers) as **future scope** —
worth a dedicated design effort if and when there's demand, not a near-term port.
