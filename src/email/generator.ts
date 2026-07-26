// Burner address generator (v0). Turns a registrable domain into a stable, throwaway email address
// made of two everyday dictionary words plus an optional number, at a reserved domain that can never
// resolve. It owns no domain, reaches no real person, and receives nothing.
//
// Why ".invalid": RFC 2606 and RFC 6761 reserve the ".invalid" top level domain so that it is
// permanently guaranteed NOT to resolve in the global DNS. No one can register it, no mail server
// can exist under it, so a burner address there is inert by construction: no forwarding, no inbox,
// no cost, no domain ownership required. That is exactly the v0 promise.
//
// The two words are common adjectives and nouns only (never a first or last name), so the localpart
// reads as an anonymous label rather than anything tied to a person. Words are joined with a dot so
// the value carries no dash character.

/** The reserved, permanently non resolving domain every burner address lives under. */
export const BURNER_DOMAIN = "example.invalid";

/**
 * Common adjectives (no person names, no internal hyphens). Chosen for being plainly generic so the
 * localpart never resembles anyone's identity.
 */
const ADJECTIVES: readonly string[] = [
  "quiet", "amber", "brisk", "clever", "cosmic", "dapper", "eager", "faint", "gentle", "hidden",
  "jolly", "keen", "lucid", "mellow", "nimble", "plush", "rustic", "silver", "tidy", "velvet",
  "wandering", "zesty", "bold", "calm", "dusky", "frosty", "golden", "humble", "ivory", "jade",
  "lively", "misty", "noble", "olive", "polar", "royal", "sable", "teal", "urban", "vivid",
];

/**
 * Common nouns (no person names, no internal hyphens). Everyday objects and animals so the pairing
 * stays anonymous.
 */
const NOUNS: readonly string[] = [
  "otter", "meadow", "lantern", "pebble", "harbor", "willow", "cinder", "maple", "thistle", "cove",
  "brook", "canyon", "ember", "fjord", "glacier", "hollow", "island", "juniper", "kettle", "lagoon",
  "marble", "nectar", "orchard", "pixel", "quartz", "ridge", "summit", "timber", "umbra", "valley",
  "walnut", "yarrow", "zephyr", "acorn", "basalt", "cedar", "dune", "fern", "grove", "heather",
];

/**
 * A small, non secret hash (FNV like) over the domain. It only needs to spread inputs across the
 * word tables deterministically, so a stable 32 bit accumulator is enough.
 */
function hashDomain(domain: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < domain.length; i++) {
    hash ^= domain.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministically derive this site's burner address from its registrable domain. The same domain
 * always yields the same address; different domains almost always differ (two words plus a number
 * give tens of thousands of combinations). The result is `word.word[number]@example.invalid`.
 */
export function burnerAddressFor(registrableDomain: string): string {
  const hash = hashDomain(registrableDomain);
  const adjective = ADJECTIVES[hash % ADJECTIVES.length];
  const noun = NOUNS[(hash >>> 8) % NOUNS.length];
  // Optional trailing number widens the space so distinct sites collide far less often. A zero here
  // means "no number", keeping some addresses as a clean two word pair.
  const suffix = (hash >>> 16) % 100;
  const localpart = suffix === 0 ? `${adjective}.${noun}` : `${adjective}.${noun}${suffix}`;
  return `${localpart}@${BURNER_DOMAIN}`;
}
