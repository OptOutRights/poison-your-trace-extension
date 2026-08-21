// Windows 10 + Firefox 140 base fingerprint.
//
// One of the most populous desktop configurations, so it maximizes the anonymity set. On Windows,
// Firefox renders WebGL through ANGLE on top of Direct3D 11, so the unmasked renderer is the ANGLE
// D3D11 string; Intel UHD Graphics 620 is a very common integrated GPU.

import { SHARED_DEFAULTS, type CommonProfile } from "./base";

export const WINDOWS_PROFILE: CommonProfile = {
  ...SHARED_DEFAULTS,
  family: "windows",
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
  platform: "Win32",
  oscpu: "Windows NT 10.0; Win64; x64",
  webgl: {
    unmaskedVendor: "Google Inc. (Intel)",
    unmaskedRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
};
