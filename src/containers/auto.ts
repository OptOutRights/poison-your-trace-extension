// Auto containering: every site you browse is opened in its OWN container, automatically, so
// cookies, logins and storage never cross from one site to another.
//
// Pattern (same as Mozilla's Multi-Account Containers): intercept every top level navigation; if
// the tab is not already in the container that site belongs to, cancel the request, reopen the
// same URL in the correct container, and drop the old tab. The reopened tab is already in the
// right container, so its navigation is allowed through, no loop.
//
// Other container extensions (Multi-Account Containers, Containerise...) also move tabs between
// containers. To never fight them, a tab is only moved out of the default container or one of ours,
// never out of a container someone else chose; see ./policy for the full rules.

import { loadConfig } from "../config";
import { registrableDomain } from "./domain";
import { clearSiteCookiesFromDefaultStore } from "./cleanup";
import { ContainerManager } from "./manager";
import { DEFAULT_STORE, HANDOFF_WINDOW_MS, HandoffTracker, decide } from "./policy";

type BlockingResponse = browser.webRequest.BlockingResponse;
type Details = browser.webRequest._OnBeforeRequestDetails;

// Firefox container colours; we pick one deterministically per domain so distinct sites are
// visibly distinct in the tab bar (and the same site always gets the same colour).
const COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"] as const;

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
  private readonly handoffs = new HandoffTracker();
  constructor(private readonly containers: ContainerManager) {}

  private readonly handler = async (details: Details): Promise<BlockingResponse> => {
    if (details.tabId < 0) return {}; // not a real tab (background fetch, prefetch, etc.)

    const config = await loadConfig();
    if (!config.enabled) return {};

    const target = targetFor(details.url);
    if (!target) return {};
    const site = target.name;

    // Read the tab BEFORE creating any container, so a navigation whose tab has already gone away
    // (fast close, prerender discarded) never leaves an orphan container behind in the picker.
    let tab: browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(details.tabId);
    } catch {
      return {}; // tab vanished mid flight
    }
    const tabStore = tab.cookieStoreId ?? DEFAULT_STORE;

    // Everything decide() needs, read in parallel. None of it creates a container, so a site another
    // extension handles gets no container of ours when it is left to that extension.
    const [handledElsewhere, tabContainer] = await Promise.all([
      this.containers.isHandledElsewhere(site),
      tabStore === DEFAULT_STORE ? Promise.resolve(null) : this.containers.describe(tabStore),
    ]);

    // We just moved this site into our container and another extension moved it straight on into one
    // of its own: it handles this site, so stop moving it (rule 1). Only for a container we could read
    // and did not create (not a private window, say).
    if (tabContainer && !tabContainer.ours) {
      const load = this.handoffs.onForeignLoad(details.url, details.tabId, Date.now());
      if (load !== "none") {
        console.info(`[poison] another extension handles ${site}; leaving it to that extension from now on.`);
        await this.containers.markHandledElsewhere(site, tabStore);
      }
      if (load === "duplicate") {
        // The other extension also reopened the tab we had just opened: this URL is now open twice.
        // Keep the first tab and close this one.
        console.info(`[poison] closing a duplicate ${site} tab opened by another container extension.`);
        await browser.tabs.remove(details.tabId).catch(() => undefined);
        return { cancel: true };
      }
    }
    // A site handed to another extension that now loads in a normal tab and stays there: that
    // extension no longer handles it, so take it back from the next navigation on.
    if (handledElsewhere && tabStore === DEFAULT_STORE) this.checkStillHandledElsewhere(details.tabId, site, DEFAULT_STORE);

    const decision = decide({ site, tabStore, tabContainer, handledElsewhere });
    if (decision === "leave") return {};

    const container = await this.containers.getOrCreate(target.name, target.color);
    if (tabStore === container.cookieStoreId) return {}; // already in the right container

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
    // If another extension moves the tab we are about to open, its load in that extension's container
    // will be matched against this reopen (see HandoffTracker).
    this.handoffs.noteReopen(details.url, Date.now());
    const reopened = await browser.tabs.create({
      url: details.url,
      cookieStoreId: container.cookieStoreId,
      index: tab.index,
      active: tab.active,
      windowId: tab.windowId,
    });
    // A site handed to another extension, reopened from one of our containers: if it stays in its own
    // container, that extension no longer handles it, so stop leaving it to that extension.
    if (handledElsewhere && reopened.id !== undefined) {
      this.checkStillHandledElsewhere(reopened.id, site, container.cookieStoreId);
    }
    // The tab may already be gone: another extension reacting faster than us closes it too.
    if (!keepSource) await browser.tabs.remove(details.tabId).catch(() => undefined);
    return { cancel: true };
  };

  /**
   * After a moment, if the tab is still in `store` on `site`, no extension moved it: the one that
   * handled the site is gone or no longer assigns it. Forget the handoff so the site gets its own
   * container again. If the tab was closed or moved, the other extension still acts.
   *
   * From the default container, this visit has already loaded there, unisolated: move the tab to the
   * site's own container right away, and clear the cookies the site left in the default container.
   */
  private checkStillHandledElsewhere(tabId: number, site: string, store: string): void {
    setTimeout(() => {
      void (async () => {
        let tab: browser.tabs.Tab;
        try {
          tab = await browser.tabs.get(tabId);
        } catch {
          return; // Tab closed: the other extension replaced it, so it still handles the site.
        }
        if ((tab.cookieStoreId ?? DEFAULT_STORE) !== store) return;
        const target = targetFor(tab.url ?? "");
        if (!tab.url || target?.name !== site) return;
        try {
          console.info(`[poison] no extension handles ${site} anymore; giving it its own container again.`);
          // Forget first, so the reopened tab's navigation is not left to the other extension again.
          await this.containers.forgetHandledElsewhere(site);
          if (store !== DEFAULT_STORE) return; // already in its own container

          const container = await this.containers.getOrCreate(site, target.color);
          await browser.tabs.create({
            url: tab.url,
            cookieStoreId: container.cookieStoreId,
            index: tab.index,
            active: tab.active,
            windowId: tab.windowId,
          });
          // Remove the tab before clearing, so the page can't set its cookies again meanwhile.
          await browser.tabs.remove(tabId).catch(() => undefined);
          const cleared = await clearSiteCookiesFromDefaultStore(site);
          if (cleared) console.info(`[poison] cleared ${cleared} ${site} cookie(s) left in the default container.`);
        } catch (error) {
          console.warn(`[poison] could not give ${site} its own container again:`, error);
        }
      })();
    }, HANDOFF_WINDOW_MS);
  }

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
