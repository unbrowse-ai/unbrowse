/**
 * Shadow earnings tracker — records what users *would* have earned if
 * x402 payments were enabled. Lightweight KV counters only.
 *
 * Used to show "projected earnings" on the frontend while payments are
 * feature-flagged off.
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ShadowEarningsLedger {
  /** Total projected revenue in micro-cents. */
  total_projected_uc: number;
  /** Breakdown: skill execute revenue vs search/graph fees. */
  skill_revenue_uc: number;
  search_fees_uc: number;
  /** Number of shadow events recorded. */
  event_count: number;
  first_event_at: string;
  last_event_at: string;
}

export interface ShadowEarningsSummary {
  /** Platform-wide projected totals. */
  total_projected_uc: number;
  total_projected_usd: number;
  skill_revenue_uc: number;
  skill_revenue_usd: number;
  search_fees_uc: number;
  search_fees_usd: number;
  total_events: number;
  unique_agents: number;
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

function agentShadowKey(agentId: string): string {
  return `shadow:agent:${agentId}`;
}

const SHADOW_GLOBAL_KEY = "shadow:global";
const SHADOW_INDEX_KEY = "shadow:agents:index";

// ─── Service functions ───────────────────────────────────────────────────────

function emptyLedger(now: string): ShadowEarningsLedger {
  return {
    total_projected_uc: 0,
    skill_revenue_uc: 0,
    search_fees_uc: 0,
    event_count: 0,
    first_event_at: now,
    last_event_at: now,
  };
}

/**
 * Record a shadow earning event — what would have been charged/earned.
 * Non-blocking, fire-and-forget safe.
 */
export async function recordShadowEarning(
  env: Env,
  params: {
    agent_id: string;
    amount_uc: number;
    type: "skill" | "search";
  },
): Promise<void> {
  const kv = statsKV(env);
  const now = new Date().toISOString();

  // Update agent ledger
  const agentKey = agentShadowKey(params.agent_id);
  const agentRaw = await kv.get(agentKey) as string | null;
  let agentLedger: ShadowEarningsLedger;
  if (agentRaw) {
    try { agentLedger = JSON.parse(agentRaw) as ShadowEarningsLedger; } catch {
      agentLedger = emptyLedger(now);
    }
  } else {
    agentLedger = emptyLedger(now);
    await addToIndex(kv, params.agent_id);
  }

  agentLedger.total_projected_uc += params.amount_uc;
  if (params.type === "skill") agentLedger.skill_revenue_uc += params.amount_uc;
  else agentLedger.search_fees_uc += params.amount_uc;
  agentLedger.event_count++;
  agentLedger.last_event_at = now;

  // Update global ledger
  const globalRaw = await kv.get(SHADOW_GLOBAL_KEY) as string | null;
  let globalLedger: ShadowEarningsLedger;
  if (globalRaw) {
    try { globalLedger = JSON.parse(globalRaw) as ShadowEarningsLedger; } catch {
      globalLedger = emptyLedger(now);
    }
  } else {
    globalLedger = emptyLedger(now);
  }

  globalLedger.total_projected_uc += params.amount_uc;
  if (params.type === "skill") globalLedger.skill_revenue_uc += params.amount_uc;
  else globalLedger.search_fees_uc += params.amount_uc;
  globalLedger.event_count++;
  globalLedger.last_event_at = now;

  await Promise.all([
    kv.put(agentKey, JSON.stringify(agentLedger)),
    kv.put(SHADOW_GLOBAL_KEY, JSON.stringify(globalLedger)),
  ]);
}

/** Get shadow earnings for a specific agent. */
export async function getAgentShadowEarnings(
  env: Env,
  agentId: string,
): Promise<ShadowEarningsLedger | null> {
  const raw = await statsKV(env).get(agentShadowKey(agentId)) as string | null;
  if (!raw) return null;
  try { return JSON.parse(raw) as ShadowEarningsLedger; } catch { return null; }
}

/** Get platform-wide shadow earnings summary. */
export async function getShadowEarningsSummary(
  env: Env,
): Promise<ShadowEarningsSummary> {
  const kv = statsKV(env);
  const [globalRaw, indexRaw] = await Promise.all([
    kv.get(SHADOW_GLOBAL_KEY) as Promise<string | null>,
    kv.get(SHADOW_INDEX_KEY) as Promise<string | null>,
  ]);

  const agentIds: string[] = indexRaw ? (JSON.parse(indexRaw) as string[]) : [];
  const global: ShadowEarningsLedger | null = globalRaw
    ? (() => { try { return JSON.parse(globalRaw) as ShadowEarningsLedger; } catch { return null; } })()
    : null;

  return {
    total_projected_uc: global?.total_projected_uc ?? 0,
    total_projected_usd: (global?.total_projected_uc ?? 0) / 1_000_000,
    skill_revenue_uc: global?.skill_revenue_uc ?? 0,
    skill_revenue_usd: (global?.skill_revenue_uc ?? 0) / 1_000_000,
    search_fees_uc: global?.search_fees_uc ?? 0,
    search_fees_usd: (global?.search_fees_uc ?? 0) / 1_000_000,
    total_events: global?.event_count ?? 0,
    unique_agents: agentIds.length,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function addToIndex(
  kv: ReturnType<typeof statsKV>,
  agentId: string,
): Promise<void> {
  const raw = await kv.get(SHADOW_INDEX_KEY) as string | null;
  const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  if (!ids.includes(agentId)) {
    ids.push(agentId);
    await kv.put(SHADOW_INDEX_KEY, JSON.stringify(ids));
  }
}
