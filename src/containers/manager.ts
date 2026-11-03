// One Firefox contextualIdentity (container) per site. Cookies, storage and logins are isolated
// per container, so an action in one site never rejoins another at the cookie or session layer.

import type { ContainerCleanup } from "./cleanup";
import type { ContainerRegistry } from "./registry";

/** Colours accepted by contextualIdentities.create, derived so we track the API exactly. */
type ContainerColor = Parameters<typeof browser.contextualIdentities.create>[0]["color"];

export interface Container {
  cookieStoreId: string;
  name: string;
}

export class ContainerManager {
  constructor(
    private readonly registry: ContainerRegistry,
    private readonly cleanup: ContainerCleanup,
  ) {}

  // In flight resolutions keyed by container name. Two navigations to the same brand new site can
  // land in getOrCreate at once; without this cache both would query (find nothing) and both would
  // create, leaving duplicate containers in the Firefox picker. Sharing one promise per name means
  // the second caller awaits the first caller's create instead of racing it.
  private readonly inFlight = new Map<string, Promise<Container>>();

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
    await this.registry.ready();
    const existing = await browser.contextualIdentities.query({ name });
    // Only reuse a container we created: a user's own container with the same name is left alone.
    // Checking ownership and marking it used happen in one synchronous step, so a pending cleanup
    // either aborts or has already dropped it (and we create a fresh one below).
    const found = existing.find((c) => this.registry.has(c.cookieStoreId));
    if (found) {
      this.cleanup.markUsed(found.cookieStoreId);
      return { cookieStoreId: found.cookieStoreId, name: found.name };
    }
    const created = await browser.contextualIdentities.create({
      name,
      color: color ?? "toolbar",
      icon: "fingerprint",
    });
    this.registry.add(created.cookieStoreId);
    this.cleanup.markUsed(created.cookieStoreId);
    return { cookieStoreId: created.cookieStoreId, name: created.name };
  }
}
