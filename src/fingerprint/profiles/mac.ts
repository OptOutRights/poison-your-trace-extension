// macOS + Firefox 140 base fingerprint.
//
// The UA/platform/oscpu match what Firefox (and Tor Browser) report on macOS: the version is pinned
// to "10.15" the way Firefox freezes it to limit entropy. On macOS Firefox renders WebGL through
// Apple's own stack and deliberately reports the generic "Apple GPU" for the unmasked renderer
// rather than the exact chip, so that value is both accurate and uniform across Mac users.

import { SHARED_DEFAULTS, type CommonProfile } from "./base";

export const MAC_PROFILE: CommonProfile = {
  ...SHARED_DEFAULTS,
  family: "mac",
  ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
  platform: "MacIntel",
  oscpu: "Intel Mac OS X 10.15",
  webgl: {
    unmaskedVendor: "Apple",
    unmaskedRenderer: "Apple GPU",
  },
};
