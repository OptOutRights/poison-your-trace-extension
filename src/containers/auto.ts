// Auto containering: every site you browse is opened in its OWN container, automatically, so
// cookies, logins and storage never cross from one site to another.
//
// Pattern (same as Mozilla's Multi-Account Containers): intercept every top level navigation; if
// the tab is not already in the container that site belongs to, cancel the request, reopen the
// same URL in the correct container, and drop the old tab. The reopened tab is already in the
// right container, so its navigation is allowed through, no loop.

import { loadConfig } from "../config";
import { ContainerManager } from "./manager";

type BlockingResponse = browser.webRequest.BlockingResponse;
type Details = browser.webRequest._OnBeforeRequestDetails;

// A few common multi label public suffixes so `foo.co.uk` groups under `foo.co.uk`, not `co.uk`.
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "com.au", "co.nz", "com.br", "co.in",
]);

// Firefox container colours; we pick one deterministically per domain so distinct sites are
// visibly distinct in the tab bar (and the same site always gets the same colour).
const COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"] as const;

/** The registrable domain ("example.com" for "www.shop.example.com"). One container per this. */
export function registrableDomain(hostname: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname; // raw IPv4 maps to itself
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const lastTwo = parts.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

function colorForDomain(domain: string): (typeof COLORS)[number] {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

/**
 * The container a URL belongs to: one per registrable domain. Returns null for non web URLs
 * (about:, moz-extension:, file:) which must never be re containered.
 */
export function targetFor(url: string): { name: string; color: (typeof COLORS)[number] } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const domain = registrableDomain(u.hostname);
  return { name: domain, color: colorForDomain(domain) };
}

/** Reassigns top level navigations into per site containers. Enabled whenever the extension is on. */
export class AutoContainer {
  private listening = false;
  constructor(private readonly containers: ContainerManager) {}

  private readonly handler = async (details: Details): Promise<BlockingResponse> => {
    if (details.tabId < 0) return {}; // not a real tab (background fetch, prefetch, etc.)

    const config = await loadConfig();
    if (!config.enabled) return {};

    const target = targetFor(details.url);
    if (!target) return {};

    const container = await this.containers.getOrCreate(target.name, target.color);

    let tab: browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(details.tabId);
    } catch {
      return {}; // tab vanished mid flight
    }
    if (tab.cookieStoreId === container.cookieStoreId) return {}; // already in the right container

    // Wrong container: reopen this URL in the correct one, then discard the old tab.
    await browser.tabs.create({
      url: details.url,
      cookieStoreId: container.cookieStoreId,
      index: tab.index,
      active: tab.active,
      windowId: tab.windowId,
    });
    await browser.tabs.remove(details.tabId);
    return { cancel: true };
  };

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
