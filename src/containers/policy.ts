// When to move a tab into its site's container, and when to leave it alone so other container
// extensions (Multi-Account Containers, Containerise...) and the user's own container choices are
// respected. Pure: no extension APIs, so it is unit tested directly.
//
// The rules, checked in order for each top level navigation:
//   1. Multi-Account Containers assigns this URL to a container → leave it. Multi-Account Containers
//      handles it (asks, or reopens in the assigned container), and two extensions moving the same
//      tab is what loops. Unless the user, asked by Multi-Account Containers, chose "Open in No
//      Container": that declines the assigned container, so the site is handled as unassigned.
//   2. Another extension was found to handle this site (see HandoffTracker) → leave it, same reason.
//   3. The tab is in a container we did not create (the user's, another extension's) → leave it.
//   4. The tab is already in the site's own container → leave it.
//   5. Otherwise (default container, or one of our containers for another site) → reopen it in the
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
  /** Multi-Account Containers has an assignment for this URL. */
  assignedByMac: boolean;
  /** Another extension was found to handle this site. */
  handledElsewhere: boolean;
}

export type Decision = "reopen" | "leave";

export function decide(facts: NavigationFacts): Decision {
  if (facts.assignedByMac || facts.handledElsewhere) return "leave";
  if (facts.tabStore === DEFAULT_STORE) return "reopen";
  // Any other store we can't identify as ours (another extension's container, a private window...) is
  // left alone: moving a tab out of a container we did not create is what fights other extensions.
  if (!facts.tabContainer?.ours) return "leave";
  return facts.tabContainer.name === facts.site ? "leave" : "reopen";
}

/**
 * Is `tabUrl` the Multi-Account Containers prompt ("Open in <container>" / "Open in No Container") for
 * `url`? A navigation to `url` that starts from that prompt means the user picked the other option and
 * declined the assigned container: Multi-Account Containers exempts that tab, and we can take over.
 * Its page lives at moz-extension://<id>/confirm-page.html?url=<url>.
 */
export function isMultiAccountContainersPrompt(tabUrl: string, url: string): boolean {
  let page: URL;
  let target: URL;
  try {
    page = new URL(tabUrl);
    target = new URL(url);
  } catch {
    return false;
  }
  if (page.protocol !== "moz-extension:" || page.pathname !== "/confirm-page.html") return false;
  const asked = page.searchParams.get("url");
  if (!asked) return false;
  try {
    // Same host is enough: the page may load a slightly different URL (a redirect, a trailing slash).
    return new URL(asked).hostname === target.hostname;
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
 * What a tab loading a site in a container we did not create means, when we reopened that same site in
 * our container a moment before or after:
 *   - "handoff": the first such tab. Another extension moved the site to the container it assigns, so
 *     the caller remembers the site and stops moving it. Without this, every visit from a normal tab
 *     would be moved twice (by us, then by them).
 *   - "duplicate": another tab for the same site. The other extension reacted to the same navigation
 *     as we did: it reopened the original tab AND the tab we had just opened, so the site is open twice.
 *     The caller closes this one, keeps the first, and remembers the site as for a handoff.
 *   - "none": we did not reopen this site around that time, nothing to do with us.
 * Both orders happen: the other extension often moves the original tab before our reopen is noted, so
 * foreign loads are remembered for a moment too, not only reopens.
 */
export type ForeignLoad = "handoff" | "duplicate" | "none";

export class HandoffTracker {
  // Per site: when we last reopened it in our container.
  private readonly reopenedAt = new Map<string, number>();
  // Per site: the first tab seen loading it in a container we did not create, and when.
  private readonly firstForeign = new Map<string, { tabId: number; store: string; at: number; handedOff: boolean }>();
  private readonly windowMs: number;

  // A plain field rather than a parameter property: the tests run with Node's type stripping, which
  // doesn't support those.
  constructor(windowMs = HANDOFF_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * We are about to reopen `site` in its own container. If a tab already loaded it in another
   * extension's container a moment ago, that extension reacted to the same navigation first: returns
   * that container's cookieStoreId, and the caller must not reopen (it would only be moved again,
   * leaving the site open twice). Null otherwise.
   */
  noteReopen(site: string, now: number): string | null {
    this.prune(now);
    this.reopenedAt.set(site, now);
    const first = this.firstForeign.get(site);
    if (!first || first.handedOff) return null;
    first.handedOff = true;
    return first.store;
  }

  /** Tab `tabId` is loading `site` in the container `store`, which we did not create. */
  onForeignLoad(site: string, tabId: number, store: string, now: number): ForeignLoad {
    this.prune(now);
    const reopened = this.reopenedAt.has(site);
    const first = this.firstForeign.get(site);
    if (!first) {
      this.firstForeign.set(site, { tabId, store, at: now, handedOff: reopened });
      return reopened ? "handoff" : "none";
    }
    if (!reopened) return "none";
    if (tabId !== first.tabId) return "duplicate";
    // The first tab loading again (a redirect, say) is not a duplicate.
    if (first.handedOff) return "none";
    first.handedOff = true;
    return "handoff";
  }

  // Forget anything older than the window, so old entries never match and the maps stay small.
  private prune(now: number): void {
    for (const [site, at] of this.reopenedAt) if (now - at > this.windowMs) this.reopenedAt.delete(site);
    for (const [site, seen] of this.firstForeign) if (now - seen.at > this.windowMs) this.firstForeign.delete(site);
  }
}
