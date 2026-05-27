// CDP_PRIMITIVES.md §L-network — Network.setExtraHTTPHeaders + Network.setUserAgentOverride

import type { Target, UserAgentMetadata } from "../types.js";

/**
 * Network.setExtraHTTPHeaders — spoof + auth header replay; declared once per session.
 */
export async function setExtraHTTPHeaders(
  _target: Target,
  _headers: Record<string, string>,
): Promise<{ headerKeys: string[] }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Network.setUserAgentOverride — UA + sec-ch-ua-* client hints in one shot.
 * Prefer the Emulation domain variant for newer client-hint handling.
 */
export async function setUserAgentOverride(
  _target: Target,
  _userAgent: string,
  _opts?: { acceptLanguage?: string; platform?: string; userAgentMetadata?: UserAgentMetadata },
): Promise<{ ua: string; secChUaHintCount: number }> {
  throw new Error("not_implemented_yet: scaffold only");
}
