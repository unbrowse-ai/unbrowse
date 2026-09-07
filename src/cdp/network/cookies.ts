// CDP_PRIMITIVES.md §L-network — Network.getCookies / setCookies / clearBrowserCookies

import type { CDPCookie, Target } from "../types.js";

/**
 * Network.getCookies — values redacted in the covenant receipt; full values returned in-process.
 */
export async function getCookies(
  _target: Target,
  _opts?: { urls?: string[] },
): Promise<{ cookies: CDPCookie[] }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Network.setCookies — cookie injection from Chrome/Firefox SQLite at session start.
 * Replaces Kuri `setCookie` + `setCookies`.
 */
export async function setCookies(
  _target: Target,
  _cookies: CDPCookie[],
): Promise<{ count: number; domains: string[] }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Network.deleteCookies — single-cookie delete (composes for clear-by-domain).
 */
export async function deleteCookies(
  _target: Target,
  _opts: { name: string; url?: string; domain?: string; path?: string },
): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Network.clearBrowserCookies — fresh-session isolation between parallel probes.
 */
export async function clearBrowserCookies(_target: Target): Promise<{ cleared: true }> {
  throw new Error("not_implemented_yet: scaffold only");
}
