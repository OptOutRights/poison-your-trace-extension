# PROTOTYPE — README candidates (throwaway)

Four candidate rewrites of the repo README, rendered through **GitHub's own markdown
API** so the preview is exactly what GitHub will show. Pick one, fold it into the real
`/README.md`, then delete this whole folder.

## Run

```bash
node prototypes/readme-variants/preview.mjs
# → http://localhost:5178
```

Use the floating bottom bar to switch variants. (Optional: `export GITHUB_TOKEN=…`
to lift the 60-render/hour unauthenticated API limit.)

## The four variants

| File | Style | Best when you want to… |
|------|-------|------------------------|
| `hero.md` | **Hero / product-led** — banner, badges, feature table, big install CTA | Look like a popular, polished repo; maximize install pull |
| `minimal.md` | **Minimal / editorial** — calm prose, understated | Signal a serious, no-hype privacy tool |
| `technical.md` | **Technical / spec-first** — threat-model table, architecture up front | Speak to contributors and skeptics first |
| `mission.md` | **Mission-led** — leads with the "why", narrative hook | Convert readers emotionally, fits the OptOutRights mission |

All four keep the project's **honest-gaps** section and the signed-release install path.

## Screenshots

Each variant references `screenshots/popup.png` (and you can add more). Drop real PNGs
into `prototypes/readme-variants/screenshots/` and they'll appear. Until then the preview
shows a broken-image placeholder where the screenshot goes — that's expected.

Suggested shots: the toolbar popup (the toggle + recap), and the fingerprint test page
(`testpage/fingerprint.html`) showing before/after.
