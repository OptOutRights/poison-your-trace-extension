// Serve testpage/ over http with a strict Content-Security-Policy HEADER.
//
// Why a header and not a <meta http-equiv> tag: a meta CSP is only enforced once the HTML parser
// reaches the tag, which is AFTER content scripts inject at document_start. So a meta CSP fails to
// block the old inline-<script> injection and gives a false pass. Real strict-CSP sites (banks, big
// tech) send the header, active from the first byte. This is the faithful reproduction of the
// scenario the world:"MAIN" migration (issue #36) targets.
//
// Usage: npm run testpage:csp   then open http://127.0.0.1:8778/fingerprint-csp.html
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Serve from this file's own directory (testpage/) regardless of the caller's cwd.
const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8778;
const CSP = "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };

createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  // Default to the strict-CSP page; strip any leading ../ so the request cannot escape ROOT.
  const rel = normalize(urlPath === "/" ? "/fingerprint-csp.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, {
      "Content-Type": TYPES[extname(rel)] || "application/octet-stream",
      "Content-Security-Policy": CSP,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`testpage CSP server: http://127.0.0.1:${PORT}/fingerprint-csp.html`);
  console.log(`Content-Security-Policy: ${CSP}`);
});
