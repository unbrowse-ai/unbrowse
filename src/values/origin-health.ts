/**
 * Is this failure the ORIGIN being unreachable, rather than the site saying no?
 *
 * The distinction matters because the two failures have opposite remedies. A
 * site that answered — 403, a challenge, an interstitial, a login wall — has
 * something a different client might get past. An origin that never answered at
 * all (DNS does not resolve, TCP refused, the CDN cannot reach its backend) has
 * nothing behind it: every client, browser included, hits the identical wall.
 *
 * This predicate is the ONE definition of that vocabulary. It was three copies:
 * `softOkQualityScore` in values/layer-adapters.ts, `SOFT_FAIL_ERR` in
 * bench/sites100/strict_ok.py, and — missing entirely — the browser-fallback
 * decision, which is why a host with no DNS record still bought a full browser
 * launch. The python copy is a separate runtime and stays, but the two
 * TypeScript readers now share this.
 *
 * Structural, not a hostname list: it keys off the transport-layer reason, so a
 * dead origin nobody has enumerated is recognised for free.
 *
 * Pure — no fs, no clock, no network — so the permutation matrix can exhaust it.
 */
const ORIGIN_UNREACHABLE_MARKERS = [
  "origin_down",
  "origin_ssl",
  "origin_dns",
  "enotfound",
  "getaddrinfo",
  "econnrefused",
  "ssl handshake failed",
  "error code 52",
] as const;

/**
 * True when `error` names a transport-layer failure to reach the origin.
 *
 * Substring-matched because these reasons arrive wrapped by whichever layer
 * caught them ("probe network error (getaddrinfo ENOTFOUND swapi.dev)").
 */
export function isOriginUnreachableError(error: unknown): boolean {
  if (typeof error !== "string") return false;
  const err = error.trim().toLowerCase();
  if (!err) return false;
  return ORIGIN_UNREACHABLE_MARKERS.some((m) => err.includes(m));
}
