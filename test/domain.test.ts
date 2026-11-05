import { test } from "node:test";
import assert from "node:assert/strict";
import { registrableDomain } from "../src/containers/domain.ts";

const cases: [hostname: string, site: string][] = [
  // Plain and already-covered multi label suffixes.
  ["shop.example.com", "example.com"],
  ["www.bbc.co.uk", "bbc.co.uk"],
  // Public ccTLD suffixes: unrelated sites must not collapse onto the suffix.
  ["impots.gouv.fr", "impots.gouv.fr"],
  ["www.service-public.gouv.fr", "service-public.gouv.fr"],
  ["www.amazon.com.mx", "amazon.com.mx"],
  ["www.mercadolibre.com.mx", "mercadolibre.com.mx"],
  // Private suffixes: different users on the same hosting platform are different sites.
  ["mozilla.github.io", "mozilla.github.io"],
  ["google.github.io", "google.github.io"],
  ["myapp.vercel.app", "myapp.vercel.app"],
  ["foo.blogspot.com", "foo.blogspot.com"],
  // No registrable domain: the host is its own site.
  ["localhost", "localhost"],
  ["192.168.1.1", "192.168.1.1"],
];

for (const [hostname, site] of cases) {
  test(`${hostname} -> ${site}`, () => {
    assert.equal(registrableDomain(hostname), site);
  });
}
