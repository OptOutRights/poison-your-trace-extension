// Clearing what a site left in the default container, for the rare visit that loads there.

import { registrableDomain } from "./domain";
import { DEFAULT_STORE, cookieBelongsToSite } from "./policy";

/**
 * Remove `site`'s cookies from the default container: its own, and those third parties set while it
 * was the top level page. Other storage (localStorage, IndexedDB...) is not covered by this API.
 */
export async function clearSiteCookiesFromDefaultStore(site: string): Promise<number> {
  const cookies = await browser.cookies.getAll({
    storeId: DEFAULT_STORE,
    // Every partition and every first party domain, so nothing is missed whatever the user's
    // isolation settings (Total Cookie Protection, First-Party Isolation).
    partitionKey: {},
    firstPartyDomain: null as unknown as string,
  });
  const mine = cookies.filter((cookie) => cookieBelongsToSite(cookie, site, registrableDomain));
  await Promise.all(
    mine.map((cookie) =>
      browser.cookies
        .remove({
          url: `https://${cookie.domain.replace(/^\./, "")}${cookie.path}`,
          name: cookie.name,
          storeId: cookie.storeId,
          firstPartyDomain: cookie.firstPartyDomain,
          partitionKey: cookie.partitionKey ?? undefined,
        })
        .catch(() => undefined),
    ),
  );
  return mine.length;
}
