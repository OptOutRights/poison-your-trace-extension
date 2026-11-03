// Removes the containers this extension created once they are no longer used, so that Firefox's
// container list does not become a record of every site ever visited, and each site's cookies and
// storage are dropped instead of following the user from one visit to the next.
//
// Same model as Temporary Containers: when a tab closes, every container of ours that no longer
// has a tab is scheduled for removal after a delay. Just before removing, we check again that it
// has no tab and was not reused in the meantime, because `contextualIdentities.remove()` closes
// any tab still open in that container.

import { ContainerRegistry } from "./registry";

// How long a container is kept after its last tab closes, so reopening a site shortly after
// closing it (or restoring a closed tab) keeps the session. Same default as Temporary Containers.
export const REMOVAL_DELAY_MS = 15 * 60_000;

export class ContainerCleanup {
  private listening = false;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  // When each container was last handed out for a navigation. A removal that started before
  // that moment is abandoned, even if the reopened tab does not exist yet.
  private readonly lastUse = new Map<string, number>();

  constructor(private readonly registry: ContainerRegistry) {}

  /** A navigation is about to use this container: it must not be removed. */
  markUsed(cookieStoreId: string): void {
    this.lastUse.set(cookieStoreId, Date.now());
    this.cancel(cookieStoreId);
  }

  private readonly onTabRemoved = (tabId: number): void => {
    void this.sweep(tabId);
  };

  private readonly onContainerRemoved = (
    info: { contextualIdentity: browser.contextualIdentities.ContextualIdentity },
  ): void => {
    // Removed by us or by the user from Firefox's settings: either way, forget it.
    const id = info.contextualIdentity.cookieStoreId;
    this.cancel(id);
    this.registry.delete(id);
  };

  async enable(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    browser.tabs.onRemoved.addListener(this.onTabRemoved);
    browser.contextualIdentities.onRemoved.addListener(this.onContainerRemoved);
    await this.registry.adoptLegacy();
    // Containers left without a tab (browser restart, extension update, turned back on).
    await this.sweep();
  }

  disable(): void {
    if (!this.listening) return;
    this.listening = false;
    browser.tabs.onRemoved.removeListener(this.onTabRemoved);
    browser.contextualIdentities.onRemoved.removeListener(this.onContainerRemoved);
    for (const id of [...this.timers.keys()]) this.cancel(id);
  }

  /** Schedule removal of every container of ours that has no tab. `closedTabId` is ignored. */
  private async sweep(closedTabId?: number): Promise<void> {
    await this.registry.ready();
    const tabs = await browser.tabs.query({});
    // After a crash, Firefox offers to restore the previous session from this page; the tabs it
    // would restore are not open yet, so their containers would look unused. Wait for the next sweep.
    if (tabs.some((t) => t.url === "about:sessionrestore")) return;
    const inUse = new Set(tabs.filter((t) => t.id !== closedTabId).map((t) => t.cookieStoreId));
    for (const id of this.registry.all()) {
      if (!inUse.has(id)) this.schedule(id);
    }
  }

  private schedule(cookieStoreId: string): void {
    if (!this.listening || this.timers.has(cookieStoreId)) return;
    const scheduledAt = Date.now();
    this.timers.set(
      cookieStoreId,
      setTimeout(() => void this.tryRemove(cookieStoreId, scheduledAt), REMOVAL_DELAY_MS),
    );
  }

  private cancel(cookieStoreId: string): void {
    const timer = this.timers.get(cookieStoreId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(cookieStoreId);
  }

  private async tryRemove(cookieStoreId: string, scheduledAt: number): Promise<void> {
    this.timers.delete(cookieStoreId);
    let tabs: browser.tabs.Tab[];
    try {
      tabs = await browser.tabs.query({ cookieStoreId });
    } catch {
      return;
    }
    // Check and drop ownership in one synchronous step, so a navigation looking the container up
    // either sees it (and has marked it used, which aborts here) or does not (and creates a new one).
    if (tabs.length) return;
    if ((this.lastUse.get(cookieStoreId) ?? 0) >= scheduledAt) return;
    if (!this.registry.has(cookieStoreId)) return;
    this.registry.delete(cookieStoreId);
    this.lastUse.delete(cookieStoreId);
    try {
      await browser.contextualIdentities.remove(cookieStoreId);
    } catch (error) {
      console.warn("[poison] could not remove container", cookieStoreId, error);
    }
  }
}
