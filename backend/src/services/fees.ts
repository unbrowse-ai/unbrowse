/**
 * Tier 3 per-query graph fee ledger — issue #97
 *
 * Tracks cumulative graph API credit consumption per agent so the platform
 * can attribute search/routing costs, enforce quotas, and eventually charge
 * callers for EmergentDB graph lookups.
 *
 * Fee schedule (USD micro-cents, i.e. 1 unit = $0.000001):
 *   search    — vector/intent search:        1000 µ¢  ($0.001000)
 *   chain     — DAG prerequisite resolution:  200 µ¢  ($0.000200)
 *   predict   — co-occurrence prediction:     100 µ¢  ($0.000100)
 *   session   — session action recording:      50 µ¢  ($0.000050)
 *   negative  — negative example recording:    50 µ¢  ($0.000050)
 *
 * All values are stored in whole micro-cents (integer) to avoid
 * floating-point drift across increments.
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";
import { appendEvent, readEvents, listPartitions } from "./event-ledger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Micro-cents charged per graph operation (1 unit = $0.000001). */
export const GRAPH_OPERATION_COST_UC: Record<GraphOperation, number> = {
  search:  1000,
  chain:    200,
  predict:  100,
  session:   50,
  negative:  50,
};

export type GraphOperation = "search" | "chain" | "predict" | "session" | "negative";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentFeeLedger {
  agent_id: string;
  /** Total micro-cents charged across all graph operations. */
  total_charged_uc: number;
  /** Breakdown by operation type. */
  by_operation: Record<GraphOperation, number>;
  /** Number of individual fee events recorded. */
  event_count: number;
  first_charged_at: string;
  last_charged_at: string;
}

export interface FeeSummary {
  total_agents_charged: number;
  total_charged_uc: number;
  /** Total in USD (divide by 1_000_000). */
  total_charged_usd: number;
  by_operation: Record<GraphOperation, number>;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

// Append-only event rows; each charge is a distinct key (no lost update on the
// CAS-free KV). The per-agent ledger is a PROJECTION (fold) over these rows —
// never a mutated accumulator blob. Mirrors route-ledger / attribution.
const EVENT_PREFIX = "fees:event:"; // fees:event:<agent>:<uuid>

export interface FeeEvent {
  agent_id: string;
  operation: GraphOperation;
  cost_uc: number;
  timestamp: string;
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Record a single graph operation fee against an agent.
 * Creates the ledger entry on first call, increments thereafter.
 */
export async function recordGraphFee(
  env: Env,
  agentId: string,
  operation: GraphOperation,
): Promise<AgentFeeLedger> {
  const kv = statsKV(env);
  const cost = GRAPH_OPERATION_COST_UC[operation];
  const ev: FeeEvent = { agent_id: agentId, operation, cost_uc: cost, timestamp: new Date().toISOString() };
  // Distinct key per charge (uuid) → concurrent charges never overwrite each other.
  await appendEvent(kv, EVENT_PREFIX, agentId, crypto.randomUUID(), ev);
  return (await getAgentFeeLedger(env, agentId))!; // projected ledger (non-null: just appended)
}

/** Read the fee ledger for a specific agent — a PROJECTION (fold) over the
 *  append-only event rows. Returns null if no fees recorded. */
export async function getAgentFeeLedger(
  env: Env,
  agentId: string,
): Promise<AgentFeeLedger | null> {
  const events = await readEvents<FeeEvent>(statsKV(env), EVENT_PREFIX, agentId);
  if (events.length === 0) return null;
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const by_operation: Record<GraphOperation, number> = { search: 0, chain: 0, predict: 0, session: 0, negative: 0 };
  let total_charged_uc = 0;
  for (const e of events) {
    total_charged_uc += e.cost_uc;
    by_operation[e.operation] = (by_operation[e.operation] ?? 0) + e.cost_uc;
  }
  return {
    agent_id: agentId,
    total_charged_uc,
    by_operation,
    event_count: events.length,
    first_charged_at: events[0].timestamp,
    last_charged_at: events[events.length - 1].timestamp,
  };
}

/** Aggregate fee summary across all agents. */
export async function getFeesSummary(env: Env): Promise<FeeSummary> {
  const agentIds = await listAgentIds(env);

  const summary: FeeSummary = {
    total_agents_charged: agentIds.length,
    total_charged_uc: 0,
    total_charged_usd: 0,
    by_operation: { search: 0, chain: 0, predict: 0, session: 0, negative: 0 },
  };

  if (agentIds.length === 0) return summary;

  const ledgers = await Promise.all(
    agentIds.map((id) => getAgentFeeLedger(env, id)),
  );

  for (const ledger of ledgers) {
    if (!ledger) continue;
    summary.total_charged_uc += ledger.total_charged_uc;
    for (const op of Object.keys(ledger.by_operation) as GraphOperation[]) {
      summary.by_operation[op] = (summary.by_operation[op] ?? 0) + ledger.by_operation[op];
    }
  }

  summary.total_charged_usd = summary.total_charged_uc / 1_000_000;
  return summary;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** List every agent id with fee events (for summaries) — derived from the event
 *  keyspace, no separate (race-prone) index blob. */
async function listAgentIds(env: Env): Promise<string[]> {
  return listPartitions<FeeEvent>(statsKV(env), EVENT_PREFIX, (e) => e.agent_id);
}

/**
 * Convert micro-cents to a human-readable dollar string.
 * e.g. 100 µ¢ → "$0.000100"
 */
export function ucToUsd(uc: number): string {
  return `$${(uc / 1_000_000).toFixed(6)}`;
}
