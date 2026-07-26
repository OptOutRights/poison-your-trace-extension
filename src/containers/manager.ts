// One Firefox contextualIdentity (container) per site. Cookies, storage and logins are isolated
// per container, so an action in one site never rejoins another at the cookie or session layer.

/** Colours accepted by contextualIdentities.create, derived so we track the API exactly. */
type ContainerColor = Parameters<typeof browser.contextualIdentities.create>[0]["color"];

export interface Container {
  cookieStoreId: string;
  name: string;
}

export class ContainerManager {
  /** Return the container named `name`, creating it if it does not yet exist. Idempotent. */
  async getOrCreate(name: string, color?: ContainerColor): Promise<Container> {
    const existing = await browser.contextualIdentities.query({ name });
    const found = existing[0];
    if (found) {
      return { cookieStoreId: found.cookieStoreId, name: found.name };
    }
    const created = await browser.contextualIdentities.create({
      name,
      color: color ?? "toolbar",
      icon: "fingerprint",
    });
    return { cookieStoreId: created.cookieStoreId, name: created.name };
  }
}
