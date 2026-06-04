// CDP_PRIMITIVES.md §spoof-surface — Emulation.setUserAgentOverride (preferred over Network.*)

import type { Target, UserAgentMetadata } from "../types.js";

/**
 * Emulation.setUserAgentOverride — the modern UA + sec-ch-ua-* spoof.
 * Preferred over Network.setUserAgentOverride because Chrome syncs JS-side
 * (navigator.userAgent / navigator.platform / navigator.userAgentData) automatically.
 */
export async function setUserAgentOverride(
  _target: Target,
  _userAgent: string,
  _opts?: { acceptLanguage?: string; platform?: string; userAgentMetadata?: UserAgentMetadata },
): Promise<{ ua: string; hints: number }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Build a realistic UserAgentMetadata object for the current pinned Chrome revision.
 * Used by ensureChrome's revision pin + this spoof at session start.
 */
export function buildUserAgentMetadata(_chromeMajor: number, _platform: "macOS" | "Windows" | "Linux"): UserAgentMetadata {
  throw new Error("not_implemented_yet: scaffold only");
}
