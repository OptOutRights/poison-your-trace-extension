// The containers this extension created, by cookieStoreId. It is the only source of truth for
// "ours": containers are never recognised by name, so a container the user (or another extension,
// like Multi-Account Containers) created with a site's name is never reused nor deleted.
//
// Only ids are stored, never site names: the names already live in Firefox's own container list,
// and an entry is dropped as soon as its container is removed, so this adds no browsing history.

const STORAGE_KEY = "poisonyourtrace.containers";
const MIGRATED_KEY = "poisonyourtrace.containersMigrated";

/**
 * Does a container name look like one this extension creates (a registrable domain, localhost or
 * an IP)? Used once, to adopt containers created by versions that had no registry.
 */
export function looksLikeSite(name: string): boolean {
  if (name === "localhost") return true;
  if (/^\[[0-9a-f:.]+\]$/i.test(name)) return true; // IPv6 host
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name); // domain or IPv4, no spaces
}

export class ContainerRegistry {
  private readonly ids = new Set<string>();
  private loading: Promise<void> | null = null;
  // Writes are chained so an older snapshot can never land after a newer one.
  private saving: Promise<void> = Promise.resolve();

  /**
   * Load the registry from storage and run the one time migration, once. Every other method assumes
   * this has resolved: looking a container up before old containers are adopted would create a
   * duplicate next to them. A failure is not cached, so the next call retries.
   */
  ready(): Promise<void> {
    this.loading ??= this.load().catch((error) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  /** A fresh install has no containers from older versions: mark the migration as done. */
  async skipMigration(): Promise<void> {
    await browser.storage.local.set({ [MIGRATED_KEY]: true });
  }

  private async load(): Promise<void> {
    const stored = await browser.storage.local.get([STORAGE_KEY, MIGRATED_KEY]);
    const ids = stored[STORAGE_KEY];
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") this.ids.add(id);
    if (!stored[MIGRATED_KEY]) await this.adoptLegacy();
  }

  // has/add/delete are synchronous on purpose: the cleanup and the container lookup each check and
  // update ownership in one synchronous step, so they can never interleave half way.
  has(cookieStoreId: string): boolean {
    return this.ids.has(cookieStoreId);
  }

  add(cookieStoreId: string): void {
    this.ids.add(cookieStoreId);
    this.save();
  }

  delete(cookieStoreId: string): void {
    if (this.ids.delete(cookieStoreId)) this.save();
  }

  all(): string[] {
    return [...this.ids];
  }

  /**
   * One time migration: versions before the registry created containers without recording them.
   * Adopt the ones that carry our `fingerprint` icon and a site-like name, so they get cleaned up
   * too. A user container with the same icon and a domain name would also be adopted: rare, and
   * accepted. Only runs after an update: a fresh install skips it (see skipMigration).
   */
  private async adoptLegacy(): Promise<void> {
    const all = await browser.contextualIdentities.query({});
    for (const c of all) {
      if (c.icon === "fingerprint" && looksLikeSite(c.name)) this.ids.add(c.cookieStoreId);
    }
    // Ids and the "done" flag in one write that is allowed to fail: if it does, the migration is
    // not marked done and runs again next time, instead of silently losing the adopted ids.
    const snapshot = [...this.ids];
    const write = this.saving.then(() =>
      browser.storage.local.set({ [STORAGE_KEY]: snapshot, [MIGRATED_KEY]: true }),
    );
    this.saving = write.catch(() => undefined);
    await write;
  }

  private save(): void {
    const snapshot = [...this.ids];
    this.saving = this.saving
      .then(() => browser.storage.local.set({ [STORAGE_KEY]: snapshot }))
      .catch((error) => console.warn("[poison] could not save the container registry", error));
  }
}
