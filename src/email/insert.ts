// Content script for the ON-DEMAND burner insertion (replaces the old auto-fill MutationObserver).
// Instead of silently filling every empty email field for 10s, the burner is now offered as an
// explicit "Insérer une adresse jetable" context-menu action: the user right-clicks the field they
// actually want, and only THAT field is filled. This is friendlier (no surprise values appearing in
// forms) and — crucially — it means the burner never fights Firefox Relay's inline chip, because it
// only ever acts on a deliberate user gesture (see background.ts for the Relay reasoning).
//
// This script runs in the CONTENT world, top frame only (registered with allFrames:false in
// background.ts). Two halves:
//   1. It tracks the element under the pointer at `contextmenu` time — the browser fires that event on
//      the same element it uses to decide the menu's `contexts: ["editable"]` match, so the element we
//      remember is exactly the field whose right-click opened the menu.
//   2. On the "poison:insert-burner" message from the background (sent when the menu item is clicked),
//      it fills THAT remembered element with the address, after defensively re-checking the target is a
//      visible, editable, empty first-party field.
//
// Because the menu is `contexts: ["editable"]` and this script is top-frame only, honeypots (hidden
// inputs) and tracker iframes (cross-origin subframes) are excluded by construction. The visibility /
// editability re-check below is belt-and-braces: it guards against the field being swapped or hidden
// between the right-click and the click on the menu item.

/** The element the user last right-clicked. Captured on every `contextmenu`, consumed on insert. We
 *  keep only the most recent one: a fresh right-click always supersedes the previous target, so a
 *  stale reference can never be filled. */
let lastContextTarget: Element | null = null;

// Capture phase so we see the event before any page handler can stopPropagation() it. The target is
// the deepest element under the pointer, which for a right-click inside a field is that field.
document.addEventListener(
  "contextmenu",
  (event) => {
    lastContextTarget = event.target instanceof Element ? event.target : null;
  },
  true,
);

/** An editable text-like field we are willing to fill: a plain/email <input> or a <textarea>. We
 *  reject other input types (password, checkbox, hidden, …) so we never write into a control that is
 *  not a free-text field. `disabled`/`readonly` fields are refused too — the user cannot type there,
 *  so neither should we. */
function isFillableField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) {
    return !el.disabled && !el.readOnly;
  }
  if (el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly) return false;
    // Only free-text input types. An absent type defaults to "text", which is fine.
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    return type === "text" || type === "email" || type === "search" || type === "url" || type === "";
  }
  return false;
}

/** Whether an element actually occupies space ON SCREEN. A honeypot input is typically display:none,
 *  zero-sized, or moved off-screen; we reject all three:
 *   - `offsetParent === null` catches display:none and detached nodes. A `position:fixed` element also
 *     reports a null offsetParent while being perfectly visible, so we exempt it from this test (and
 *     lean on the rect checks below instead) rather than wrongly rejecting a fixed field.
 *   - a zero client rect catches the collapsed/hidden cases.
 *   - a rect that lies entirely outside the viewport catches the "moved off-screen" trick (e.g.
 *     left:-9999px), which the size check alone would miss — a fixed, real-sized, off-screen honeypot
 *     would otherwise slip through. We require the rect to intersect the viewport at all.
 *  Only a field the user can actually see passes, so we never insert into an invisible trap. */
function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  // Reject a rect that does not overlap the viewport at all (fully off to a side or above/below).
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const onScreen = rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  return onScreen;
}

/** Fill the field with the address, notifying any listening framework. Mirrors the old autofill's
 *  event dance: set .value, then dispatch bubbling `input` and `change` so React/Vue/etc. pick up the
 *  change rather than seeing a value they never rendered. Never clobbers a non-empty field. */
function fillField(field: HTMLInputElement | HTMLTextAreaElement, address: string): void {
  if (field.value.trim() !== "") return; // never overwrite what the user already typed
  field.value = address;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

// The background messages us when the context-menu item is clicked. We answer with a small ack so the
// background can log a miss (e.g. the field vanished), but the insertion itself is fire-and-forget.
browser.runtime.onMessage.addListener(
  (message: unknown): Promise<unknown> | undefined => {
    const msg = message as { type?: string; address?: string };
    if (msg?.type !== "poison:insert-burner" || typeof msg.address !== "string") return undefined;

    const target = lastContextTarget;
    // Re-validate at insert time: the target must still be a fillable, visible field. This defends
    // against the page swapping or hiding the element between the right-click and the menu click.
    if (target instanceof HTMLElement && isFillableField(target) && isVisible(target)) {
      fillField(target, msg.address);
      return Promise.resolve({ inserted: true });
    }
    return Promise.resolve({ inserted: false });
  },
);

// Keep this file's symbols local (tsc treats content scripts as one global script scope otherwise).
export {};
