// Strike counter for 404-based local eviction.
//
// Pre-2026-05-19: every 404 immediately evicted the endpoint from the
// local route cache (src/execution/index.ts:3473). The backend's own
// deprecation policy uses 2 strikes; the local mirror was single-strike,
// so any one-off 404 (transient cache miss, race, recovery in-flight)
// killed callable sibling endpoints (bench-gate probe 003 crates.io
// 2026-05-19: stale-eviction-during-retry, see PR #503).
//
// This module aligns the local mirror to the backend's 2-strike policy
// while keeping 410 Gone as an unambiguous single-strike signal — 410
// is the protocol-level "this URL is gone for good", whereas 404 has
// far more transient causes worth tolerating once.
//
// Anti-pattern this avoids: a heuristic verdict baked into the
// platform. The strike count is observed evidence (consecutive 404s
// within a window), not a per-domain or per-pattern judgement.

const STRIKE_THRESHOLD = 2;
const STRIKE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

type StrikeKey = string;
type StrikeRecord = { count: number; firstAt: number; lastAt: number };

const strikes = new Map<StrikeKey, StrikeRecord>();

function key(skillId: string, endpointId: string, scope?: string): StrikeKey {
  return `${scope ?? "global"}:${skillId}:${endpointId}`;
}

/**
 * Record a non-fatal-but-suspect HTTP failure (e.g. 404) for an
 * endpoint. Returns whether the strike count has crossed the eviction
 * threshold and the caller should now evict. Strikes outside the
 * window reset — a one-off 404 every few hours never accumulates.
 *
 * `evictNow` callers (e.g. 410 Gone, explicit invalidation) should
 * bypass this function and call evictCachedEndpoint directly.
 */
export function recordEndpointStrike(
  skillId: string,
  endpointId: string,
  scope?: string,
): { shouldEvict: boolean; strikes: number; windowMs: number } {
  const k = key(skillId, endpointId, scope);
  const now = Date.now();
  const existing = strikes.get(k);
  if (!existing || now - existing.firstAt > STRIKE_WINDOW_MS) {
    // First strike, or stale window — restart the counter.
    strikes.set(k, { count: 1, firstAt: now, lastAt: now });
    return { shouldEvict: false, strikes: 1, windowMs: STRIKE_WINDOW_MS };
  }
  existing.count += 1;
  existing.lastAt = now;
  if (existing.count >= STRIKE_THRESHOLD) {
    // Crossed threshold; drop the record so a re-published endpoint
    // gets a clean strike window if it ever returns.
    strikes.delete(k);
    return { shouldEvict: true, strikes: STRIKE_THRESHOLD, windowMs: STRIKE_WINDOW_MS };
  }
  return { shouldEvict: false, strikes: existing.count, windowMs: STRIKE_WINDOW_MS };
}

/**
 * Clear the strike counter for an endpoint — call this on a successful
 * execute so transient failures don't accumulate forever toward
 * eviction.
 */
export function clearEndpointStrikes(
  skillId: string,
  endpointId: string,
  scope?: string,
): void {
  strikes.delete(key(skillId, endpointId, scope));
}

/** Test-only: inspect current strike state. */
export function _strikeStateForTests(): ReadonlyMap<StrikeKey, StrikeRecord> {
  return strikes;
}

/** Test-only: reset all strikes. */
export function _resetStrikesForTests(): void {
  strikes.clear();
}

export const STRIKE_THRESHOLD_FOR_TESTS = STRIKE_THRESHOLD;
export const STRIKE_WINDOW_MS_FOR_TESTS = STRIKE_WINDOW_MS;
