// Content script relay, registered dynamically at document_start alongside the fingerprint
// overrides when the extension is enabled.
//
// The overrides run in the PAGE world and cannot talk to the extension directly. They post their
// before and after captures with window.postMessage. This relay runs in the ISOLATED content world
// (which the page cannot see) and forwards those captures to the background, which stores them per
// tab for the popup (ticket #6). The relay is the trust boundary: it accepts only same window
// messages that match the capture contract and passes nothing else through.

import { REPORT_MESSAGE_TYPE, isCaptureMessage } from "./report";

window.addEventListener("message", (event: MessageEvent) => {
  // Only accept messages posted from this same window (the injected page script), never from
  // embedded frames or other origins, and only the capture envelope shape.
  if (event.source !== window) return;
  const data = event.data as { type?: unknown };
  if (data?.type !== REPORT_MESSAGE_TYPE) return;
  if (!isCaptureMessage(event.data)) return;

  // Forward to the background. It keys the captures by the sender tab, so the popup can ask for the
  // active tab's before and after view. Errors here are non fatal: capture is a read out for the
  // popup, never a protection, so a delivery failure must not disturb the page.
  void browser.runtime
    .sendMessage({ type: REPORT_MESSAGE_TYPE, captures: event.data.captures })
    .catch(() => {
      /* background not ready or tab closing: drop this batch, protection is unaffected */
    });
});

// Module scope (no runtime export): keeps this file local so it does not collide with the sibling
// fingerprint content scripts in tsc's global script scope.
export {};
