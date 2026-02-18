/**
 * Chrome Cookie Reader
 *
 * Disabled in this build: reading Chrome's encrypted cookie DB requires invoking
 * external OS tooling, which is blocked by security policy for marketplace packages.
 */

export interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

/**
 * Cookie extraction from local Chrome profile is disabled.
 * Returns an empty map so callers can gracefully continue.
 */
export function readChromeCookies(_domain: string): Record<string, string> {
  return {};
}

/**
 * Cookie extraction from local Chrome profile is disabled.
 * Returns an empty list so callers can gracefully continue.
 */
export function readChromeCookiesFull(_domain: string): ChromeCookie[] {
  return [];
}

/**
 * Feature toggle for callers.
 */
export function chromeCookiesAvailable(): boolean {
  return false;
}
