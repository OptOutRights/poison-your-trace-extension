// One Firefox contextualIdentity (container) per site. Cookies, storage and logins are isolated
// per container, so an action in one site never rejoins another at the cookie or session layer.
//
// Also remembers two things, so we never fight other container extensions or the user:
//   - which containers are ours (we only ever move tabs out of the default container or ours);
//   - which sites another extension handles (see HandoffTracker in ./policy).

import { registrableDomain } from "./domain";
import { OUR_ICON, looksLikeOurs } from "./policy";

/** Colours accepted by contextualIdentities.create, derived so we track the API exactly. */
type ContainerColor = Parameters<typeof browser.contextualIdentities.create>[0]["color"];

export interface Container {
  cookieStoreId: string;
  name: string;
}

// cookieStoreIds of the containers we created.
const OWN_KEY = "poisonyourtrace.ownContainers";
// Sites another container extension handles: site → cookieStoreId of the container it moved them to.
const HANDLED_ELSEWHERE_KEY = "poisonyourtrace.handledElsewhere";

export class ContainerManager {
  // In flight resolutions keyed by container name. Two navigations to the same brand new site can
  // land in getOrCreate at once; without this cache both would query (find nothing) and both would
  // create, leaving duplicate containers in the Firefox picker. Sharing one promise per name means
  // the second caller awaits the first caller's create instead of racing it.
  private readonly inFlight = new Map<string, Promise<Container>>();

  // Storage updates below are read-modify-write: run them one after another so two at once (two new
  // sites opened together) can't overwrite each other.
  private writes: Promise<void> = Promise.resolve();

  private serialize(task: () => Promise<void>): Promise<void> {
    const run = this.writes.then(task);
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** Return the container named `name`, creating it if it does not yet exist. Idempotent. */
  async getOrCreate(name: string, color?: ContainerColor): Promise<Container> {
    const pending = this.inFlight.get(name);
    if (pending) return pending;

    const resolution = this.resolve(name, color);
    this.inFlight.set(name, resolution);
    try {
      return await resolution;
    } finally {
      this.inFlight.delete(name);
    }
  }

  private async resolve(name: string, color?: ContainerColor): Promise<Container> {
    const existing = await browser.contextualIdentities.query({ name });
    const found = existing[0];
    if (found) {
      return { cookieStoreId: found.cookieStoreId, name: found.name };
    }
    const created = await browser.contextualIdentities.create({
      name,
      color: color ?? "toolbar",
      icon: OUR_ICON,
    });
    await this.updateOwn((own) => own.add(created.cookieStoreId));
    return { cookieStoreId: created.cookieStoreId, name: created.name };
  }

  /**
   * The container a tab is in: its name and whether we created it. Null for the default container,
   * or when it can't be read (a private window, a container removed meanwhile).
   */
  async describe(cookieStoreId: string): Promise<{ name: string; ours: boolean } | null> {
    let identity: browser.contextualIdentities.ContextualIdentity;
    try {
      identity = await browser.contextualIdentities.get(cookieStoreId);
    } catch {
      return null;
    }
    if (!identity) return null;
    const own = await this.loadOwn();
    // Containers created before ours were recorded are recognised by their icon and name.
    const ours = own.has(cookieStoreId) || looksLikeOurs(identity, registrableDomain);
    return { name: identity.name, ours };
  }

  /** Is `site` handled by another container extension? */
  async isHandledElsewhere(site: string): Promise<boolean> {
    return site in (await this.loadHandledElsewhere());
  }

  /** Remember that another extension moved `site` into the container `cookieStoreId`. */
  markHandledElsewhere(site: string, cookieStoreId: string): Promise<void> {
    return this.serialize(async () => {
      const map = await this.loadHandledElsewhere();
      map[site] = cookieStoreId;
      await browser.storage.local.set({ [HANDLED_ELSEWHERE_KEY]: map });
    });
  }

  /** Forget that another extension handles `site`: we put it in its own container again. */
  forgetHandledElsewhere(site: string): Promise<void> {
    return this.serialize(async () => {
      const map = await this.loadHandledElsewhere();
      if (!(site in map)) return;
      delete map[site];
      await browser.storage.local.set({ [HANDLED_ELSEWHERE_KEY]: map });
    });
  }

  /** A container was removed: drop it from our records, and forget the sites that were handed to it. */
  async onContainerRemoved(cookieStoreId: string): Promise<void> {
    await this.updateOwn((own) => own.delete(cookieStoreId));
    await this.serialize(async () => {
      const map = await this.loadHandledElsewhere();
      const sites = Object.keys(map).filter((site) => map[site] === cookieStoreId);
      if (sites.length === 0) return;
      for (const site of sites) delete map[site];
      await browser.storage.local.set({ [HANDLED_ELSEWHERE_KEY]: map });
    });
  }

  private async loadOwn(): Promise<Set<string>> {
    const stored = await browser.storage.local.get(OWN_KEY);
    const raw: unknown = stored[OWN_KEY];
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []);
  }

  private updateOwn(change: (own: Set<string>) => unknown): Promise<void> {
    return this.serialize(async () => {
      const own = await this.loadOwn();
      change(own);
      await browser.storage.local.set({ [OWN_KEY]: [...own] });
    });
  }

  private async loadHandledElsewhere(): Promise<Record<string, string>> {
    const stored = await browser.storage.local.get(HANDLED_ELSEWHERE_KEY);
    const raw: unknown = stored[HANDLED_ELSEWHERE_KEY];
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, string>) } : {};
  }
}
