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
 * Common geo-redirect TLD suffixes that sites use for country-specific variants.
 * e.g. airbnb.com.sg, agoda.com.sg, booking.com.sg, airbnb.co.id, etc.
 * These are NOT in the PSL as multi-level registrable domains but are used as
 * geo-redirect suffixes by global sites.
 */
const GEO_TLD_SUFFIXES = new Set([
  // .com.<cc> geo-variants
  "com.sg", "com.hk", "com.my", "com.ph", "com.vn", "com.id",
  "com.th", "com.np", "com.pk", "com.bd", "com.lk", "com.mm",
  "com.kh", "com.eg", "com.sa", "com.qa", "com.ae", "com.kw",
  "com.jo", "com.lb", "com.bh", "com.om", "com.iq",
  // .co.<cc> geo-variants
  "co.id", "co.th", "co.nz", "co.jp", "co.kr", "co.in", "co.uk",
  "co.za", "co.zw", "co.ke", "co.tz", "co.ug",
]);

/**
 * Extract the brand name (SLD) from a hostname, stripping subdomains and TLD/ccTLD.
 * e.g. "www.airbnb.com.sg" → "airbnb"
 *       "api.airbnb.com"    → "airbnb"
 *       "airbnb.co.uk"      → "airbnb"
 *       "booking.com"       → "booking"
 */
export function getBrandName(hostname: string): string {
  const h = hostname.replace(/^\./, "").toLowerCase();
  const parts = h.split(".");
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join(".");
    if (GEO_TLD_SUFFIXES.has(lastTwo) || CC_TLDS.has(lastTwo)) {
      // e.g. ["www", "airbnb", "com", "sg"] → brand = parts[-3] = "airbnb"
      return parts[parts.length - 3] ?? parts[0] ?? h;
    }
  }
  // Standard: last two parts are TLD+SLD, brand is SLD
  return parts[parts.length - 2] ?? parts[0] ?? h;
}

/**
 * Returns true if two hostnames refer to the same brand, ignoring geo-variant
 * country-code TLD suffixes. For example:
 *   isSameBrandDomain("www.airbnb.com.sg", "www.airbnb.com") → true
 *   isSameBrandDomain("agoda.com.sg", "agoda.com")           → true
 *   isSameBrandDomain("airbnb.com", "booking.com")           → false
 */
export function isSameBrandDomain(a: string, b: string): boolean {
  return getBrandName(a) === getBrandName(b);
}

/**
 * Get the registrable domain, handling ccTLDs like .co.uk, .com.br, etc.
 * e.g., "api.example.co.uk" → "example.co.uk"
 *        "sub.example.com"   → "example.com"
 */
export function getRegistrableDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join(".");
    if (CC_TLDS.has(lastTwo) || GEO_TLD_SUFFIXES.has(lastTwo)) {
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