/**
 * Shared domain utilities for ccTLD-aware domain parsing and suffix matching.
 */

/** Common ccTLD patterns (country-code second-level domains). */
const CC_TLDS = new Set([
  "co.uk", "co.nz", "co.jp", "co.kr", "co.in",
  "com.br", "com.au", "com.cn", "com.mx", "com.ar", "com.tw",
  "org.uk", "gov.uk", "ac.uk", "net.au", "org.au",
]);

/**
 * Get the registrable domain, handling ccTLDs like .co.uk, .com.br, etc.
 * e.g., "api.example.co.uk" → "example.co.uk"
 *        "sub.example.com"   → "example.com"
 */
export function getRegistrableDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join(".");
    if (CC_TLDS.has(lastTwo)) {
      return parts.slice(-3).join(".");
    }
  }
  return parts.slice(-2).join(".");
}

/**
 * Proper domain suffix matching.
 * Returns true if cookieDomain matches targetDomain or is a parent of it.
 * e.g., isDomainMatch(".google.com", "mail.google.com") → true
 *        isDomainMatch("notgoogle.com", "google.com") → false
 */
export function isDomainMatch(cookieDomain: string, targetDomain: string): boolean {
  const c = cookieDomain.replace(/^\./, "").toLowerCase();
  const t = targetDomain.replace(/^\./, "").toLowerCase();
  return t === c || t.endsWith("." + c);
}