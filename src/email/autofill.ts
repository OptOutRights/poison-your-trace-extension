// Content script, registered dynamically when the extension is enabled (see background.ts). It finds
// signup and email fields on the page and fills each empty one with this site's burner address, so a
// unique throwaway address is offered per site without the user having to think about it.
//
// It runs in the CONTENT world (not the page world) because it manipulates the site's real form
// controls and asks the background for the site's address. The background gates on the enabled flag
// and only registers this script when the extension is on, so the disabled path stays clean: when
// off, this file is never injected.
//
// Unobtrusive by design: it fills only fields that are empty, dispatches input and change events so
// frameworks notice the value, and never overwrites something the user has typed.

/** Ask the background for this site's burner address. */
async function fetchBurnerAddress(): Promise<string | null> {
  try {
    const reply = (await browser.runtime.sendMessage({
      type: "poison:burner",
      hostname: location.hostname,
    })) as { address?: string } | undefined;
    return reply?.address ?? null;
  } catch {
    return null; // background unavailable; leave the page untouched
  }
}

/**
 * Whether an input looks like an email field. Covers the explicit type plus the common name, id, and
 * autocomplete heuristics sites use for signup and login email boxes.
 */
function isEmailField(input: HTMLInputElement): boolean {
  const type = (input.getAttribute("type") ?? "").toLowerCase();
  if (type === "email") return true;
  // Password, checkbox, and similar typed inputs are never email fields.
  if (type && type !== "text") return false;

  const autocomplete = (input.getAttribute("autocomplete") ?? "").toLowerCase();
  if (autocomplete === "email") return true;

  const haystack = [
    input.getAttribute("name"),
    input.id,
    input.getAttribute("placeholder"),
    input.getAttribute("aria-label"),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  return /\be[\s._-]?mail\b|courriel/.test(haystack);
}

/** Fill an empty email field with the address, notifying any listening framework. */
function fillField(input: HTMLInputElement, address: string): void {
  if (input.value.trim() !== "") return; // never clobber what the user typed
  input.value = address;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillAll(address: string): void {
  const inputs = document.querySelectorAll<HTMLInputElement>("input");
  for (const input of inputs) {
    if (isEmailField(input)) fillField(input, address);
  }
}

async function run(): Promise<void> {
  const address = await fetchBurnerAddress();
  if (!address) return;

  fillAll(address);

  // Signup forms are often rendered after load (single page apps, modals). Watch for new email
  // fields for a short window and fill them as they appear, then stop to stay light.
  const observer = new MutationObserver(() => fillAll(address));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 10000);
}

void run();

// Keep this file's symbols local (tsc treats content scripts as one global script scope otherwise).
export {};
