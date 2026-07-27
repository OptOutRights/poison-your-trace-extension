// PROTOTYPE — throwaway README preview. Delete this whole folder once a variant is chosen.
//
// Renders each candidate README through GitHub's OWN markdown API
// (POST https://api.github.com/markdown), so what you see is byte-for-byte what
// GitHub will show on the repo page. Wrapped in github-markdown-css + the same
// max-width column GitHub uses. A floating bottom bar switches variants.
//
//   node prototypes/readme-variants/preview.mjs
//   → open http://localhost:5178
//
// Unauthenticated GitHub API allows 60 renders/hour; results are cached in memory
// so flipping between variants is free. Set GITHUB_TOKEN to raise the limit.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const PORT = 5178;

const VARIANTS = [
  { id: "hero", label: "Hero / product-led" },
  { id: "minimal", label: "Minimal / editorial" },
  { id: "technical", label: "Technical / spec-first" },
  { id: "mission", label: "Mission-led" },
];

// The URL path GitHub-relative links resolve against (matches the variant file's
// location in the repo), so ../../icons and screenshots/ resolve exactly as on GitHub.
const BASE_HREF = "/prototypes/readme-variants/";

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".woff2": "font/woff2", ".css": "text/css", ".md": "text/markdown",
};

const renderCache = new Map();

async function renderWithGitHub(markdown) {
  if (renderCache.has(markdown)) return renderCache.get(markdown);
  const headers = { "Content-Type": "application/json", "User-Agent": "pyt-readme-preview" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch("https://api.github.com/markdown", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: markdown, mode: "gfm" }),
  });
  if (!res.ok) {
    const hint = res.status === 403
      ? "GitHub API rate limit hit (60/hour unauthenticated). Set GITHUB_TOKEN and restart."
      : `GitHub markdown API returned ${res.status}.`;
    throw new Error(hint);
  }
  const html = await res.text();
  renderCache.set(markdown, html);
  return html;
}

function page(variantId, bodyHtml, note) {
  const tabs = VARIANTS.map(v =>
    `<a href="/?variant=${v.id}" class="tab${v.id === variantId ? " on" : ""}">${v.label}</a>`
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base href="${BASE_HREF}" />
<title>README preview — ${variantId}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown-light.min.css" />
<style>
  body { margin: 0; background: #f6f8fa; color: #1f2328;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .wrap { max-width: 1012px; margin: 0 auto; padding: 32px 16px 120px; }
  .repohead { display: flex; align-items: center; gap: 8px; font-size: 20px;
    padding: 12px 4px 20px; color: #59636e; border-bottom: 1px solid #d1d9e0; margin-bottom: 24px; }
  .repohead b { color: #0969da; font-weight: 600; }
  .card { background: #fff; border: 1px solid #d1d9e0; border-radius: 6px; }
  .card > .filehead { padding: 8px 16px; border-bottom: 1px solid #d1d9e0;
    font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .markdown-body { box-sizing: border-box; padding: 32px 45px; }
  .note { max-width: 1012px; margin: 40px auto; padding: 20px 24px; background: #fff8c5;
    border: 1px solid #d4a72c66; border-radius: 6px; font-size: 14px; }
  .bar { position: fixed; left: 50%; transform: translateX(-50%); bottom: 20px; z-index: 10;
    display: flex; gap: 4px; padding: 6px; background: #1f2328; border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,.28); }
  .tab { font-size: 13px; color: #d1d9e0; text-decoration: none; padding: 8px 14px;
    border-radius: 7px; white-space: nowrap; }
  .tab:hover { background: #ffffff1a; }
  .tab.on { background: #0a7d3c; color: #fff; }
  @media (max-width: 640px) { .markdown-body { padding: 20px; } .bar { flex-wrap: wrap; } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="repohead">📄 OptOutRights / <b>poison-your-trace-web-extension</b></div>
    ${note ? `<div class="note">${note}</div>` : ""}
    <div class="card">
      <div class="filehead">📘 README.md <span style="font-weight:400;color:#59636e;">— “${variantId}” candidate</span></div>
      <article class="markdown-body">${bodyHtml}</article>
    </div>
  </div>
  <nav class="bar">${tabs}</nav>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // The preview page itself.
    if (url.pathname === "/" || url.pathname === "") {
      const variantId = url.searchParams.get("variant") || VARIANTS[0].id;
      const variant = VARIANTS.find(v => v.id === variantId) || VARIANTS[0];
      const md = await readFile(join(HERE, `${variant.id}.md`), "utf8");
      let bodyHtml = "", note = "";
      try {
        bodyHtml = await renderWithGitHub(md);
      } catch (e) {
        note = `⚠️ ${e.message} Showing raw markdown as a fallback.`;
        bodyHtml = `<pre>${md.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</pre>`;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page(variant.id, bodyHtml, note));
      return;
    }

    // Everything else: static file from the repo root (icons, screenshots, fonts).
    const filePath = join(REPO_ROOT, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(REPO_ROOT)) { res.writeHead(403).end("no"); return; }
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found (a screenshot placeholder may be missing — see the README in this folder).");
  }
});

server.listen(PORT, () => {
  console.log(`\n  README preview → http://localhost:${PORT}\n`);
  console.log("  Variants: " + VARIANTS.map(v => v.id).join(", "));
  console.log("  Rendered through GitHub's markdown API (exact GitHub styling).");
  console.log("  Drop screenshots into prototypes/readme-variants/screenshots/ to fill the placeholders.\n");
});
