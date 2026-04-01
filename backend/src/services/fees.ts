/**
 * Tier 3 per-query graph fee ledger — issue #97
 *
 * Tracks cumulative graph API credit consumption per agent so the platform
 * can attribute search/routing costs, enforce quotas, and eventually charge
 * callers for EmergentDB graph lookups.
 *
 * Fee schedule (USD micro-cents, i.e. 1 unit = $0.000001):
 *   search    — vector/intent search:         100 µ¢  ($0.000100)
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

// ─── Constants ────────────────────────────────────────────────────────────────

/** Micro-cents charged per graph operation (1 unit = $0.000001). */
export const GRAPH_OPERATION_COST_UC: Record<GraphOperation, number> = {
  search:   100,
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

function feeLedgerKey(agentId: string): string {
  return `fees:agent:${agentId}`;
}

const FEES_INDEX_KEY = "fees:agents:index";

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
  const key = feeLedgerKey(agentId);
  const now = new Date().toISOString();
  const cost = GRAPH_OPERATION_COST_UC[operation];

  const raw = await kv.get(key) as string | null;
  let ledger: AgentFeeLedger;

  if (raw) {
    try { ledger = JSON.parse(raw) as AgentFeeLedger; } catch {
      ledger = emptyLedger(agentId, now);
    }
  } else {
    ledger = emptyLedger(agentId, now);
    // First charge: add to index so getFeesSummary can enumerate
    await addAgentToIndex(kv, agentId);
  }

  ledger.total_charged_uc += cost;
  ledger.by_operation[operation] = (ledger.by_operation[operation] ?? 0) + cost;
  ledger.event_count++;
  ledger.last_charged_at = now;

  await kv.put(key, JSON.stringify(ledger));
  return ledger;
}

/** Read the fee ledger for a specific agent. Returns null if no fees recorded. */
export async function getAgentFeeLedger(
  env: Env,
  agentId: string,
): Promise<AgentFeeLedger | null> {
  const raw = await statsKV(env).get(feeLedgerKey(agentId)) as string | null;
  if (!raw) return null;
  try { return JSON.parse(raw) as AgentFeeLedger; } catch { return null; }
}

/** Aggregate fee summary across all agents. */
export async function getFeesSummary(env: Env): Promise<FeeSummary> {
  const kv = statsKV(env);
  const indexRaw = await kv.get(FEES_INDEX_KEY) as string | null;
  const agentIds: string[] = indexRaw ? (JSON.parse(indexRaw) as string[]) : [];

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

function emptyLedger(agentId: string, now: string): AgentFeeLedger {
  return {
    agent_id: agentId,
    total_charged_uc: 0,
    by_operation: { search: 0, chain: 0, predict: 0, session: 0, negative: 0 },
    event_count: 0,
    first_charged_at: now,
    last_charged_at: now,
  };
}

async function addAgentToIndex(
  kv: ReturnType<typeof statsKV>,
  agentId: string,
): Promise<void> {
  const raw = await kv.get(FEES_INDEX_KEY) as string | null;
  const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  if (!ids.includes(agentId)) {
    ids.push(agentId);
    await kv.put(FEES_INDEX_KEY, JSON.stringify(ids));
  }
}

/**
 * Convert micro-cents to a human-readable dollar string.
 * e.g. 100 µ¢ → "$0.000100"
 */
export function ucToUsd(uc: number): string {
  return `$${(uc / 1_000_000).toFixed(6)}`;
}
