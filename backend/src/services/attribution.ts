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

function ledgerKey(indexerId: string): string {
  return `attribution:indexer:${indexerId}`;
}

const ATTRIBUTION_INDEX_KEY = "attribution:indexers:index";

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
  const key = ledgerKey(event.indexer_id);
  const raw = await kv.get(key) as string | null;

  let ledger: IndexerAttributionLedger;
  if (raw) {
    try { ledger = JSON.parse(raw) as IndexerAttributionLedger; } catch {
      ledger = emptyLedger(event.indexer_id, now);
    }
  } else {
    ledger = emptyLedger(event.indexer_id, now);
    await addIndexerToIndex(kv, event.indexer_id);
  }

  ledger.total_credited_uc += fee_allocated_uc;
  ledger.total_credited_usd = ledger.total_credited_uc / 1_000_000;
  ledger.execution_count++;
  ledger.cumulative_delta += delta_score;
  ledger.avg_delta = ledger.cumulative_delta / ledger.execution_count;
  ledger.last_attributed_at = now;

  await kv.put(key, JSON.stringify(ledger));

  // Credit earnings to the indexer's credit balance (best-effort)
  if (env.CREDITS_ENABLED === "1") {
    try {
      await creditEarnings(env, event.indexer_id, fee_allocated_uc);
    } catch {
      // Credit ledger may not exist yet — don't fail attribution
    }
  }

  return fullEvent;
}

/** Read the attribution ledger for a specific indexer. */
export async function getIndexerLedger(
  env: Env,
  indexerId: string,
): Promise<IndexerAttributionLedger | null> {
  const raw = await statsKV(env).get(ledgerKey(indexerId)) as string | null;
  if (!raw) return null;
  try { return JSON.parse(raw) as IndexerAttributionLedger; } catch { return null; }
}

/** Aggregate attribution summary across all indexed routes. */
export async function getAttributionSummary(env: Env): Promise<AttributionSummary> {
  const kv = statsKV(env);
  const indexRaw = await kv.get(ATTRIBUTION_INDEX_KEY) as string | null;
  const indexerIds: string[] = indexRaw ? (JSON.parse(indexRaw) as string[]) : [];

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyLedger(indexerId: string, now: string): IndexerAttributionLedger {
  return {
    indexer_id: indexerId,
    total_credited_uc: 0,
    total_credited_usd: 0,
    execution_count: 0,
    cumulative_delta: 0,
    avg_delta: 0,
    first_attributed_at: now,
    last_attributed_at: now,
  };
}

async function addIndexerToIndex(
  kv: ReturnType<typeof statsKV>,
  indexerId: string,
): Promise<void> {
  const raw = await kv.get(ATTRIBUTION_INDEX_KEY) as string | null;
  const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  if (!ids.includes(indexerId)) {
    ids.push(indexerId);
    await kv.put(ATTRIBUTION_INDEX_KEY, JSON.stringify(ids));
  }
}
