// Network layer half of fingerprint uniformization.
//
// The injected page scripts fix what JavaScript sees; this fixes what the SERVER sees. Both must
// agree or the mismatch is itself a signal, so both read the same COMMON_PROFILE. This rewrites the
// User Agent and Accept Language request headers via webRequest.

import { COMMON_PROFILE, acceptLanguageHeader } from "./profile";

type BlockingResponse = browser.webRequest.BlockingResponse;
type Details = browser.webRequest._OnBeforeSendHeadersDetails;

export class HeaderUniformizer {
  private listening = false;

  private readonly handler = (details: Details): BlockingResponse => {
    const headers = details.requestHeaders;
    if (!headers) return {};
    for (const header of headers) {
      const name = header.name.toLowerCase();
      if (name === "user-agent") header.value = COMMON_PROFILE.ua;
      else if (name === "accept-language") header.value = acceptLanguageHeader();
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
