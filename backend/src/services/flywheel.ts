/**
 * Flywheel pulse — single-call aggregate of the complete flywheel state.
 *
 * Pulls from: funnel events, credit subsidy pool, skill index, perf stats,
 * fee/attribution ledgers, and agent profiles. Designed for the agent-org
 * monitoring loop (aiko) and the CLI `unbrowse flywheel` command.
 *
 * All monetary values in micro-cents (µ¢, 1 unit = $0.000001).
 */

import type { Env } from "../types.js";
import { getFunnelSummary } from "./funnel.js";
import { getPoolStatus, type CreditBalance } from "./credits.js";
import { getPerf } from "./perf.js";
import { getFeesSummary } from "./fees.js";
import { getAttributionSummary } from "./attribution.js";
import { skillsKV, statsKV } from "./kv.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FlywheelPulse {
  funnel: {
    installs_7d: number;
    registrations_7d: number;
    first_resolve_7d: number;
    repeat_users_7d: number;
    installs_30d: number;
    registrations_30d: number;
    first_resolve_30d: number;
    repeat_users_30d: number;
  };
  credits: {
    pool_remaining_uc: number;
    pool_total_granted_uc: number;
    agents_subsidized: number;
    agents_self_sustaining: number;
    avg_time_to_self_sustaining_hours: number;
  };
  index: {
    total_endpoints: number;
    total_domains: number;
    new_endpoints_7d: number;
    marketplace_hit_rate: number;
  };
  economics: {
    total_revenue_uc: number;
    total_earned_by_agents_uc: number;
    revenue_per_install_uc: number;
    ltv_per_agent_uc: number;
  };
  conversion: {
    install_to_register: number;
    register_to_first_resolve: number;
    first_resolve_to_repeat: number;
    overall_activation: number;
  };
  timestamp: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeRate(num: number, den: number): number {
  return den > 0 ? Math.round((num / den) * 10_000) / 10_000 : 0;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function getFlywheelPulse(env: Env): Promise<FlywheelPulse> {
  // Fire all data fetches in parallel
  const [funnel7d, funnel30d, pool, perf, feeSummary, attribution, skillEntries, creditEntries] =
    await Promise.all([
      getFunnelSummary(env, 7),
      getFunnelSummary(env, 30),
      getPoolStatus(env),
      getPerf(env),
      getFeesSummary(env),
      getAttributionSummary(env),
      skillsKV(env).listWithValues("skill:"),
      statsKV(env).listWithValues("credits:agent:"),
    ]);

  // ── Funnel ────────────────────────────────────────────────────────────────
  const funnel = {
    installs_7d: funnel7d.totals.installs,
    registrations_7d: funnel7d.totals.registrations,
    first_resolve_7d: funnel7d.totals.first_resolve_succeeded,
    repeat_users_7d: funnel7d.totals.repeat_success,
    installs_30d: funnel30d.totals.installs,
    registrations_30d: funnel30d.totals.registrations,
    first_resolve_30d: funnel30d.totals.first_resolve_succeeded,
    repeat_users_30d: funnel30d.totals.repeat_success,
  };

  // ── Credits ───────────────────────────────────────────────────────────────
  const balances: CreditBalance[] = creditEntries.flatMap((entry) => {
    try { return [JSON.parse(entry.value) as CreditBalance]; } catch { return []; }
  });
  const selfSustaining = balances.filter((b) => b.is_self_sustaining);

  // Estimate avg time to self-sustaining from created_at → updated_at for
  // agents that have reached self-sustaining status.
  let avgTimeToSelfSustainingHours = 0;
  if (selfSustaining.length > 0) {
    let totalMs = 0;
    let samples = 0;
    for (const b of selfSustaining) {
      const created = Date.parse(b.created_at);
      const updated = Date.parse(b.updated_at);
      if (Number.isFinite(created) && Number.isFinite(updated) && updated > created) {
        totalMs += updated - created;
        samples++;
      }
    }
    if (samples > 0) {
      avgTimeToSelfSustainingHours = Math.round((totalMs / samples) / 3_600_000 * 10) / 10;
    }
  }

  const credits = {
    pool_remaining_uc: pool?.remaining_uc ?? 0,
    pool_total_granted_uc: pool?.total_granted_uc ?? 0,
    agents_subsidized: pool?.grants_count ?? 0,
    agents_self_sustaining: selfSustaining.length,
    avg_time_to_self_sustaining_hours: avgTimeToSelfSustainingHours,
  };

  // ── Index ─────────────────────────────────────────────────────────────────
  const domainSet = new Set<string>();
  let totalEndpoints = 0;
  let newEndpoints7d = 0;
  const sevenDaysAgo = Date.now() - 7 * 86_400_000;

  for (const { value } of skillEntries) {
    try {
      const skill = JSON.parse(value) as {
        lifecycle?: string;
        domain?: string;
        endpoints?: Array<{ created_at?: string }>;
        created_at?: string;
      };
      if (skill.lifecycle === "deprecated" || skill.lifecycle === "disabled") continue;
      const eps = skill.endpoints ?? [];
      totalEndpoints += eps.length;
      if (skill.domain) domainSet.add(skill.domain);

      // Count endpoints added in the last 7 days.
      // Fall back to skill created_at if per-endpoint timestamps are missing.
      for (const ep of eps) {
        const ts = ep.created_at ?? skill.created_at;
        if (ts) {
          const ms = Date.parse(ts);
          if (Number.isFinite(ms) && ms >= sevenDaysAgo) newEndpoints7d++;
        }
      }
    } catch { /* skip malformed */ }
  }

  const totalResolves = perf.total_resolves || 1;
  const hitRate = safeRate(perf.marketplace_hits + perf.cache_hits, totalResolves);

  const index = {
    total_endpoints: totalEndpoints,
    total_domains: domainSet.size,
    new_endpoints_7d: newEndpoints7d,
    marketplace_hit_rate: hitRate,
  };

  // ── Economics ─────────────────────────────────────────────────────────────
  const totalRevenueUc = feeSummary.total_charged_uc;
  const totalEarnedByAgentsUc = attribution.total_credited_uc;
  const totalInstalls = Math.max(funnel30d.totals.installs, 1);
  const totalAgents = Math.max(balances.length, 1);

  const economics = {
    total_revenue_uc: totalRevenueUc,
    total_earned_by_agents_uc: totalEarnedByAgentsUc,
    revenue_per_install_uc: Math.round(totalRevenueUc / totalInstalls),
    ltv_per_agent_uc: Math.round(totalEarnedByAgentsUc / totalAgents),
  };

  // ── Conversion ────────────────────────────────────────────────────────────
  // Use 7d numbers for conversion rates (more actionable than 30d).
  const conversion = {
    install_to_register: safeRate(funnel.registrations_7d, funnel.installs_7d),
    register_to_first_resolve: safeRate(funnel.first_resolve_7d, funnel.registrations_7d),
    first_resolve_to_repeat: safeRate(funnel.repeat_users_7d, funnel.first_resolve_7d),
    overall_activation: safeRate(funnel.first_resolve_7d, funnel.installs_7d),
  };

  return {
    funnel,
    credits,
    index,
    economics,
    conversion,
    timestamp: new Date().toISOString(),
  };
}
