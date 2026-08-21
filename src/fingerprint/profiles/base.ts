// Shared shape and defaults for the per-OS fingerprint profiles.
//
// We UNIFORMIZE, we do not randomize. Randomizing per site or per visit backfires: a unique per
// visit fingerprint is itself a high entropy identifier. Instead every page presents the SAME
// widely shared profile, so the canvas, User Agent, timezone, language and screen quasi identifiers
// carry close to zero distinguishing bits and the whole crowd of users clusters together.
//
// One important nuance (ticket #37): we do NOT spoof the OS across families. Mozilla removed OS
// spoofing from resistFingerprinting and Tor Browser 14 stopped blanket OS spoofing, because the
// TCP/IP stack, the WebGL renderer and the font list expose the real family regardless — a Windows
// UA on a macOS machine is a contradiction detectors flag (getHasLiedOs). So we resolve ONE common,
// RFP aligned profile FOR THE REAL FAMILY (see resolveProfile) and present it everywhere. The
// per family values live in one file each (windows.ts, mac.ts, linux.ts); the parts that are
// identical across families live in SHARED_DEFAULTS here, so the OS files only carry what differs.

/** The desktop OS families we present a profile for. Everything else resolves to the closest one. */
export type OsFamily = "windows" | "mac" | "linux";

export interface CommonProfile {
  /** The OS family this profile represents; must match the machine's real family. */
  family: OsFamily;
  /** navigator.userAgent plus the User Agent request header. */
  ua: string;
  /** navigator.platform. */
  platform: string;
  /** navigator.oscpu (Firefox exposes it; the value must agree with `platform` and `ua`). */
  oscpu: string;
  /** navigator.language (primary). */
  language: string;
  /** navigator.languages plus the Accept Language request header order. */
  languages: string[];
  /** IANA timezone reported by Intl and used to derive Date.getTimezoneOffset. */
  timezone: string;
  /** Fixed UTC offset in minutes for `timezone` (getTimezoneOffset sign convention: UTC minus local). */
  timezoneOffsetMinutes: number;
  /** screen.width, screen.height, screen.availWidth, screen.availHeight. */
  screen: { width: number; height: number; availWidth: number; availHeight: number };
  /** screen.colorDepth and screen.pixelDepth. */
  colorDepth: number;
  /** devicePixelRatio. */
  devicePixelRatio: number;
  /** navigator.hardwareConcurrency. */
  hardwareConcurrency: number;
  /**
   * WebGL identity exposed through WEBGL_debug_renderer_info. Detectors cross check this against the
   * UA's OS (a Windows ANGLE/D3D11 renderer under a macOS UA is a tell), so it is per family. The
   * MASKED core VENDOR/RENDERER stay Firefox's constant "Mozilla" and are handled in webgl.ts.
   */
  webgl: { unmaskedVendor: string; unmaskedRenderer: string };
}

/**
 * The parts of the profile that are identical across OS families, so each OS file only spells out
 * what actually differs (UA, platform, oscpu, WebGL renderer). Timezone UTC (offset 0) and en-US are
 * the neutral defaults; 1920x1080 / 8 cores is a common, populous desktop that maximizes the
 * anonymity set on every family.
 */
export const SHARED_DEFAULTS = {
  language: "en-US",
  languages: ["en-US", "en"],
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
  colorDepth: 24,
  devicePixelRatio: 1,
  hardwareConcurrency: 8,
} satisfies Partial<CommonProfile>;

/** Accept Language header value derived from a profile's `languages` list (q weighted). */
export function acceptLanguageHeader(profile: CommonProfile): string {
  return profile.languages
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${(1 - i * 0.1).toFixed(1)}`))
    .join(", ");
}
