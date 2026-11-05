// Which "site" a hostname belongs to. One container per site, so this decides isolation boundaries.

import { getDomain } from "tldts";

/**
 * The registrable domain (eTLD+1) of a hostname, per the Public Suffix List: "example.com" for
 * "www.shop.example.com", "bbc.co.uk" for "www.bbc.co.uk", "impots.gouv.fr" for "impots.gouv.fr".
 *
 * `allowPrivateDomains` also treats the PSL private section (github.io, vercel.app, blogspot.com,
 * ...) as suffixes, so two different users' sites on the same hosting platform stay separate.
 *
 * Hosts with no registrable domain (IP addresses, localhost, bare suffixes) map to themselves.
 */
export function registrableDomain(hostname: string): string {
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}
