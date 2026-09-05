// Auto containering: every site you browse is opened in its OWN container, automatically, so
// cookies, logins and storage never cross from one site to another.
//
// Pattern (same as Mozilla's Multi-Account Containers): intercept every top level navigation; if
// the tab is not already in the container that site belongs to, cancel the request, reopen the
// same URL in the correct container, and drop the old tab. The reopened tab is already in the
// right container, so its navigation is allowed through, no loop.

import { loadConfig } from "../config";
import { ContainerManager } from "./manager";

type BlockingResponse = browser.webRequest.BlockingResponse;
type Details = browser.webRequest._OnBeforeRequestDetails;

// A few common multi label public suffixes so `foo.co.uk` groups under `foo.co.uk`, not `co.uk`.
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "com.au", "co.nz", "com.br", "co.in",
]);

// Firefox container colours; we pick one deterministically per domain so distinct sites are
// visibly distinct in the tab bar (and the same site always gets the same colour).
const COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"] as const;

/** The registrable domain ("example.com" for "www.shop.example.com"). One container per this. */
export function registrableDomain(hostname: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname; // raw IPv4 maps to itself
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const lastTwo = parts.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

function colorForDomain(domain: string): (typeof COLORS)[number] {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

/** Parse a web (http/https) URL, or null for anything unparseable or non web (about:, file:, ...). */
function parseWebUrl(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u : null;
}

/**
 * Is this URL a Google *search results* page? Conservative on purpose: host must be a Google web
 * search domain (`www.google.com`, `google.co.uk`, `www.google.de`, ...) AND the path must be the
 * search endpoint (`/search`). We match the registrable domain `google.*` rather than an exact
 * host so ccTLDs (google.fr, google.co.jp, ...) are covered, but we reject Google *properties* that
 * are not web search (mail.google.com, docs.google.com, maps.google.com, ...) via the `/search`
 * path check — losing the "go back to my results" affordance only matters on a results page.
 */
export function isGoogleSearch(url: string): boolean {
  const u = parseWebUrl(url);
  if (!u) return false;
  // registrableDomain collapses `www.google.com` -> `google.com` and multi label ccTLDs like
  // `www.google.co.uk` -> `google.co.uk`, so `google.` prefix matches every real Google web search
  // host. It also rejects look-alikes like `google.evil.com`, whose registrable domain is `evil.com`.
  if (!registrableDomain(u.hostname).startsWith("google.")) return false;
  return u.pathname === "/search";
}

/**
 * The container a URL belongs to: one per registrable domain. Returns null for non web URLs
 * (about:, moz-extension:, file:) which must never be re containered.
 */
export function targetFor(url: string): { name: string; color: (typeof COLORS)[number] } | null {
  const u = parseWebUrl(url);
  if (!u) return null;
  const domain = registrableDomain(u.hostname);
  return { name: domain, color: colorForDomain(domain) };
}

/** Reassigns top level navigations into per site containers. Enabled whenever the extension is on. */
export class AutoContainer {
  private listening = false;
  constructor(private readonly containers: ContainerManager) {}

  private readonly handler = async (details: Details): Promise<BlockingResponse> => {
    if (details.tabId < 0) return {}; // not a real tab (background fetch, prefetch, etc.)

    const config = await loadConfig();
    if (!config.enabled) return {};

    const target = targetFor(details.url);
    if (!target) return {};

    // Read the tab BEFORE creating any container, so a navigation whose tab has already gone away
    // (fast close, prerender discarded) never leaves an orphan container behind in the picker.
    let tab: browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(details.tabId);
    } catch {
      return {}; // tab vanished mid flight
    }

    const container = await this.containers.getOrCreate(target.name, target.color);
    if (tab.cookieStoreId === container.cookieStoreId) return {}; // already in the right container

    // Wrong container: reopen this URL in the correct one. The reopened tab starts in the right
    // container, so its own navigation passes straight through, no loop.
    //
    // Structural limitation: a Firefox tab is bound to ONE cookieStoreId for its whole life, and
    // there is no API to move a tab's session history across containers (Mozilla's own Multi
    // Account Containers hits the exact same wall). So a cross container navigation can never be an
    // in place redirect that preserves "back" — the destination MUST land in a fresh tab, which
    // starts with empty session history. Normally we then remove the source tab (reopen in place),
    // but that is precisely what strands the user: click a Google result, land in a new tab, and
    // "back" can no longer return to the search because the tab that held that history is gone.
    //
    // Mitigation (Google search only, for now): when the source tab is sitting on a Google search
    // results page, we KEEP it alive instead of removing it. The result opens in the new containered
    // tab; the search stays put in its own tab, one click / Ctrl+W away — the closest thing to
    // "back" that the container model permits. We scope this to Google because it is the highest
    // traffic case and we want a conservative, well understood match; extending the same treatment
    // to Bing / DuckDuckGo / social feeds is tracked as issue #58 and is out of scope here.
    const keepSource = isGoogleSearch(tab.url ?? "");
    await browser.tabs.create({
      url: details.url,
      cookieStoreId: container.cookieStoreId,
      index: tab.index,
      active: tab.active,
      windowId: tab.windowId,
    });
    if (!keepSource) await browser.tabs.remove(details.tabId);
    return { cancel: true };
  };

  enable(): void {
    if (this.listening) return;
    browser.webRequest.onBeforeRequest.addListener(
      this.handler,
      { urls: ["<all_urls>"], types: ["main_frame"] },
      ["blocking"],
    );
    this.listening = true;
  }

  disable(): void {
    if (this.listening && browser.webRequest.onBeforeRequest.hasListener(this.handler)) {
      browser.webRequest.onBeforeRequest.removeListener(this.handler);
    }
    this.listening = false;
  }
}
