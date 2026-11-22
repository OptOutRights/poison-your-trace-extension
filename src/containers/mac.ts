// Ask Firefox Multi-Account Containers whether it assigns a URL to a container, through its public
// messaging API (the one temporary-containers uses). Multi-Account Containers only answers extensions
// that have the contextualIdentities permission, which we do.

const MULTI_ACCOUNT_CONTAINERS_ID = "@testpilot-containers";

// Multi-Account Containers answers in a few milliseconds; when it is not installed sendMessage rejects
// at once. The timeout only guards against it never answering, so a navigation is never held up long.
const TIMEOUT_MS = 1000;

/**
 * True when Multi-Account Containers assigns this URL to a container ("Always open this site in…"),
 * with or without "Remember my decision". False when it does not, or when Multi-Account Containers is
 * missing, disabled or not answering. Never throws.
 */
export async function isAssignedByMac(url: string): Promise<boolean> {
  try {
    const answer = await Promise.race([
      browser.runtime.sendMessage(MULTI_ACCOUNT_CONTAINERS_ID, { method: "getAssignment", url }) as Promise<unknown>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);
    // An assignment is an object carrying the container's userContextId; null when unassigned.
    return typeof answer === "object" && answer !== null && "userContextId" in answer;
  } catch {
    return false;
  }
}
