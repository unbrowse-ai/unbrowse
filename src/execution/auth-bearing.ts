/**
 * B1 firmament — the auth-bearing egress classifier.
 *
 * Divides the egress stream into two waters (Gen 1:6-7): a request is
 * "auth-bearing" when it carries a credential a *terminating* server tier could
 * read in the clear — `Authorization` / `Cookie` / `X-Api-Key` /
 * `Proxy-Authorization`, a `Bearer`/`Token` value in any header, or a locally
 * dereferenced sealed fill. Such a request must NEVER be handed to the server
 * `/v1/proxy` tier (which terminates TLS and sees headers + body). This predicate
 * is the single source of truth that both the egress router (egress-chain.ts) and
 * the server-proxy backstop (server-proxy-fallback.ts) consult.
 *
 * Pure, no I/O — Matt 6:6: keep the closet door shut even when the request needs
 * a clean IP to leave the house. Lending an IP must not mean opening the closet.
 *
 * Inclusive by default (deny-list, not allow-list): a request is auth-bearing if
 * it carries ANY cookie, ANY storage-derived value, or ANY header that is NOT one
 * of the generic, non-identifying browser defaults below. Cookies, `X-Api-Key`,
 * CSRF tokens, and any custom `X-*` header (the shapes storage-derived auth takes
 * on the wire) are all caught. The ONLY headers that keep a request eligible for
 * the terminating server tier are the benign defaults every anonymous public GET
 * already sends — so public web-search keeps its local -> server-clean-IP ->
 * client-proxy throttle recovery, and everything else stays local.
 */

/**
 * Generic, non-identifying request headers an anonymous public GET already sends.
 * A request carrying ONLY these (and no cookie) is not auth-bearing. Anything
 * outside this set — cookies, api keys, csrf, bespoke `X-*` tokens, storage-derived
 * values — is treated as a credential and kept off the terminating server tier.
 */
const BENIGN_HEADER_KEYS: ReadonlySet<string> = new Set([
  "user-agent", "accept", "accept-language", "accept-encoding", "accept-charset",
  "content-type", "content-length", "referer", "origin", "cache-control", "pragma",
  "connection", "host", "dnt", "upgrade-insecure-requests", "range", "te", "priority",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-ch-ua-platform-version",
  "sec-ch-ua-arch", "sec-ch-ua-bitness", "sec-ch-ua-full-version", "sec-ch-ua-full-version-list",
  "sec-ch-ua-model", "viewport-width", "width", "downlink", "ect", "rtt", "save-data",
]);

/** A credential-shaped value in any header (e.g. `Bearer eyJ...`, `Token abc`). */
const CREDENTIAL_VALUE = /^(?:bearer|token)\s+\S/i;

export interface AuthBearingOpts {
  /**
   * The caller already dereferenced a sealed credential fill into this request
   * (value typed locally). Forces auth-bearing even if the header scan misses it.
   */
  sealedFill?: boolean;
  /**
   * The request carries values derived from the site's local storage / session
   * storage (tokens, ids). Forces auth-bearing. (On the wire these usually arrive
   * as non-benign headers and are caught anyway; this is the explicit signal.)
   */
  storageBound?: boolean;
}

/** True iff the request carries a credential/identity a terminating server tier could read. */
export function isAuthBearing(
  headers?: Record<string, string> | Headers | null,
  opts: AuthBearingOpts = {},
): boolean {
  if (opts.sealedFill || opts.storageBound) return true;
  if (!headers) return false;
  // Fail SAFE on a Headers object: `Object.entries(new Headers(...))` is `[]`, so
  // a plain entries() scan would silently miss a credential. Normalize a Headers
  // instance (or any [key,value] iterable) to entries before classifying.
  const entries: Iterable<[string, string]> =
    typeof (headers as Headers).entries === "function" && typeof (headers as Headers).forEach === "function"
      ? (headers as Headers).entries()
      : Object.entries(headers as Record<string, string>);
  for (const [key, value] of entries) {
    // Any header outside the benign generic-browser set is identity/credential-
    // bearing (cookies, api keys, csrf, custom X-* tokens, storage-derived values).
    if (!BENIGN_HEADER_KEYS.has(key.toLowerCase())) return true;
    // Defense-in-depth: a credential-shaped value even inside a benign header name.
    if (typeof value === "string" && CREDENTIAL_VALUE.test(value)) return true;
  }
  return false;
}
