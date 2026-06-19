/**
 * Tier 1 delta-based contribution attribution — issue #98
 *
 * When an indexed route executes successfully, we credit the indexer who
 * published it using a delta-based allocation:
 *
 *   delta_score = chosen_reliability - next_best_reliability
 *                 (clamped to [0, 1]; 0 if no alternative is known)
 *
 *   fee_allocated_uc = BASE_FEE_UC + round(DELTA_BONUS_UC * delta_score)
 *
 * This rewards indexers proportionally to the marginal value of their route
 * over the next best known alternative — indexers who provide uniquely
 * reliable routes earn more than those whose routes are replaceable.
 *
 * All values stored in micro-cents (1 unit = $0.000001) for integer safety.
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";
import { creditEarnings } from "./credits.js";
import { sha256hex, readEvents, listPartitions } from "./event-ledger.js";

// ─── Fee parameters ───────────────────────────────────────────────────────────

/** Base attribution credit per successful execution (µ¢). */
export const BASE_FEE_UC = 50;

/**
 * Maximum bonus on top of the base, achieved when delta_score = 1.0
 * (i.e. the chosen route is the only viable option).
 */
export const DELTA_BONUS_UC = 150;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AttributionEvent {
  execution_id: string;
  skill_id: string;
  endpoint_id: string;
  indexer_id: string;
  /** Reliability score of the executed endpoint [0, 1]. */
  reliability_score: number;
  /** Reliability score of the best alternative from a different indexer [0, 1]. */
  next_best_score: number;
  /** Marginal contribution: reliability_score - next_best_score, clamped to [0, 1]. */
  delta_score: number;
  /** Micro-cents allocated to this indexer for this execution. */
  fee_allocated_uc: number;
  timestamp: string;
}

export interface IndexerAttributionLedger {
  indexer_id: string;
  /** Total micro-cents credited across all attributed executions. */
  total_credited_uc: number;
  /** USD equivalent (total_credited_uc / 1_000_000). */
  total_credited_usd: number;
  execution_count: number;
  /** Sum of delta scores — higher means consistently unique routes. */
  cumulative_delta: number;
  /** Average delta per execution [0, 1]. */
  avg_delta: number;
  /** Count of failed-execution slashes applied (opt-in slashing). */
  slashed_count?: number;
  first_attributed_at: string;
  last_attributed_at: string;
}

export interface AttributionSummary {
  total_indexers_credited: number;
  total_credited_uc: number;
  total_credited_usd: number;
  total_executions_attributed: number;
  avg_delta_score: number;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

// Append-only event-log keys, content-addressed on execution_id: each distinct
// execution gets a distinct key (no lost update on the CAS-free KV), and a replay
// of the same execution is an idempotent no-op write to the same key. Balances are
// a PROJECTION over these rows — never a mutated accumulator blob.
const EVENT_PREFIX = "attribution:event:"; // attribution:event:<indexer>:<sha256(execution_id)>
const SLASH_PREFIX = "attribution:slash:"; // attribution:slash:<indexer>:<sha256(execution_id)>

async function eventKey(indexerId: string, executionId: string): Promise<string> {
  return `${EVENT_PREFIX}${indexerId}:${await sha256hex(executionId)}`;
}
async function slashKey(indexerId: string, executionId: string): Promise<string> {
  return `${SLASH_PREFIX}${indexerId}:${await sha256hex(executionId)}`;
}

interface SlashEvent { execution_id: string; slash_delta: number; timestamp: string }

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Compute delta score and allocated fee for a single execution.
 * Pure function — no I/O.
 */
export function computeAttribution(
  reliabilityScore: number,
  nextBestScore: number,
): { delta_score: number; fee_allocated_uc: number } {
  const delta_score = Math.max(0, Math.min(1, reliabilityScore - nextBestScore));
  const fee_allocated_uc = BASE_FEE_UC + Math.round(DELTA_BONUS_UC * delta_score);
  return { delta_score, fee_allocated_uc };
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Record a Tier 1 attribution event and update the indexer's ledger.
 * Called after a successful route execution when the skill has an indexer_id.
 */
export async function recordAttribution(
  env: Env,
  event: Omit<AttributionEvent, "delta_score" | "fee_allocated_uc" | "timestamp">,
): Promise<AttributionEvent> {
  const { delta_score, fee_allocated_uc } = computeAttribution(
    event.reliability_score,
    event.next_best_score,
  );
  const now = new Date().toISOString();
  const fullEvent: AttributionEvent = { ...event, delta_score, fee_allocated_uc, timestamp: now };

  const kv = statsKV(env);
  const key = await eventKey(event.indexer_id, event.execution_id);

  // Idempotent append: if this execution is already recorded it's a replay —
  // return the stored event and do NOT re-credit. Distinct executions get
  // distinct keys, so concurrent records never overwrite each other (no lost
  // update on the CAS-free KV). The balance is projected by getIndexerLedger.
  const existing = await kv.get(key) as string | null;
  if (existing) {
    try { return JSON.parse(existing) as AttributionEvent; } catch { /* corrupt — rewrite below */ }
  } else {
    // Credit earnings only on the FIRST observation of this execution (best-effort).
    if (env.CREDITS_ENABLED === "1") {
      try { await creditEarnings(env, event.indexer_id, fee_allocated_uc); } catch { /* ledger may not exist yet */ }
    }
  }

  await kv.put(key, JSON.stringify(fullEvent));
  return fullEvent;
}

// ─── Slashing (opt-in) ─────────────────────────────────────────────────────────
//
// Mirror image of the reward path: when an indexed route FAILS where a viable
// alternative from another indexer existed, the publisher's standing is reduced
// — a route that wastes other agents' calls should not keep earning. Gated two
// ways so it never punishes noise: (1) min-sample (no slash until the route has
// a real track record), (2) only when an alternative actually existed
// (next_best > 0 — there was an opportunity cost). The adjustment is floored at
// the caller so cumulative standing never goes negative.

/** Minimum attributed executions before slashing applies — guards against noise. */
export const SLASH_MIN_SAMPLE = 5;
/** Fraction of the alternative's reliability charged as the penalty per failure. */
export const SLASH_WEIGHT = 0.5;

/**
 * Compute the (negative) delta adjustment for a FAILED execution. Pure function.
 * Returns 0 unless the route has enough history (min-sample) AND a viable
 * alternative existed. Magnitude scales with how good the displaced alternative
 * was — failing where a great alternative existed costs more.
 */
export function computeSlashAdjustment(
  nextBestScore: number,
  executionCount: number,
  opts?: { minSample?: number },
): { slash_delta: number } {
  const minSample = opts?.minSample ?? SLASH_MIN_SAMPLE;
  if (executionCount < minSample) return { slash_delta: 0 };
  const opportunity = Math.max(0, Math.min(1, nextBestScore));
  if (opportunity === 0) return { slash_delta: 0 }; // no alternative → no opportunity cost (avoids -0)
  return { slash_delta: -(opportunity * SLASH_WEIGHT) };
}

/**
 * Record a failed-execution slash against an indexer's ledger. The mirror of
 * `recordAttribution`. Does NOT credit earnings (it is a penalty). Floors the
 * ledger's cumulative_delta at 0. Returns the applied slash_delta (0 = no-op,
 * e.g. below min-sample or no alternative).
 *
 * Caller-gated: only invoked when ATTRIBUTION_SLASHING is enabled, so the live
 * payout economics are unchanged until the operator opts in.
 */
export async function recordFailureAttribution(
  env: Env,
  event: { execution_id: string; skill_id: string; endpoint_id: string; indexer_id: string; next_best_score: number },
): Promise<{ slash_delta: number }> {
  const kv = statsKV(env);
  const ledger = await getIndexerLedger(env, event.indexer_id);
  if (!ledger || ledger.execution_count === 0) return { slash_delta: 0 }; // no history — nothing to slash

  const { slash_delta } = computeSlashAdjustment(event.next_best_score, ledger.execution_count);
  if (slash_delta === 0) return { slash_delta: 0 };

  // Append an idempotent slash event; the projection folds it into cumulative_delta.
  const key = await slashKey(event.indexer_id, event.execution_id);
  if (await kv.get(key)) return { slash_delta }; // this failure already slashed
  const slashEvent: SlashEvent = { execution_id: event.execution_id, slash_delta, timestamp: new Date().toISOString() };
  await kv.put(key, JSON.stringify(slashEvent));
  return { slash_delta };
}

/** Read the attribution ledger for a specific indexer — a PROJECTION (fold) over
 *  the append-only credit + slash event rows. No mutated blob; concurrency-safe. */
export async function getIndexerLedger(
  env: Env,
  indexerId: string,
): Promise<IndexerAttributionLedger | null> {
  const kv = statsKV(env);
  const events = await readEvents<AttributionEvent>(kv, EVENT_PREFIX, indexerId);
  if (events.length === 0) return null;
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const slashes = await readEvents<SlashEvent>(kv, SLASH_PREFIX, indexerId);
  let slashSum = 0;
  for (const s of slashes) slashSum += s.slash_delta;
  const slashedCount = slashes.length;

  let total_credited_uc = 0, creditDelta = 0;
  for (const e of events) { total_credited_uc += e.fee_allocated_uc; creditDelta += e.delta_score; }
  const cumulative_delta = Math.max(0, creditDelta + slashSum);
  const last = slashes.length
    ? [events[events.length - 1].timestamp, ...slashes.map((s) => s.timestamp)].sort().pop()!
    : events[events.length - 1].timestamp;

  return {
    indexer_id: indexerId,
    total_credited_uc,
    total_credited_usd: total_credited_uc / 1_000_000,
    execution_count: events.length,
    cumulative_delta,
    avg_delta: cumulative_delta / events.length,
    slashed_count: slashedCount || undefined,
    first_attributed_at: events[0].timestamp,
    last_attributed_at: last,
  };
}

/** List every indexer id with attribution events (for payout sweeps) — derived
 *  from the event keyspace, no separate (race-prone) index blob. */
export async function listIndexerIds(env: Env): Promise<string[]> {
  return listPartitions<AttributionEvent>(statsKV(env), EVENT_PREFIX, (e) => e.indexer_id);
}

/** Aggregate attribution summary across all indexed routes. */
export async function getAttributionSummary(env: Env): Promise<AttributionSummary> {
  const indexerIds = await listIndexerIds(env);

  const summary: AttributionSummary = {
    total_indexers_credited: indexerIds.length,
    total_credited_uc: 0,
    total_credited_usd: 0,
    total_executions_attributed: 0,
    avg_delta_score: 0,
  };

  if (indexerIds.length === 0) return summary;

  const ledgers = await Promise.all(indexerIds.map((id) => getIndexerLedger(env, id)));
  let totalDelta = 0;

  for (const ledger of ledgers) {
    if (!ledger) continue;
    summary.total_credited_uc += ledger.total_credited_uc;
    summary.total_executions_attributed += ledger.execution_count;
    totalDelta += ledger.cumulative_delta;
  }

  summary.total_credited_usd = summary.total_credited_uc / 1_000_000;
  summary.avg_delta_score = summary.total_executions_attributed > 0
    ? totalDelta / summary.total_executions_attributed
    : 0;

  return summary;
}

