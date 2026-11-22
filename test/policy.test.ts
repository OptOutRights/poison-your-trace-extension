import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STORE,
  HandoffTracker,
  decide,
  isMultiAccountContainersPrompt,
  looksLikeOurs,
  type NavigationFacts,
} from "../src/containers/policy.ts";
import { registrableDomain } from "../src/containers/domain.ts";

const base: NavigationFacts = {
  site: "example.com",
  tabStore: DEFAULT_STORE,
  tabContainer: null,
  assignedByMac: false,
  handledElsewhere: false,
};

const ours = (name: string) => ({ tabStore: "firefox-container-1", tabContainer: { name, ours: true } });
const theirs = { tabStore: "firefox-container-9", tabContainer: { name: "Personal", ours: false } };

test("a normal tab is moved into the site's container", () => {
  assert.equal(decide(base), "reopen");
});

test("a tab already in the site's own container stays", () => {
  assert.equal(decide({ ...base, ...ours("example.com") }), "leave");
});

test("a tab in our container for another site is moved", () => {
  assert.equal(decide({ ...base, ...ours("other.com") }), "reopen");
});

test("a tab in a container we did not create stays, whatever the site", () => {
  assert.equal(decide({ ...base, ...theirs }), "leave");
});

test("a container we can't read (private window, removed) is left alone", () => {
  assert.equal(decide({ ...base, tabStore: "firefox-private", tabContainer: null }), "leave");
});

test("a site Multi-Account Containers assigns is left to it, even from a normal tab", () => {
  assert.equal(decide({ ...base, assignedByMac: true }), "leave");
  assert.equal(decide({ ...base, ...ours("other.com"), assignedByMac: true }), "leave");
});

test("a site another extension handles is left to it, even from a normal tab", () => {
  assert.equal(decide({ ...base, handledElsewhere: true }), "leave");
});

test("containers created before ids were recorded are recognised by icon and name", () => {
  assert.equal(looksLikeOurs({ name: "example.com", icon: "fingerprint" }, registrableDomain), true);
  assert.equal(looksLikeOurs({ name: "bbc.co.uk", icon: "fingerprint" }, registrableDomain), true);
  assert.equal(looksLikeOurs({ name: "example.com", icon: "briefcase" }, registrableDomain), false);
  assert.equal(looksLikeOurs({ name: "Personal", icon: "fingerprint" }, registrableDomain), false);
  assert.equal(looksLikeOurs({ name: "www.example.com", icon: "fingerprint" }, registrableDomain), false);
});

const FB = "firefox-container-9";

test("a move into another container right after our reopen is a handoff", () => {
  const t = new HandoffTracker(2000);
  assert.equal(t.noteReopen("example.com", 1000), null);
  assert.equal(t.onForeignLoad("example.com", 7, FB, 2500), "handoff");
});

test("the other extension moving the tab before our reopen: we must not reopen", () => {
  // The other extension reacts first: its tab loads, then we get to our reopen.
  const t = new HandoffTracker(2000);
  assert.equal(t.onForeignLoad("facebook.com", 7, FB, 1000), "none");
  assert.equal(t.noteReopen("facebook.com", 1100), FB);
  // Its tab loading again (redirect) is not a duplicate.
  assert.equal(t.onForeignLoad("facebook.com", 7, FB, 1200), "none");
});

test("a second tab for the same site around our reopen is a duplicate", () => {
  // The other extension reopens both the original tab and the one we opened.
  const t = new HandoffTracker(2000);
  t.noteReopen("facebook.com", 1000);
  assert.equal(t.onForeignLoad("facebook.com", 7, FB, 1100), "handoff");
  assert.equal(t.onForeignLoad("facebook.com", 8, FB, 1200), "duplicate");
  // The kept tab loading again (redirect) is not a duplicate.
  assert.equal(t.onForeignLoad("facebook.com", 7, FB, 1300), "none");
  // Past the window, a new tab is the user's own.
  assert.equal(t.onForeignLoad("facebook.com", 9, FB, 3500), "none");
});

test("a site browsed in another container, with no reopen by us, is left alone", () => {
  const t = new HandoffTracker(2000);
  assert.equal(t.onForeignLoad("example.com", 7, FB, 1000), "none");
  assert.equal(t.onForeignLoad("example.com", 8, FB, 1100), "none");
  t.noteReopen("other.com", 1200);
  assert.equal(t.onForeignLoad("example.com", 9, FB, 1300), "none");
  // An old foreign load does not count for a later reopen.
  assert.equal(t.noteReopen("example.com", 5000), null);
});

test("a navigation from the Multi-Account Containers prompt is recognised", () => {
  const prompt =
    "moz-extension://1234-abcd/confirm-page.html?url=https%3A%2F%2Fexample.com%2F&cookieStoreId=firefox-container-2";
  assert.equal(isMultiAccountContainersPrompt(prompt, "https://example.com/"), true);
  assert.equal(isMultiAccountContainersPrompt(prompt, "https://example.com/login"), true);
  assert.equal(isMultiAccountContainersPrompt(prompt, "https://other.com/"), false);
  assert.equal(isMultiAccountContainersPrompt("moz-extension://1234-abcd/popup.html", "https://example.com/"), false);
  assert.equal(isMultiAccountContainersPrompt("https://example.com/confirm-page.html?url=https://example.com/", "https://example.com/"), false);
  assert.equal(isMultiAccountContainersPrompt("about:newtab", "https://example.com/"), false);
});
