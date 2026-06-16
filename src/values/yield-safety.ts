/**
 * yield-safety — decide whether a prerequisite's extracted yields are SAFE to persist in the
 * cross-invocation resolution ledger (the persistent cascade). Two cold-audit findings make a naive
 * "cache any ok+non-empty yield" gate unsafe:
 *
 *   (A) one-time / freshness: a yield that is a token / nonce / CSRF / session id / signature must
 *       never be replayed stale within the TTL. We reject any yield whose KEY looks auth-bearing or
 *       single-use (conservative: err toward NOT persisting).
 *   (B) principal scope: the cascade's principal is derived from auth_headers only — it does NOT see
 *       cookies (loaded later in execution). So a COOKIE-authed prerequisite's user-specific yield
 *       would mis-partition as "anon" and leak cross-principal. Since we cannot see the live cookies
 *       at the walk, we reject any yield from an AUTH-BACKED endpoint (auth_required / auth_profile_ref
 *       on the endpoint or skill). Only genuinely public, non-token yields persist.
 *
 * The remaining edge (an endpoint that uses cookies but carries no auth marker) is named, not hidden:
 * folding the live cookie credential into the principal is the full fix. Combined with the cascade
 * being OPT-IN (default OFF), the shipped default is fully safe; this gate hardens the opted-in path.
 *
 * Pure + dependency-free so it is unit-witnessable.
 */

/** Tokens that mark a yield as single-use / auth-bearing / freshness-sensitive. A key tokenizing to
 *  any of these (snake/kebab/dot AND camelCase aware) must not be persisted+replayed. Conservative:
 *  over-rejection (e.g. "state", "code") only lowers the hit rate — it never leaks. */
const ONE_TIME_TOKENS = new Set([
  "csrf", "xsrf", "nonce", "otp", "token", "jwt", "bearer", "secret", "session", "sid", "sess",
  "auth", "signature", "sig", "expires", "expiry", "exp", "timestamp", "ts", "cookie", "cookies",
  "password", "passwd", "pwd", "code", "state", "verifier", "challenge",
]);

/** Split a key into lowercase tokens on snake/kebab/dot separators AND camelCase humps. */
function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .split(/[_\-.\s]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

/** True when the yield's key looks like a one-time/auth-bearing value (so it must NOT be persisted). */
export function isOneTimeYieldKey(key: string): boolean {
  return tokenizeKey(key).some((tok) => ONE_TIME_TOKENS.has(tok));
}

/** Minimal shapes this reads — tolerant of partial objects. */
interface EndpointLike {
  semantic?: { auth_required?: boolean } | null;
  auth_profile_ref?: string | null;
}
interface SkillLike {
  auth_profile_ref?: string | null;
}

/** True when the endpoint (or its skill) is auth-backed, so its yields may be user-specific and must
 *  not be persisted under the cookie-blind principal. */
export function endpointIsAuthBacked(endpoint: EndpointLike | undefined, skill: SkillLike | undefined): boolean {
  return (
    endpoint?.semantic?.auth_required === true ||
    !!endpoint?.auth_profile_ref ||
    !!skill?.auth_profile_ref
  );
}

/**
 * The persistent-cascade cacheable gate: persist the prereq's yields ONLY when
 *   - the execution succeeded (ok) and produced at least one yield, AND
 *   - the endpoint is NOT auth-backed (closes finding B — no cookie-authed user data under anon), AND
 *   - NO yielded key looks one-time/auth-bearing (closes finding A — no token/nonce replay).
 * Conservative by design: any doubt → do not persist (an honest miss + recompute next time).
 */
export function isPersistableYield(
  ok: boolean,
  yields: Record<string, unknown>,
  endpoint: EndpointLike | undefined,
  skill: SkillLike | undefined,
): boolean {
  if (!ok) return false;
  const keys = Object.keys(yields ?? {});
  if (keys.length === 0) return false;
  if (endpointIsAuthBacked(endpoint, skill)) return false;
  if (keys.some(isOneTimeYieldKey)) return false;
  return true;
}
