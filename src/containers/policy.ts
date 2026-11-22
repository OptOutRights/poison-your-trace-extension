// When to move a tab into its site's container, and when to leave it alone so other container
// extensions (Multi-Account Containers, Containerise...) and the user's own container choices are
// respected. Pure: no extension APIs, so it is unit tested directly.
//
// The rules, checked in order for each top level navigation:
//   1. Another extension was found to handle this site (see HandoffTracker) → leave it: two
//      extensions moving the same tab is what loops.
//   2. The tab is in a container we did not create (the user's, another extension's) → leave it.
//   3. The tab is already in the site's own container → leave it.
//   4. Otherwise (default container, or one of our containers for another site) → reopen it in the
//      site's own container.

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

export function decide(facts: NavigationFacts): Decision {
  if (facts.handledElsewhere) return "leave";
  if (facts.tabStore === DEFAULT_STORE) return "reopen";
  // Any other store we can't identify as ours (another extension's container, a private window...) is
  // left alone: moving a tab out of a container we did not create is what fights other extensions.
  if (!facts.tabContainer?.ours) return "leave";
  return facts.tabContainer.name === facts.site ? "leave" : "reopen";
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
 * our container a moment before or after:
 *   - "handoff": the first such tab. Another extension moved the site to the container it assigns, so
 *     the caller remembers the site and stops moving it. Without this, every visit from a normal tab
 *     would be moved twice (by us, then by them).
 *   - "duplicate": another tab for the same URL. The other extension reacted to the same navigation
 *     as we did: it reopened the original tab AND the tab we had just opened, so the URL is open twice.
 *     The caller closes this one, keeps the first, and remembers the site as for a handoff.
 *   - "none": we did not reopen this URL around that time, nothing to do with us.
 * Both orders happen: the other extension often moves the original tab before our reopen is noted, so
 * foreign loads are remembered for a moment too, not only reopens.
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
  private readonly firstForeign = new Map<string, { tabId: number; store: string; at: number; handedOff: boolean }>();
  private readonly windowMs: number;

  // A plain field rather than a parameter property: the tests run with Node's type stripping, which
  // doesn't support those.
  constructor(windowMs = HANDOFF_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * We are about to reopen `url` in its site's container. If a tab already loaded it in another
   * extension's container a moment ago, that extension reacted to the same navigation first: returns
   * that container's cookieStoreId, and the caller must not reopen (it would only be moved again,
   * leaving the URL open twice). Null otherwise.
   */
  noteReopen(url: string, now: number): string | null {
    this.prune(now);
    this.reopenedAt.set(url, now);
    const first = this.firstForeign.get(url);
    if (!first || first.handedOff) return null;
    first.handedOff = true;
    return first.store;
  }

  /** Tab `tabId` is loading `url` in the container `store`, which we did not create. */
  onForeignLoad(url: string, tabId: number, store: string, now: number): ForeignLoad {
    this.prune(now);
    const reopened = this.reopenedAt.has(url);
    const first = this.firstForeign.get(url);
    if (!first) {
      this.firstForeign.set(url, { tabId, store, at: now, handedOff: reopened });
      return reopened ? "handoff" : "none";
    }
    if (!reopened) return "none";
    if (tabId !== first.tabId) return "duplicate";
    // The first tab loading the same URL again is not a duplicate.
    if (first.handedOff) return "none";
    first.handedOff = true;
    return "handoff";
  }

  // Forget anything older than the window, so old entries never match and the maps stay small.
  private prune(now: number): void {
    for (const [url, at] of this.reopenedAt) if (now - at > this.windowMs) this.reopenedAt.delete(url);
    for (const [url, seen] of this.firstForeign) if (now - seen.at > this.windowMs) this.firstForeign.delete(url);
  }
}
