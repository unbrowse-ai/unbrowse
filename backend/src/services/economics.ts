import type { AgentProfile, Env } from "../types.js";
import { getIndexerLedger } from "./attribution.js";
import type { IndexerAttributionLedger } from "./attribution.js";
import { getAgentFeeLedger } from "./fees.js";
import { getAgentPerfLedger } from "./perf.js";
import type { AgentPerfLedger } from "./perf.js";
import { statsKV } from "./kv.js";
import { getOrSetHttpCache } from "./http-cache.js";
import { getConsumerTransactions, getCreatorTransactions, type Transaction } from "./transactions.js";
import type { CreatorLedger } from "./transactions.js";

export interface DashboardTransaction {
  transaction_id: string;
  direction: "spent" | "earned";
  skill_id: string;
  endpoint_id?: string;
  amount_usd: number;
  platform_fee_usd: number;
  counterparty_agent_id: string;
  status: string;
  created_at: string;
}

/** A per-route contribution: a route this agent published, aggregated over every
 *  paid reuse by others. reuse_count + earned_usd are real (counted from creator
 *  payout transactions); "saved for others" is deliberately omitted — it is not
 *  attributable per-route without new storage, and inventing it would break the
 *  honest-metric rule. */
export interface DashboardContribution {
  skill_id: string;
  endpoint_id?: string;
  reuse_count: number;
  earned_usd: number;
  last_used_at: string;
}

export interface DashboardPayload {
  profile: AgentProfile;
  economics: {
    spent_usd: number;
    creator_earned_usd: number;
    attribution_earned_usd: number;
    total_earned_usd: number;
    platform_fees_paid_usd: number;
    graph_fees_paid_usd: number;
    skill_spend_usd: number;
    paid_execution_usd: number;
  };
  savings: {
    baseline_time_ms: number | null;
    actual_time_ms: number | null;
    time_saved_ms: number | null;
    time_saved_hours: number | null;
    speedup_ratio: number | null;
    baseline_cost_uc: number | null;
    baseline_cost_usd: number | null;
    actual_cost_uc: number | null;
    actual_cost_usd: number | null;
    cost_saved_uc: number | null;
    cost_saved_usd: number | null;
  };
  activity: {
    total_executions: number;
    skills_discovered: number;
    total_feedback_given: number;
  };
  rank: {
    contribution_score: number;
    position: number | null;
  };
  recent_transactions: DashboardTransaction[];
  contributions: DashboardContribution[];
}

export interface LeaderboardEntry {
  agent_id: string;
  name: string;
  wallet_address?: string;
  created_at: string;
  contribution_score: number;
  creator_earned_usd: number;
  attribution_earned_usd: number;
  total_earned_usd: number;
  executions: number;
  skills_discovered: number;
  time_saved_hours: number | null;
  cost_saved_usd: number | null;
  score_components: {
    earned_norm: number;
    execution_norm: number;
    discovery_norm: number;
  };
}

interface LeaderboardState {
  profiles: AgentProfile[];
  creatorLedgers: Map<string, CreatorLedger>;
  attributionLedgers: Map<string, IndexerAttributionLedger>;
  perfLedgers: Map<string, AgentPerfLedger>;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function toUsdFromUc(value: number): number {
  return round6(value / 1_000_000);
}

function profileActivityCount(profile: AgentProfile, timeSavedMs: number | null, costSavedUc: number | null): number {
  return (
    profile.total_executions +
    profile.skills_discovered.length +
    (timeSavedMs != null && timeSavedMs > 0 ? 1 : 0) +
    (costSavedUc != null && costSavedUc > 0 ? 1 : 0)
  );
}

async function loadProfiles(env: Env): Promise<AgentProfile[]> {
  const entries = await statsKV(env).listWithValues("agent:");
  return entries
    .map((entry) => {
      try { return JSON.parse(entry.value) as AgentProfile; } catch { return null; }
    })
    .filter((entry): entry is AgentProfile => !!entry);
}

function parseValueMap<T>(entries: Array<{ name: string; value: string }>, parse: (raw: string) => T): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of entries) {
    try {
      map.set(entry.name, parse(entry.value));
    } catch {
      continue;
    }
  }
  return map;
}

type RawEntries = Array<{ name: string; value: string }>;

// The 4 full KV scans below are the dashboard + leaderboard hot path (O(all agents +
// all txns + all perf) per call). Cache the RAW scan (JSON-serializable) for 30s so
// every dashboard/leaderboard read in that window shares ONE scan instead of each
// re-scanning. (Durable fix is incremental per-agent rollups; this is the read-cache.)
async function loadLeaderboardRaw(env: Env): Promise<{ profilesRaw: RawEntries; creatorRaw: RawEntries; attributionRaw: RawEntries; perfRaw: RawEntries }> {
  return getOrSetHttpCache(env, "leaderboard:raw", 30, async () => {
    const kv = statsKV(env);
    const [profilesRaw, creatorRaw, attributionRaw, perfRaw] = await Promise.all([
      kv.listWithValues("agent:"),
      kv.listWithValues("tx:creator:"),
      kv.listWithValues("attribution:indexer:"),
      kv.listWithValues("perf:agent:"),
    ]);
    return { profilesRaw, creatorRaw, attributionRaw, perfRaw };
  });
}

async function loadLeaderboardState(env: Env): Promise<LeaderboardState> {
  const { profilesRaw, creatorRaw, attributionRaw, perfRaw } = await loadLeaderboardRaw(env);

  return {
    profiles: profilesRaw
      .map((entry) => {
        try { return JSON.parse(entry.value) as AgentProfile; } catch { return null; }
      })
      .filter((entry): entry is AgentProfile => !!entry),
    creatorLedgers: parseValueMap(creatorRaw, (raw) => JSON.parse(raw) as CreatorLedger),
    attributionLedgers: parseValueMap(attributionRaw, (raw) => JSON.parse(raw) as IndexerAttributionLedger),
    perfLedgers: parseValueMap(perfRaw, (raw) => JSON.parse(raw) as AgentPerfLedger),
  };
}

function normalizeDashboardTransaction(
  tx: Transaction,
  direction: "spent" | "earned",
): DashboardTransaction {
  const amountUsd = direction === "spent"
    ? round6(tx.price_uc / 1_000_000)
    : round6(tx.creator_payout_uc / 1_000_000);
  const platformFeeUsd = round6(tx.platform_fee_uc / 1_000_000);
  return {
    transaction_id: tx.transaction_id,
    direction,
    skill_id: tx.skill_id,
    endpoint_id: tx.endpoint_id,
    amount_usd: amountUsd,
    platform_fee_usd: platformFeeUsd,
    counterparty_agent_id: direction === "spent" ? tx.creator_id : tx.consumer_id,
    status: tx.status,
    created_at: tx.created_at,
  };
}

function buildAgentEntry(profile: AgentProfile, state: LeaderboardState): LeaderboardEntry | null {
  const creatorEarnedUsd = state.creatorLedgers.get(`tx:creator:${profile.agent_id}`)?.total_earned_usd ?? 0;
  const attributionEarnedUsd = state.attributionLedgers.get(`attribution:indexer:${profile.agent_id}`)?.total_credited_usd ?? 0;
  const totalEarnedUsd = round6(creatorEarnedUsd + attributionEarnedUsd);
  const perf = state.perfLedgers.get(`perf:agent:${profile.agent_id}`);
  const timeSavedMs = perf?.time_saved_events ? perf.total_time_saved_ms : null;
  const costSavedUc = perf?.cost_saved_events ? perf.total_cost_saved_uc : null;

  if (totalEarnedUsd <= 0 && profileActivityCount(profile, timeSavedMs, costSavedUc) <= 0) {
    return null;
  }

  return {
    agent_id: profile.agent_id,
    name: profile.name,
    wallet_address: profile.wallet_address,
    created_at: profile.created_at,
    contribution_score: 0,
    creator_earned_usd: creatorEarnedUsd,
    attribution_earned_usd: attributionEarnedUsd,
    total_earned_usd: totalEarnedUsd,
    executions: profile.total_executions,
    skills_discovered: profile.skills_discovered.length,
    time_saved_hours: timeSavedMs != null ? round4(timeSavedMs / 3_600_000) : null,
    cost_saved_usd: costSavedUc != null ? toUsdFromUc(costSavedUc) : null,
    score_components: {
      earned_norm: 0,
      execution_norm: 0,
      discovery_norm: 0,
    },
  };
}

function scoreLeaderboardEntries(rawEntries: LeaderboardEntry[], limit: number): LeaderboardEntry[] {
  if (rawEntries.length === 0) return [];

  const maxEarned = Math.max(0, ...rawEntries.map((entry) => entry.total_earned_usd));
  const maxExecutions = Math.max(0, ...rawEntries.map((entry) => entry.executions));
  const maxDiscoveries = Math.max(0, ...rawEntries.map((entry) => entry.skills_discovered));

  const scored = rawEntries.map((entry) => {
    const earnedNorm = maxEarned > 0 ? entry.total_earned_usd / maxEarned : 0;
    const executionNorm = maxExecutions > 0 ? entry.executions / maxExecutions : 0;
    const discoveryNorm = maxDiscoveries > 0 ? entry.skills_discovered / maxDiscoveries : 0;
    return {
      ...entry,
      contribution_score: round4(0.5 * earnedNorm + 0.3 * executionNorm + 0.2 * discoveryNorm),
      score_components: {
        earned_norm: round4(earnedNorm),
        execution_norm: round4(executionNorm),
        discovery_norm: round4(discoveryNorm),
      },
    };
  });

  return scored
    .sort((a, b) =>
      b.contribution_score - a.contribution_score ||
      b.total_earned_usd - a.total_earned_usd ||
      b.executions - a.executions ||
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, limit);
}

export async function buildLeaderboard(env: Env, limit = 50): Promise<LeaderboardEntry[]> {
  const state = await loadLeaderboardState(env);
  const rawEntries = state.profiles
    .map((profile) => buildAgentEntry(profile, state))
    .filter((entry): entry is LeaderboardEntry => !!entry);
  return scoreLeaderboardEntries(rawEntries, limit);
}

export async function buildDashboard(env: Env, agentId: string): Promise<DashboardPayload | null> {
  const leaderboardState = await loadLeaderboardState(env);
  const profile = leaderboardState.profiles.find((candidate) => candidate.agent_id === agentId) ?? null;
  if (!profile) return null;

  const [consumer, creator, feeLedger, attribution, perf, leaderboard] = await Promise.all([
    getConsumerTransactions(env, agentId),
    getCreatorTransactions(env, agentId),
    getAgentFeeLedger(env, agentId),
    getIndexerLedger(env, agentId),
    getAgentPerfLedger(env, agentId),
    Promise.resolve(scoreLeaderboardEntries(
      leaderboardState.profiles
        .map((candidate) => buildAgentEntry(candidate, leaderboardState))
        .filter((entry): entry is LeaderboardEntry => !!entry),
      200,
    )),
  ]);

  const graphFeesUc = feeLedger?.total_charged_uc ?? 0;
  const skillSpendUc = consumer.ledger?.total_spent_uc ?? 0;
  const consumerPlatformFeesUc = consumer.transactions.reduce((sum, tx) => sum + tx.platform_fee_uc, 0);
  const platformFeesPaidUc = graphFeesUc + consumerPlatformFeesUc;
  const creatorEarnedUsd = creator.ledger?.total_earned_usd ?? 0;
  const attributionEarnedUsd = attribution?.total_credited_usd ?? 0;
  const totalEarnedUsd = round6(creatorEarnedUsd + attributionEarnedUsd);
  const recentTransactions = [
    ...consumer.transactions.map((tx) => normalizeDashboardTransaction(tx, "spent")),
    ...creator.transactions.map((tx) => normalizeDashboardTransaction(tx, "earned")),
  ]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 8);

  const contributions = aggregateContributions(
    creator.transactions.map((tx) => normalizeDashboardTransaction(tx, "earned")),
  );

  const rankIndex = leaderboard.findIndex((entry) => entry.agent_id === agentId);
  const baselineTimeMs = perf && perf.total_baseline_ms > 0 ? perf.total_baseline_ms : null;
  const actualTimeMs = perf && perf.total_actual_ms > 0 ? perf.total_actual_ms : null;
  const baselineCostUc = perf && perf.total_baseline_cost_uc > 0 ? perf.total_baseline_cost_uc : null;
  const actualCostUc = perf && perf.total_actual_cost_uc > 0 ? perf.total_actual_cost_uc : null;

  return {
    profile,
    economics: {
      spent_usd: round6((skillSpendUc + graphFeesUc) / 1_000_000),
      creator_earned_usd: creatorEarnedUsd,
      attribution_earned_usd: attributionEarnedUsd,
      total_earned_usd: totalEarnedUsd,
      platform_fees_paid_usd: toUsdFromUc(platformFeesPaidUc),
      graph_fees_paid_usd: toUsdFromUc(graphFeesUc),
      skill_spend_usd: toUsdFromUc(skillSpendUc),
      paid_execution_usd: toUsdFromUc(perf?.total_paid_execution_uc ?? 0),
    },
    savings: {
      baseline_time_ms: baselineTimeMs,
      actual_time_ms: actualTimeMs,
      time_saved_ms: perf?.time_saved_events ? perf.total_time_saved_ms : null,
      time_saved_hours: perf?.time_saved_events ? round4(perf.total_time_saved_ms / 3_600_000) : null,
      speedup_ratio:
        baselineTimeMs != null && actualTimeMs != null && actualTimeMs > 0
          ? round4(baselineTimeMs / actualTimeMs)
          : null,
      baseline_cost_uc: baselineCostUc,
      baseline_cost_usd: baselineCostUc != null ? toUsdFromUc(baselineCostUc) : null,
      actual_cost_uc: actualCostUc,
      actual_cost_usd: actualCostUc != null ? toUsdFromUc(actualCostUc) : null,
      cost_saved_uc: perf?.cost_saved_events ? perf.total_cost_saved_uc : null,
      cost_saved_usd: perf?.cost_saved_events ? toUsdFromUc(perf.total_cost_saved_uc) : null,
    },
    activity: {
      total_executions: profile.total_executions,
      skills_discovered: profile.skills_discovered.length,
      total_feedback_given: profile.total_feedback_given,
    },
    rank: {
      contribution_score: rankIndex >= 0 ? leaderboard[rankIndex].contribution_score : 0,
      position: rankIndex >= 0 ? rankIndex + 1 : null,
    },
    recent_transactions: recentTransactions,
    contributions,
  };
}

/** Group an agent's creator payout transactions by route (skill_id) into a per-route
 *  contributions ledger: how many times others paid to reuse it, and total earned.
 *  Top 20 by earnings. All values counted from real transactions — nothing invented. */
export function aggregateContributions(earnedTransactions: DashboardTransaction[]): DashboardContribution[] {
  const bySkill = new Map<string, DashboardContribution>();
  for (const tx of earnedTransactions) {
    const existing = bySkill.get(tx.skill_id);
    if (existing) {
      existing.reuse_count += 1;
      existing.earned_usd = round6(existing.earned_usd + tx.amount_usd);
      if (new Date(tx.created_at).getTime() > new Date(existing.last_used_at).getTime()) {
        existing.last_used_at = tx.created_at;
        if (tx.endpoint_id) existing.endpoint_id = tx.endpoint_id;
      }
    } else {
      bySkill.set(tx.skill_id, {
        skill_id: tx.skill_id,
        endpoint_id: tx.endpoint_id,
        reuse_count: 1,
        earned_usd: round6(tx.amount_usd),
        last_used_at: tx.created_at,
      });
    }
  }
  return [...bySkill.values()]
    .sort((a, b) => b.earned_usd - a.earned_usd || b.reuse_count - a.reuse_count)
    .slice(0, 20);
}
