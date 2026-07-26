// The COMMON fingerprint profile.
//
// We UNIFORMIZE, we do not randomize. Randomizing per site or per visit backfires: a unique per
// visit fingerprint is itself a high entropy identifier. Instead every page presents the SAME
// widely shared profile, so the canvas, User Agent, timezone, language and screen quasi identifiers
// carry close to zero distinguishing bits and the whole crowd of users clusters together.
//
// The profile is a plausible, common desktop configuration. It is identical on every site by
// construction and stable across sessions, so it never flickers into a new identifier.

export interface CommonProfile {
  /** navigator.userAgent plus the User Agent request header. */
  ua: string;
  /** navigator.platform. */
  platform: string;
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
}

/**
 * A common Windows 10 and Firefox desktop, one of the most populous configurations, so it
 * maximizes the anonymity set. Timezone UTC (offset 0) and en-US are the neutral defaults.
 */
export const COMMON_PROFILE: CommonProfile = {
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  platform: "Win32",
  language: "en-US",
  languages: ["en-US", "en"],
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
  colorDepth: 24,
  devicePixelRatio: 1,
  hardwareConcurrency: 8,
};

/** Accept Language header value derived from the common `languages` list (q weighted). */
export function acceptLanguageHeader(profile: CommonProfile = COMMON_PROFILE): string {
  return profile.languages
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${(1 - i * 0.1).toFixed(1)}`))
    .join(", ");
}
