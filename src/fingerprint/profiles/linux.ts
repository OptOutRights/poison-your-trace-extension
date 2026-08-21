// Linux (x86_64) + Firefox 140 base fingerprint.
//
// The UA/platform/oscpu match what Firefox reports on a 64 bit Linux desktop. On Linux Firefox
// renders WebGL through Mesa (no ANGLE/D3D11), so the unmasked renderer is a Mesa string; we pin it
// to the same Intel UHD 620 class GPU as the Windows profile so the choice stays a common,
// integrated part rather than a distinctive discrete card.

import { SHARED_DEFAULTS, type CommonProfile } from "./base";

export const LINUX_PROFILE: CommonProfile = {
  ...SHARED_DEFAULTS,
  family: "linux",
  ua: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  platform: "Linux x86_64",
  oscpu: "Linux x86_64",
  webgl: {
    unmaskedVendor: "Intel",
    unmaskedRenderer: "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
  },
};
