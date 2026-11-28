// When to move a tab into its site's container, and when to leave it alone so other container
// extensions (Multi-Account Containers, Containerise...) and the user's own container choices are
// respected. Pure: no extension APIs, so it is unit tested directly.
//
// The rules, checked in order for each top level navigation:
//   1. The tab is in the default container and another extension was found to handle this site (see
//      HandoffTracker) → leave it to that extension: two extensions moving the same tab is what loops.
//   2. The tab is in a container we did not create (the user's, another extension's) → leave it.
//   3. The tab is already in the site's own container → leave it.
//   4. Otherwise (default container, or one of our containers for another site) → reopen it in the
//      site's own container. Even for a site another extension handles: left in our container for
//      another site, it would share that site's cookies whenever the other extension doesn't move it.
//      Reopened in its own container, it stays isolated, and the other extension can still move it
//      from there without a loop, since we never move a tab out of its container.
//
// Before any of these, some navigations always stay in the tab's container (see staysInTab): moving a
// tab means cancelling the request and reopening its URL in a new tab, which only works for a plain GET
// in a normal tab. That is what keeps form posts working.

/** cookieStoreId of tabs that are in no container. */
export const DEFAULT_STORE = "firefox-default";

/** Icon we give the containers we create. */
export const OUR_ICON = "fingerprint";

/** How long after we reopen a site in our container another extension's move of it counts as a
 *  handoff (see HandoffTracker). Short, to limit false positives. */
export const HANDOFF_WINDOW_MS = 2000;

export interface NavigationFacts {
  /** The site being opened, i.e. the name of its own container (its registrable domain). */
  site: string;
  /** cookieStoreId of the tab the navigation happens in. */
  tabStore: string;
  /** That tab's container, or null when it is the default container or could not be read. */
  tabContainer: { name: string; ours: boolean } | null;
  /** Another extension was found to handle this site. */
  handledElsewhere: boolean;
}

export type Decision = "reopen" | "leave";

export interface RequestFacts {
  /** HTTP method of the navigation. */
  method: string;
  /** The navigation is a redirect of a request that already had to stay in its tab. */
  followsStayingRequest: boolean;
}

/**
 * Must this navigation stay in the tab's current container, whatever its site? Reopening a URL in
 * another container is a new GET in a new tab, so it is only done when that loses nothing:
 *   - Not a GET (in practice a form POST: "Sign in with Apple", Microsoft and SAML callbacks, 3-D Secure
 *     payments...): the reopen would drop the body and replay it as a GET, which breaks the flow.
 *     Navigations are only ever GET or POST; anything not a GET stays, to be safe.
 *   - A redirect of such a request (POST, then 303 to a result page): its cookies were just set in this
 *     container, so the rest of the redirect chain must load there too.
 */
export function staysInTab(facts: RequestFacts): boolean {
  return facts.method !== "GET" || facts.followsStayingRequest;
}

/** How long a request that stayed in its tab is remembered, to recognise its redirects. */
export const STAYING_REQUEST_MS = 30_000;

/**
 * Remembers the requests that stayed in their tab (see staysInTab), so their redirects stay too. Firefox
 * keeps the same requestId across the redirects of a navigation.
 */
export class StayingRequests {
  private readonly keptAt = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowMs = STAYING_REQUEST_MS) {
    this.windowMs = windowMs;
  }

  keep(requestId: string, now: number): void {
    this.prune(now);
    this.keptAt.set(requestId, now);
  }

  has(requestId: string, now: number): boolean {
    this.prune(now);
    return this.keptAt.has(requestId);
  }

  private prune(now: number): void {
    for (const [id, at] of this.keptAt) if (now - at > this.windowMs) this.keptAt.delete(id);
  }
}

export function decide(facts: NavigationFacts): Decision {
  if (facts.tabStore === DEFAULT_STORE) return facts.handledElsewhere ? "leave" : "reopen";
  // Any other store we can't identify as ours (another extension's container, a private window...) is
  // left alone: moving a tab out of a container we did not create is what fights other extensions.
  if (!facts.tabContainer?.ours) return "leave";
  return facts.tabContainer.name === facts.site ? "leave" : "reopen";
}

/**
 * Does this cookie belong to `site`: set by the site itself (any of its subdomains), or by a third party
 * while the site was the top level page (partitioned under it)? `siteOf` maps a hostname to its site.
 */
export function cookieBelongsToSite(
  cookie: { domain: string; partitionKey?: { topLevelSite?: string } | null },
  site: string,
  siteOf: (host: string) => string,
): boolean {
  if (siteOf(cookie.domain.replace(/^\./, "")) === site) return true;
  const topLevel = cookie.partitionKey?.topLevelSite;
  if (!topLevel) return false;
  try {
    return siteOf(new URL(topLevel).hostname) === site;
  } catch {
    return false;
  }
}

/**
 * Containers created before we recorded our own ids: ours if they carry our icon and are named after
 * a site, as getOrCreate names them. `siteOf` maps a hostname to its site (registrableDomain).
 */
export function looksLikeOurs(identity: { name: string; icon: string }, siteOf: (host: string) => string): boolean {
  // A dot is required: a word like "Personal" has no registrable domain, so siteOf maps it to itself.
  const name = identity.name;
  return identity.icon === OUR_ICON && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name) && siteOf(name) === name;
}

/**
 * What a tab loading a URL in a container we did not create means, when we reopened that same URL in
 * our container a moment before:
 *   - "handoff": the first such tab after our reopen. Another extension moved the URL to the container
 *     it assigns, so the caller remembers the site and stops moving it. Without this, every visit from a
 *     normal tab would be moved twice (by us, then by them).
 *   - "duplicate": a second tab for that URL. The other extension reacted to the same navigation as we
 *     did: it reopened the original tab AND the tab we had just opened, so the URL is open twice. The
 *     caller closes this one, keeps the first, and remembers the site as for a handoff.
 *   - "none": we did not reopen this URL just before, nothing to do with us.
 *
 * Only a reopen of ours makes a foreign load count. A tab that loaded the URL before our reopen proves
 * nothing on its own: it may be the other extension reacting faster than us, or just the user browsing
 * that URL in a container of their own. So it never counts as a handoff, and we still reopen. If it was
 * the other extension, it moves our tab too, and that second tab is caught as a duplicate.
 *
 * Keyed by URL, not by site: several pages of the same site opened together ("Open All in Tabs",
 * session restore) are distinct navigations, and none of them is a duplicate of another. Other
 * extensions reopen a tab with the exact URL of its request, as we do, so a real duplicate always
 * carries the URL we reopened.
 */
export type ForeignLoad = "handoff" | "duplicate" | "none";

export class HandoffTracker {
  // Per URL: when we last reopened it in our container.
  private readonly reopenedAt = new Map<string, number>();
  // Per URL: the first tab seen loading it in a container we did not create, and when.
  private readonly firstForeign = new Map<string, { tabId: number; at: number }>();
  private readonly windowMs: number;

  // A plain field rather than a parameter property: the tests run with Node's type stripping, which
  // doesn't support those.
  constructor(windowMs = HANDOFF_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /** We are about to reopen `url` in its site's container. */
  noteReopen(url: string, now: number): void {
    this.prune(now);
    this.reopenedAt.set(url, now);
  }

  /** Tab `tabId` is loading `url` in a container we did not create. */
  onForeignLoad(url: string, tabId: number, now: number): ForeignLoad {
    this.prune(now);
    const reopened = this.reopenedAt.has(url);
    const first = this.firstForeign.get(url);
    if (!first) {
      this.firstForeign.set(url, { tabId, at: now });
      return reopened ? "handoff" : "none";
    }
    // The first tab loading the same URL again (a reload, say) is not a duplicate.
    if (!reopened || tabId === first.tabId) return "none";
    return "duplicate";
  }

  // Forget anything older than the window, so old entries never match and the maps stay small.
  private prune(now: number): void {
    for (const [url, at] of this.reopenedAt) if (now - at > this.windowMs) this.reopenedAt.delete(url);
    for (const [url, seen] of this.firstForeign) if (now - seen.at > this.windowMs) this.firstForeign.delete(url);
  }
}
