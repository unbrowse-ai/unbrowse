import type { AgentProfile, Env, SkillManifest } from "../types.js";
import { getAcquisitionSummary } from "./acquisition.js";
import { getEngagement, getRetention } from "./analytics.js";
import { getChurnCurve } from "./funnel.js";
import { loadUsagePings } from "./issues.js";
import { skillsKV, statsKV } from "./kv.js";
import { getUsageMetrics } from "./metrics.js";
import { getCloudflareWorkerUsage } from "./cloudflare-usage.js";

const DAY_MS = 86_400_000;

const SAFE_USAGE_VERBS = new Set([
  "act", "auth", "auth-capture", "back", "capture", "click", "close", "cookies", "create",
  "diagnose", "eval", "execute", "explain", "feedback", "fetch", "fill", "forward", "get", "go",
  "inspect", "login", "markdown", "mcp", "press", "read", "resolve", "run", "screenshot", "scroll",
  "search", "select", "setup", "skill", "skills", "snap", "status", "submit", "sync", "text", "type",
  "upgrade",
]);
const SAFE_ICP_VALUES = new Set(["openclaw-normie", "mcp-host", "agent-builder"]);

function safeCategoricalRows(
  rows: Array<{ key: string; count: number }> | undefined,
  allowlist: Set<string>,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows ?? []) {
    const key = allowlist.has(row.key) ? row.key : "other";
    counts.set(key, (counts.get(key) ?? 0) + Math.max(0, row.count));
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function normalizeProductReportDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(180, Math.trunc(days)));
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0;
}

function activityDates(profile: AgentProfile): string[] {
  return Array.from(new Set((profile.activity_dates ?? []).filter(Boolean))).sort();
}

function lastActiveDate(profile: AgentProfile): string | null {
  const dates = activityDates(profile);
  return dates.at(-1) ?? profile.last_active_at?.slice(0, 10) ?? null;
}

async function loadProfiles(env: Env): Promise<AgentProfile[]> {
  const entries = await statsKV(env).listWithValues("agent:");
  return entries.flatMap(({ value }) => {
    try {
      return [JSON.parse(value) as AgentProfile];
    } catch {
      return [];
    }
  });
}

async function loadSkills(env: Env): Promise<SkillManifest[]> {
  const entries = await skillsKV(env).listWithValues("skill:");
  return entries.flatMap(({ value }) => {
    try {
      return [JSON.parse(value) as SkillManifest];
    } catch {
      return [];
    }
  }).filter((skill) => skill.lifecycle !== "deprecated" && skill.lifecycle !== "disabled");
}

function summarizeRetention(cohorts: Awaited<ReturnType<typeof getRetention>>) {
  const checkpoints = [1, 3, 7, 14, 30];
  return Object.fromEntries(checkpoints.map((checkpoint) => {
    const key = `d${checkpoint}`;
    const eligible = cohorts.filter((cohort) => typeof cohort.retention[key] === "number");
    const cohortSize = eligible.reduce((sum, cohort) => sum + cohort.cohort_size, 0);
    const retainedEstimate = eligible.reduce(
      (sum, cohort) => sum + cohort.cohort_size * (cohort.retention[key] ?? 0),
      0,
    );
    return [key, {
      rate: ratio(retainedEstimate, cohortSize),
      eligible_users: cohortSize,
      cohorts: eligible.length,
    }];
  }));
}

function creatorIds(skills: SkillManifest[]): Set<string> {
  const ids = new Set<string>();
  for (const skill of skills) {
    if (skill.indexer_id) ids.add(skill.indexer_id);
    if (skill.owner_agent_id) ids.add(skill.owner_agent_id);
    for (const contributor of skill.contributors ?? []) ids.add(contributor.agent_id);
  }
  return ids;
}

export async function getProductAnalyticsReport(env: Env, requestedDays = 30) {
  // Fast degraded check: if EmergentDB is down, avoid heavy listWithValues that would hit subrequest limit and return 0
  try {
    const probe = await fetch("https://api.emergentdb.com/qdkv/get/stats:debug:probe", { headers: { Authorization: `Bearer ${env.EMERGENTDB_API_KEY}`, "Content-Type": "application/json" } });
    if (probe.status === 500) throw new Error("edb_down");
  } catch {
    // Edb down: return honest counts via CF list only
    const kv = (await import("./kv.js")).statsKV(env);
    let agentsCount=0, sessionsCount=0;
    try {
      let cur: string | undefined;
      do { const p = await kv.list({ prefix: "agent:", limit: 1000, cursor: cur }); agentsCount += p.keys.length; cur = p.cursor; if (p.list_complete) break; } while(cur);
    } catch {}
    try {
      let cur: string | undefined;
      do { const p = await kv.list({ prefix: "analytics:session:", limit: 1000, cursor: cur }); sessionsCount += p.keys.length; cur = p.cursor; if (p.list_complete) break; } while(cur);
    } catch {}
    return {
      generated_at: new Date().toISOString(),
      requested_window_days: normalizeProductReportDays(requestedDays),
      degraded: "emergentdb_unavailable_cf_counts_only",
      engagement: { dau: 0, wau: 0, mau: 0, dau_wau_ratio: 0, dau_mau_ratio: 0, registered_agents: agentsCount, windows: { dau_days: 1, wau_days: 7, mau_days: 30, daily_trend_days: 14 } },
      retention: { requested_days: normalizeProductReportDays(requestedDays), cohort_age_days: { min: 2, max: 37 }, weighted: {}, cohorts: [] },
      churn: { product_churn_window_days: 30, churned_users_30d: 0, eligible_users: 0, churn_rate_30d: 0, install_abandonment_curve: { ok: true } as unknown as never },
      user_split: { inventory_scope: "current", registered_agents: agentsCount, normal_users: null, business_users: null, unclassified_non_creator_users: 0, agent_creators: 0, agent_creator_share: 0, creator_identities_without_current_profile: 0, acquisition_window_days: normalizeProductReportDays(requestedDays), acquisition_inferred_icp: [], caveat: "Degraded: detailed splits unavailable while store recovers." },
      usage: { session_window_days: 30, sessions_30d: { total_sessions_30d: sessionsCount, total_api_calls_30d: 0, unique_agents_30d: 0, api_calls_per_session: 0, api_calls_per_user_per_session: 0, repeat_usage_rate: 0, churn_pre_default_browser_replacement: null, churn_post_default_browser_replacement: null, observed_by_surface_30d: [], observed_by_execution_scope_30d: [], telemetry_schema_coverage_30d: 0, interpretation: "observed_minimum" as const }, cli_invocation_window_days: normalizeProductReportDays(requestedDays), cli_invocations: { total: 0, active_installs: 0, by_verb: [], by_day: [] }, observed_use_cases: [], detailed_intents_available: false, telemetry_caveat: "Degraded: detailed telemetry unavailable while store recovers.", cloud_service: await (await import("./cloudflare-usage.js")).getCloudflareWorkerUsage(env, normalizeProductReportDays(requestedDays)), reconciliation: { client_observed_actions_30d: 0, cloud_worker_requests: null, comparable: false, reason: "Degraded" } },
    };
  }
  const days = normalizeProductReportDays(requestedDays);
  const [profiles, skills] = await Promise.all([
    loadProfiles(env),
    loadSkills(env),
  ]);
  const [engagement, retentionCohorts, usage, usagePings, acquisition, installChurn, cloudflare] = await Promise.all([
    getEngagement(env, profiles),
    getRetention(env, days, profiles),
    getUsageMetrics(env, profiles),
    loadUsagePings(env, days),
    getAcquisitionSummary(env, days),
    getChurnCurve(env, days, "install"),
    getCloudflareWorkerUsage(env, days),
  ]);

  const creators = creatorIds(skills);
  const profileIds = new Set(profiles.map((profile) => profile.agent_id));
  const creatorAgents = profiles.filter((profile) => creators.has(profile.agent_id));
  const nonCreatorAgents = profiles.filter((profile) => !creators.has(profile.agent_id));
  const unregisteredCreators = [...creators].filter((id) => !profileIds.has(id)).length;

  const churnCutoff = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
  const churnEligible = profiles.filter((profile) => profile.total_executions > 0);
  const churned = churnEligible.filter((profile) => {
    const lastActive = lastActiveDate(profile);
    return !lastActive || lastActive < churnCutoff;
  });
  const sessions30d = {
    total_sessions_30d: usage.total_sessions_30d,
    total_api_calls_30d: usage.total_api_calls_30d,
    unique_agents_30d: usage.unique_agents_30d,
    api_calls_per_session: usage.api_calls_per_session,
    api_calls_per_user_per_session: usage.api_calls_per_user_per_session,
    repeat_usage_rate: usage.repeat_usage_rate,
    churn_pre_default_browser_replacement: usage.churn_pre_default_browser_replacement,
    churn_post_default_browser_replacement: usage.churn_post_default_browser_replacement,
    observed_by_surface_30d: usage.observed_by_surface_30d,
    observed_by_execution_scope_30d: usage.observed_by_execution_scope_30d,
    telemetry_schema_coverage_30d: usage.telemetry_schema_coverage_30d,
    interpretation: usage.interpretation,
  };
  const observedUseCases = safeCategoricalRows(usagePings.by_verb, SAFE_USAGE_VERBS);
  const acquisitionIcp = safeCategoricalRows(
    acquisition.dimensions.inferred_icp.map((row) => ({ key: row.value, count: row.sessions })),
    SAFE_ICP_VALUES,
  ).map((row) => ({ value: row.key, sessions: row.count }));

  return {
    generated_at: new Date().toISOString(),
    requested_window_days: days,
    cache_policy: {
      ttl_seconds: 60,
      stale_while_revalidate_after_seconds: 30,
      freshness: "bounded-stale aggregate; Cache-Control: no-cache forces an authorized refresh",
      cached_dimensions: "allowlisted categorical aggregates only; no credentials, identifiers, raw intents, or free-form labels",
    },
    scope: {
      current_inventory: ["user_split"],
      fixed_30d: ["engagement.mau", "churn.product", "usage.sessions"],
      requested_window: ["churn.install_abandonment_curve", "usage.cli_invocations", "user_split.acquisition_inferred_icp"],
      retention_cohort_age_days: { min: 2, max: Math.min(days + 30, 60) },
    },
    definitions: {
      active_user: "unique registered agent profile with an activity date in the metric's stated period",
      retained_user: "registered agent active on the exact cohort checkpoint day",
      churned_user_30d: "agent with at least one execution and no activity in the last 30 days",
      agent_creator: "registered agent referenced as an active skill indexer, owner, or contributor",
      normal_user: "not independently identifiable from the current agent profile schema",
      business_user: "not independently identifiable from the current agent profile schema; acquisition ICP is reported separately",
    },
    engagement: {
      windows: { dau_days: 1, wau_days: 7, mau_days: 30, daily_trend_days: 14 },
      ...engagement,
      registered_agents: profiles.length,
    },
    retention: {
      requested_days: days,
      cohort_age_days: { min: 2, max: Math.min(days + 30, 60) },
      weighted: summarizeRetention(retentionCohorts),
      cohorts: retentionCohorts,
    },
    churn: {
      product_churn_window_days: 30,
      churned_users_30d: churned.length,
      eligible_users: churnEligible.length,
      churn_rate_30d: ratio(churned.length, churnEligible.length),
      install_abandonment_curve: installChurn,
    },
    user_split: {
      inventory_scope: "current",
      registered_agents: profiles.length,
      normal_users: null,
      business_users: null,
      unclassified_non_creator_users: nonCreatorAgents.length,
      agent_creators: creatorAgents.length,
      agent_creator_share: ratio(creatorAgents.length, profiles.length),
      creator_identities_without_current_profile: unregisteredCreators,
      acquisition_window_days: days,
      acquisition_inferred_icp: acquisitionIcp,
      caveat: "Business status is not stored on AgentProfile, so ICP sessions must not be presented as identified business users.",
    },
    usage: {
      session_window_days: 30,
      sessions_30d: sessions30d,
      cli_invocation_window_days: days,
      cli_invocations: {
        total: usagePings.total,
        active_installs: usagePings.active_installs,
        by_verb: observedUseCases,
        by_day: usagePings.by_day,
      },
      observed_use_cases: observedUseCases,
      cloud_service: cloudflare,
      reconciliation: {
        client_observed_actions_30d: usage.total_api_calls_30d,
        cloud_worker_requests: cloudflare.requests,
        comparable: false,
        reason: "Client actions and Worker requests are different units: one action may make zero, one, or many cloud requests.",
      },
      detailed_intents_available: false,
      telemetry_caveat: "Client metrics are opt-out, best-effort observed minimums and include local work. Cloudflare requests independently count traffic reaching this Worker only; neither source measures all product use.",
    },
  };
}
