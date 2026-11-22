import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STORE,
  HandoffTracker,
  decide,
  looksLikeOurs,
  type NavigationFacts,
} from "../src/containers/policy.ts";
import { registrableDomain } from "../src/containers/domain.ts";

const base: NavigationFacts = {
  site: "example.com",
  tabStore: DEFAULT_STORE,
  tabContainer: null,
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
const FB_A = "https://www.facebook.com/a";
const FB_B = "https://www.facebook.com/b";
const FB_C = "https://www.facebook.com/c";
const EX = "https://example.com/";

test("a move into another container right after our reopen is a handoff", () => {
  const t = new HandoffTracker(2000);
  assert.equal(t.noteReopen(EX, 1000), null);
  assert.equal(t.onForeignLoad(EX, 7, FB, 2500), "handoff");
});

test("the other extension moving the tab before our reopen: we must not reopen", () => {
  // The other extension reacts first: its tab loads, then we get to our reopen.
  const t = new HandoffTracker(2000);
  assert.equal(t.onForeignLoad(FB_A, 7, FB, 1000), "none");
  assert.equal(t.noteReopen(FB_A, 1100), FB);
  // Its tab loading the same URL again is not a duplicate.
  assert.equal(t.onForeignLoad(FB_A, 7, FB, 1200), "none");
});

test("a second tab for the same URL around our reopen is a duplicate", () => {
  // The other extension reopens both the original tab and the one we opened.
  const t = new HandoffTracker(2000);
  t.noteReopen(FB_A, 1000);
  assert.equal(t.onForeignLoad(FB_A, 7, FB, 1100), "handoff");
  assert.equal(t.onForeignLoad(FB_A, 8, FB, 1200), "duplicate");
  // The kept tab loading again is not a duplicate.
  assert.equal(t.onForeignLoad(FB_A, 7, FB, 1300), "none");
  // Past the window, a new tab is the user's own.
  assert.equal(t.onForeignLoad(FB_A, 9, FB, 3500), "none");
});

test("several pages of the same site opened together are not duplicates of each other", () => {
  // "Open All in Tabs" on /a, /b, /c: we reopen each one, and the other extension moves both the
  // original tabs and ours. Only the second tab of each URL is a duplicate.
  const t = new HandoffTracker(2000);
  t.noteReopen(FB_A, 1000);
  t.noteReopen(FB_B, 1010);
  t.noteReopen(FB_C, 1020);
  assert.equal(t.onForeignLoad(FB_A, 11, FB, 1100), "handoff");
  assert.equal(t.onForeignLoad(FB_B, 12, FB, 1110), "handoff");
  assert.equal(t.onForeignLoad(FB_C, 13, FB, 1120), "handoff");
  assert.equal(t.onForeignLoad(FB_A, 21, FB, 1200), "duplicate");
  assert.equal(t.onForeignLoad(FB_B, 22, FB, 1210), "duplicate");
  assert.equal(t.onForeignLoad(FB_C, 23, FB, 1220), "duplicate");
});

test("a URL browsed in another container, with no reopen by us, is left alone", () => {
  const t = new HandoffTracker(2000);
  assert.equal(t.onForeignLoad(EX, 7, FB, 1000), "none");
  assert.equal(t.onForeignLoad(EX, 8, FB, 1100), "none");
  t.noteReopen("https://other.com/", 1200);
  assert.equal(t.onForeignLoad(EX, 9, FB, 1300), "none");
  // An old foreign load does not count for a later reopen.
  assert.equal(t.noteReopen(EX, 5000), null);
});
