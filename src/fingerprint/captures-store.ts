// Per tab before and after capture store, owned by the background.
//
// The page world overrides (via the report relay) and the header uniformizer both report
// { signal, group, before, after } entries for the tab they ran in. This store keeps the latest
// snapshot per tab in memory and answers the popup's read (ticket #6). It is deliberately a plain,
// self contained object so the background wiring stays a few lines and merges cleanly with other
// tickets that also touch background.ts.
//
// In memory, not persisted: captures describe the LIVE tab and are cheap to regenerate on the next
// page load. We clear a tab's entry when it navigates or closes so stale values never leak.

import type { SignalCapture } from "./report";

export class CapturesStore {
  // tabId to a map of signal name to its latest capture. A map keyed by signal name means a repeated
  // report for the same signal (e.g. many requests rewriting the User Agent header) overwrites
  // rather than piles up, so each signal appears once.
  private readonly byTab = new Map<number, Map<string, SignalCapture>>();

  /** Merge a batch of captures into a tab's snapshot, replacing any prior entry per signal. */
  add(tabId: number, captures: SignalCapture[]): void {
    if (tabId < 0) return;
    let signals = this.byTab.get(tabId);
    if (!signals) {
      signals = new Map<string, SignalCapture>();
      this.byTab.set(tabId, signals);
    }
    for (const capture of captures) {
      if (capture && typeof capture.signal === "string") signals.set(capture.signal, capture);
    }
  }

  /** The tab's current before and after snapshot as a flat list, or an empty list if none. */
  get(tabId: number): SignalCapture[] {
    const signals = this.byTab.get(tabId);
    return signals ? [...signals.values()] : [];
  }

  /** Drop a tab's snapshot (on navigation or tab close) so stale before and after values never leak. */
  clear(tabId: number): void {
    this.byTab.delete(tabId);
  }
}
