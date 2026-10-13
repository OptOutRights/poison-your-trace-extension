// Per site whitelist ("disable on this site"). A user who hits a site the extension breaks (a login
// that fails under container isolation, a page that misbehaves under RFP) can pause the extension for
// that site. Entries are stored as registrable domains, so whitelisting `example.com` covers
// `www.example.com`, `app.example.com`, ... — the same grouping auto containers use.
//
// What "paused" means differs by protection, because Firefox only lets us disable some of them per
// site: the extension owned mechanisms (auto containers, burner email) are skipped exactly on a
// whitelisted domain, while the global privacy.* settings (RFP, WebRTC, ...) are browser wide, so the
// background clears them whenever a whitelisted tab is the focused one (see background.ts).

import { registrableDomain } from "./containers/auto";

const STORAGE_KEY = "poisonyourtrace.whitelist";

/** Read the stored list, defaulting to empty and tolerating a garbage stored value (non-array, or an
 *  array with non-string members) by filtering down to strings. */
export async function getWhitelist(): Promise<string[]> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

/** Is this hostname's registrable domain on the whitelist? False for anything unparseable/non web
 *  (an empty or malformed hostname collapses to something that will simply not be a member). */
export async function isWhitelisted(hostname: string): Promise<boolean> {
  if (!hostname) return false;
  const domain = registrableDomain(hostname);
  const list = await getWhitelist();
  return list.includes(domain);
}

/** Add a hostname's registrable domain to the whitelist (idempotent). */
export async function addToWhitelist(hostname: string): Promise<void> {
  if (!hostname) return;
  const domain = registrableDomain(hostname);
  const list = await getWhitelist();
  if (list.includes(domain)) return;
  list.push(domain);
  await browser.storage.local.set({ [STORAGE_KEY]: list });
}

/** Remove a registrable domain from the whitelist (no op if absent). */
export async function removeFromWhitelist(domain: string): Promise<void> {
  const list = await getWhitelist();
  const next = list.filter((entry) => entry !== domain);
  if (next.length === list.length) return;
  await browser.storage.local.set({ [STORAGE_KEY]: next });
}
