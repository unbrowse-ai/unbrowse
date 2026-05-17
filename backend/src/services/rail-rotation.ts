/**
 * L2 rail rotation (unbrowse-payments-faremeter).
 *
 * The Flex 402 envelope advertises two accept entries side by side:
 * `@faremeter/flex` (self-hosted facilitator, on-chain splits) and
 * `exact` (PayAI facilitator, single-recipient, off-chain). Clients
 * choose which to pay -- but in practice they pay the FIRST one whose
 * scheme they recognize. So the ordering of the accepts array decides
 * which rail runs production traffic.
 *
 * `PAYAI_ROTATION_BPS` (0 - 10000) decides the weight. We hash the
 * caller's agent_id to a stable per-agent bucket so:
 *  - a given agent always sees the same ordering inside the bucket
 *    (latency / fill-rate comparisons hold across calls)
 *  - traffic is split deterministically rather than randomly per request
 *
 * Pure function, no IO, no Date.now() -- entirely a function of (env,
 * agent_id). Same input always gives the same output. Easy to test, easy
 * to reason about, and the test suite asserts the determinism.
 */

const DEFAULT_ROTATION_BPS = 5000;

export type Rail = "flex" | "payai";

export interface RailRotation {
  /** Which rail's accept entry comes FIRST in the 402 envelope. */
  primary: Rail;
  /** Bucket the caller's agent_id mapped to (0 - 9999). */
  bucket: number;
  /** Effective rotation weight that produced this decision. */
  effective_bps: number;
}

/**
 * 32-bit FNV-1a over the agent id. Stable across runtimes, no crypto
 * dependency, deterministic. Output is mapped to [0, 9999].
 *
 * We deliberately do NOT use a cryptographic hash here: the bucket is a
 * routing decision, not a security boundary. FNV-1a's avalanche is good
 * enough that adjacent agent IDs land in different buckets.
 */
function bucketOf(agentId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    // h = h * 16777619, in unsigned 32-bit
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h % 10000;
}

function parseBps(raw: string | undefined): number {
  if (!raw) return DEFAULT_ROTATION_BPS;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_ROTATION_BPS;
  if (n < 0) return 0;
  if (n > 10000) return 10000;
  return n;
}

/**
 * Decide which rail's accept entry to advertise FIRST for a given agent.
 * Anonymous callers (`undefined` or empty agent_id) land in bucket 0,
 * which makes the rotation default toward Flex when the rotation weight
 * is conservative. That matches the principle that an unauthenticated
 * caller is best served by the on-chain-splits rail by default.
 */
export function pickRail(
  env: { PAYAI_ROTATION_BPS?: string },
  agentId: string | undefined,
): RailRotation {
  const effective_bps = parseBps(env.PAYAI_ROTATION_BPS);
  const bucket = agentId ? bucketOf(agentId) : 0;
  // High buckets are PayAI-leaning; low buckets are Flex-leaning. Threshold
  // `10000 - effective_bps` means:
  //   effective_bps=0     -> threshold=10000, nothing passes -> always flex
  //   effective_bps=10000 -> threshold=0,     everything passes -> always payai
  //   effective_bps=5000  -> threshold=5000,  buckets 5000..9999 -> payai (~50%)
  // Anonymous callers (bucket 0) always land on Flex unless rotation is
  // fully cranked up. This protects contributors-bearing skills under the
  // default rotation -- the PayAI exact path doesn't carry the splits.
  const threshold = 10000 - effective_bps;
  const primary: Rail = bucket >= threshold ? "payai" : "flex";
  return { primary, bucket, effective_bps };
}

/**
 * Header value advertising which rail the dispatched scheme ran on, so
 * we can correlate fill rate / latency by rail in telemetry. Set on the
 * route response by the dispatcher (handleFlexPaymentAuthorized routes
 * to PayAI when the client's X-PAYMENT carried scheme:"exact", else to
 * Flex).
 */
export function railHintHeader(rail: Rail): { "X-Unbrowse-Rail-Hint": Rail } {
  return { "X-Unbrowse-Rail-Hint": rail };
}
