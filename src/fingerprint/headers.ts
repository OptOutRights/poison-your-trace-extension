// Network layer half of fingerprint uniformization.
//
// The injected page scripts fix what JavaScript sees; this fixes what the SERVER sees. Both must
// agree or the mismatch is itself a signal, so both consume the SAME resolved OS-family profile: the
// background resolves it once from the real OS (browser.runtime.getPlatformInfo) and hands it in
// here via a getter. This rewrites the User Agent and Accept Language request headers via webRequest.

import { acceptLanguageHeader, type CommonProfile } from "./profiles";
import type { SignalCapture } from "./report";

type BlockingResponse = browser.webRequest.BlockingResponse;
type Details = browser.webRequest._OnBeforeSendHeadersDetails;

/** Notified with the real (before) and applied (after) request header values, keyed by tab. */
export type HeaderCaptureSink = (tabId: number, captures: SignalCapture[]) => void;

export class HeaderUniformizer {
  private listening = false;

  /**
   * @param getProfile returns the resolved OS-family profile to apply (the background resolves it
   *   from the real OS so the header layer matches the page-world overrides).
   * @param onCapture optional consumer for the before and after header captures (the background per
   *   tab store).
   */
  constructor(
    private readonly getProfile: () => CommonProfile,
    private readonly onCapture?: HeaderCaptureSink,
  ) {}

  private readonly handler = (details: Details): BlockingResponse => {
    const headers = details.requestHeaders;
    if (!headers) return {};
    const profile = this.getProfile();
    const applied = acceptLanguageHeader(profile);
    const captures: SignalCapture[] = [];
    for (const header of headers) {
      const name = header.name.toLowerCase();
      if (name === "user-agent") {
        captures.push({ signal: "header.userAgent", group: "headers", before: header.value ?? "", after: profile.ua });
        header.value = profile.ua;
      } else if (name === "accept-language") {
        captures.push({ signal: "header.acceptLanguage", group: "headers", before: header.value ?? "", after: applied });
        header.value = applied;
      }
    }
    // Report the header before and after against the originating tab so the popup can show the
    // network layer alongside the JavaScript layer. tabId is negative for non tab requests; skip
    // those since the popup asks per tab.
    if (this.onCapture && typeof details.tabId === "number" && details.tabId >= 0 && captures.length > 0) {
      this.onCapture(details.tabId, captures);
    }
    return { requestHeaders: headers };
  };

  enable(): void {
    if (this.listening) return;
    browser.webRequest.onBeforeSendHeaders.addListener(
      this.handler,
      { urls: ["<all_urls>"] },
      ["blocking", "requestHeaders"],
    );
    this.listening = true;
  }

  disable(): void {
    if (this.listening && browser.webRequest.onBeforeSendHeaders.hasListener(this.handler)) {
      browser.webRequest.onBeforeSendHeaders.removeListener(this.handler);
    }
    this.listening = false;
  }
}
