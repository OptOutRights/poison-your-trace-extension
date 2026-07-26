// Per site burner address store. Keeps the mapping from registrable domain to burner address stable
// across visits by persisting it in browser.storage.local. The address is derived deterministically
// from the domain (see generator.ts), so persistence is really a cache: it guarantees the same site
// keeps the same address even if the word tables ever change, and it makes "same site reuses, other
// sites differ" trivially true.

import { registrableDomain } from "../containers/auto";
import { burnerAddressFor } from "./generator";

const STORAGE_KEY = "poisonyourtrace.burners";

type BurnerMap = Record<string, string>;

async function loadMap(): Promise<BurnerMap> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as BurnerMap | undefined) ?? {};
}

/**
 * The burner address for a hostname, keyed by its registrable domain so every subdomain of a site
 * shares one address. Returns a persisted address when present, otherwise derives one, saves it, and
 * returns it. Result is stable for a given site across visits.
 */
export async function getBurnerFor(hostname: string): Promise<string> {
  const domain = registrableDomain(hostname);
  const map = await loadMap();
  const existing = map[domain];
  if (existing) return existing;

  const address = burnerAddressFor(domain);
  map[domain] = address;
  await browser.storage.local.set({ [STORAGE_KEY]: map });
  return address;
}
