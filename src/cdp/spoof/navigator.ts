// CDP_PRIMITIVES.md §spoof-surface — Page.addScriptToEvaluateOnNewDocument: navigator.* shims

import type { SpoofInitScript, Target } from "../types.js";

/**
 * Install the navigator-shim init script: delete navigator.webdriver, proxy
 * navigator.plugins / navigator.mimeTypes, define window.chrome.runtime,
 * patch Notification.permission to match document.visibilityState.
 *
 * Composes addInitScript with a deterministic source string.
 */
export async function installNavigatorShim(_target: Target): Promise<SpoofInitScript> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Source string of the navigator shim (exposed for hash-verification / drift detection).
 */
export function navigatorShimSource(): string {
  throw new Error("not_implemented_yet: scaffold only");
}
