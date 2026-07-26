// Toolbar popup: the Enabled toggle plus a plain recap of what is being hidden on the active tab
// (ticket #6). The toggle still writes the on device config and asks the background to re apply
// immediately; below it the recap reads the active tab's before and after captures, its container,
// and its burner email, and states honestly what is NOT hidden (the IP, which the popup never
// fetches from anywhere).

import { loadConfig, saveConfig } from "./config";
import {
  GET_CAPTURES_MESSAGE_TYPE,
  type SignalCapture,
} from "./fingerprint/report";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

// The fingerprint groups the recap lays out, in a readable order. Any group the captures carry that
// is not listed here still renders, appended after these, so a new signal group never goes missing.
const GROUP_ORDER = [
  "navigator",
  "screen",
  "timezone",
  "canvas",
  "webgl",
  "plugins",
  "audio",
  "headers",
] as const;

const GROUP_LABEL: Record<string, string> = {
  navigator: "Navigator",
  screen: "Screen",
  timezone: "Timezone",
  canvas: "Canvas",
  webgl: "WebGL",
  plugins: "Plugins",
  audio: "Audio",
  headers: "Request headers",
};

// The active tab, resolved once per render. Returns undefined when there is no ordinary web tab
// (e.g. an about: page), so the recap can fall back to a graceful message.
async function activeTab(): Promise<browser.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostnameOf(tab: browser.tabs.Tab): string | undefined {
  if (!tab.url) return undefined;
  try {
    return new URL(tab.url).hostname || undefined;
  } catch {
    return undefined;
  }
}

async function getCaptures(tabId: number): Promise<SignalCapture[]> {
  const reply = (await browser.runtime.sendMessage({
    type: GET_CAPTURES_MESSAGE_TYPE,
    tabId,
  })) as { captures?: SignalCapture[] } | undefined;
  return reply?.captures ?? [];
}

// The container name for the active tab. "firefox-default" means the tab is not in a per site
// container yet, so we report that plainly rather than showing a raw cookie store id.
async function containerName(tab: browser.tabs.Tab): Promise<string> {
  const id = tab.cookieStoreId;
  if (!id || id === "firefox-default") return "none yet, opens in its own container on next load";
  try {
    const identity = await browser.contextualIdentities.get(id);
    return identity.name;
  } catch {
    return "unknown";
  }
}

// The burner email the extension would fill on this site. Uses the same "poison:burner" message the
// autofill content script uses, so a disabled extension returns nothing and we say so.
async function burnerEmail(hostname: string): Promise<string | undefined> {
  const reply = (await browser.runtime.sendMessage({
    type: "poison:burner",
    hostname,
  })) as { address?: string } | undefined;
  return reply?.address;
}

function heading(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = text;
  return h;
}

// One "before to after" line. The two values are separated by the word style arrow "to" (never a
// dash), and canvas and audio arrive already carrying the "device signature" and "neutralized"
// sentinels, so they render as is.
function captureLine(cap: SignalCapture): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cap";

  const sig = document.createElement("span");
  sig.className = "sig";
  sig.textContent = `${cap.signal}: `;

  const vals = document.createElement("span");
  vals.className = "vals";

  const before = document.createElement("span");
  before.className = "before";
  before.textContent = cap.before;

  const arrow = document.createElement("span");
  arrow.className = "arrow";
  arrow.textContent = "to";

  const after = document.createElement("span");
  after.className = "after";
  after.textContent = cap.after;

  vals.append(before, " ", arrow, " ", after);
  wrap.append(sig, vals);
  return wrap;
}

// Render the grouped fingerprint captures. Groups appear in GROUP_ORDER first, then any extras.
function renderCaptures(container: HTMLElement, captures: SignalCapture[]): void {
  const byGroup = new Map<string, SignalCapture[]>();
  for (const cap of captures) {
    const list = byGroup.get(cap.group) ?? [];
    list.push(cap);
    byGroup.set(cap.group, list);
  }

  const ordered = [
    ...GROUP_ORDER.filter((g) => byGroup.has(g)),
    ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g as (typeof GROUP_ORDER)[number])),
  ];

  for (const group of ordered) {
    container.append(heading(GROUP_LABEL[group] ?? group));
    for (const cap of byGroup.get(group) ?? []) container.append(captureLine(cap));
  }
}

function factLine(label: string, value: string): HTMLElement {
  const p = document.createElement("div");
  p.className = "fact";
  const b = document.createElement("b");
  b.textContent = `${label}: `;
  p.append(b, document.createTextNode(value));
  return p;
}

// The honest gaps: what this extension does NOT hide. The IP is never shown and never fetched from
// anywhere; email is a burner alias so replies land nowhere the extension controls.
function renderGaps(container: HTMLElement): void {
  container.append(heading("Not hidden"));
  const ip = document.createElement("div");
  ip.className = "fact gap";
  const ipb = document.createElement("b");
  ipb.textContent = "IP address: ";
  ip.append(ipb, document.createTextNode("not hidden (use a VPN or Tor for that)."));
  container.append(ip);

  const mail = document.createElement("div");
  mail.className = "fact gap";
  mail.textContent = "Email is a burner alias only, so no mail comes back to you through it.";
  container.append(mail);
}

async function renderRecap(): Promise<void> {
  const recap = el<HTMLElement>("recap");
  recap.textContent = "";

  const config = await loadConfig();
  if (!config.enabled) {
    const off = document.createElement("div");
    off.className = "empty";
    off.textContent = "Protections are off. Turn Enabled on to hide this site's fingerprint.";
    recap.append(off);
    return;
  }

  const tab = await activeTab();
  if (!tab || typeof tab.id !== "number") {
    const none = document.createElement("div");
    none.className = "empty";
    none.textContent = "Nothing captured yet on this tab.";
    recap.append(none);
    return;
  }

  const hostname = hostnameOf(tab);

  // Site context: container and burner email. Both resolve independently of the captures.
  recap.append(heading("This site"));
  recap.append(factLine("Container", await containerName(tab)));
  if (hostname) {
    const address = await burnerEmail(hostname);
    recap.append(factLine("Burner email", address ?? "none for this site."));
  } else {
    recap.append(factLine("Burner email", "not a web page, no burner in use."));
  }

  // Fingerprint before and after, grouped. A tab that just opened (or a non web page) has no
  // captures yet, so we say so plainly rather than showing an empty list.
  const captures = hostname ? await getCaptures(tab.id) : [];
  if (captures.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing captured yet on this tab. Reload the page to see the recap.";
    recap.append(empty);
  } else {
    renderCaptures(recap, captures);
  }

  renderGaps(recap);
}

async function render(): Promise<void> {
  const enabled = el<HTMLInputElement>("enabled");
  const status = el<HTMLElement>("status");

  const config = await loadConfig();
  enabled.checked = config.enabled;
  status.textContent = config.enabled ? "On, protecting every site." : "Off.";

  await renderRecap();

  enabled.addEventListener("change", () => {
    void (async () => {
      const on = enabled.checked;
      try {
        await saveConfig({ enabled: on });
        await browser.runtime.sendMessage({ type: "poison:apply" });
        status.textContent = on ? "On, protecting every site." : "Off.";
        // The enabled state changed, so refresh the recap to match (show the list or mark it off).
        await renderRecap();
      } catch (err) {
        status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  });
}

// Run immediately if the document is already parsed (DOMContentLoaded may have fired before this
// bundled script executed), otherwise wait for it. Either way render() runs once.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void render());
} else {
  void render();
}
