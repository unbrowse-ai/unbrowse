import type { AgentProfile, Env, SkillManifest } from "../types.js";
import { GRAPH_OPERATION_COST_UC, getFeesSummary } from "./fees.js";
import { getPerf } from "./perf.js";
import { computeSavings } from "./savings.js";
import { skillsKV, statsKV } from "./kv.js";

const SESSION_PREFIX = "analytics:session:";
const SNAPSHOT_PREFIX = "analytics:snapshot:";
const PRICING_KEY = "analytics:pricing";

export type AdoptionMetric = "npm_installs" | "github_stars" | "cli_installs";
export type BrowserMode = "default" | "replaced" | "manual" | "unknown";

export interface AnalyticsSessionSummary {
  session_id: string;
  started_at: string;
  completed_at?: string;
  trace_version?: string;
  api_calls: number;
  discovery_queries?: number;
  cached_skill_calls?: number;
  fresh_index_calls?: number;
  browser_mode?: BrowserMode;
}

interface StoredSessionSummary extends AnalyticsSessionSummary {
  agent_id: string;
}

export interface AdoptionSnapshot {
  metric: AdoptionMetric;
  value: number;
  captured_at: string;
}

export interface RevenuePricingModel {
  route_price_usd: number;
  discovery_price_usd: number;
  route_take_rate: number;
  discovery_take_rate: number;
  monthly_fixed_cost_usd: number;
  target_monthly_revenue_usd: number;
}

export interface TrendPoint {
  date: string;
  value: number;
}

export interface GrowthMetrics {
  cumulative_users: number;
  daily_new_users: TrendPoint[];
  last_7d_new_users: number;
  prior_7d_new_users: number;
  new_user_growth_rate: number;
  npm_install_trend: TrendPoint[];
  github_star_trend: TrendPoint[];
}

export interface UsageMetrics {
  total_sessions_30d: number;
  unique_agents_30d: number;
  api_calls_per_session: number;
  api_calls_per_user_per_session: number;
  repeat_usage_rate: number;
  churn_pre_default_browser_replacement: number | null;
  churn_post_default_browser_replacement: number | null;
  version_breakdown_30d: Array<{
    trace_version: string;
    sessions: number;
    agents: number;
    api_calls: number;
  }>;
}

export interface FunnelStage {
  key: "registered" | "activated" | "aha" | "repeat" | "retained_d7" | "retained_d30";
  label: string;
  users: number;
  eligible_users: number;
  conversion_from_previous: number;
  conversion_from_cohort: number;
}

export interface OptimizationFunnel {
  window_days: number;
  cohort_start: string;
  cohort_end: string;
  recovered_profiles_excluded: number;
  data_quality_warnings: string[];
  stages: FunnelStage[];
}

export interface NetworkHealthMetrics {
  total_indexed_skills: number;
  total_indexed_endpoints: number;
  coverage_breadth: number;
  indexed_skill_calls: number;
  route_cache_calls: number;
  fresh_index_calls: number;
  skill_reuse_rate: number;
}

export interface UnitEconomicsMetrics {
  pricing: RevenuePricingModel;
  route_calls_30d: number;
  discovery_queries_30d: number;
  avg_unbrowse_cost_per_action_usd: number;
  avg_browser_agent_cost_per_action_usd: number;
  cost_savings_per_action_usd: number;
  speed_improvement_per_action_ms: number;
  speedup_multiplier: number;
  revenue_per_route_usd: number;
  revenue_per_discovery_query_usd: number;
  estimated_monthly_revenue_run_rate_usd: number;
  required_route_volume_for_target_revenue: number | null;
  required_discovery_volume_for_target_revenue: number | null;
  break_even_user_count: number | null;
  savings: ReturnType<typeof computeSavings>;
}

const DEFAULT_PRICING: RevenuePricingModel = {
  route_price_usd: 0.005,
  discovery_price_usd: 0.02,
  route_take_rate: 1,
  discovery_take_rate: 1,
  monthly_fixed_cost_usd: 0,
  target_monthly_revenue_usd: 100_000,
};

function dateKey(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): Date {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - days);
  now.setUTCHours(0, 0, 0, 0);
  return now;
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return dateKey(next);
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100) / 100;
}

function safeMoney(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function normalizeActivityDates(dates: string[] | undefined): string[] {
  return Array.from(new Set((dates ?? []).filter(Boolean))).sort();
}

async function loadProfiles(env: Env): Promise<AgentProfile[]> {
  const entries = await statsKV(env).listWithValues("agent:");
  return entries.flatMap((entry) => {
    try {
      const profile = JSON.parse(entry.value) as AgentProfile;
      profile.activity_dates = normalizeActivityDates(profile.activity_dates);
      return [profile];
    } catch {
      return [];
    }
  });
}

async function loadActiveSkills(env: Env): Promise<SkillManifest[]> {
  const entries = await skillsKV(env).listWithValues("skill:");
  return entries.flatMap((entry) => {
    try {
      const skill = JSON.parse(entry.value) as SkillManifest;
      if (skill.lifecycle === "deprecated" || skill.lifecycle === "disabled") return [];
      return [skill];
    } catch {
      return [];
    }
  });
}

async function loadSessions(env: Env): Promise<StoredSessionSummary[]> {
  const entries = await statsKV(env).listWithValues(SESSION_PREFIX);
  return entries.flatMap((entry) => {
    try {
      return [JSON.parse(entry.value) as StoredSessionSummary];
    } catch {
      return [];
    }
  });
}

async function loadSnapshots(env: Env, metric: AdoptionMetric): Promise<AdoptionSnapshot[]> {
  const entries = await statsKV(env).listWithValues(`${SNAPSHOT_PREFIX}${metric}:`);
  return entries.flatMap((entry) => {
    try {
      return [JSON.parse(entry.value) as AdoptionSnapshot];
    } catch {
      return [];
    }
  }).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
}

function profileLastActiveDate(profile: AgentProfile): string | null {
  const activityDates = normalizeActivityDates(profile.activity_dates);
  if (activityDates.length > 0) return activityDates[activityDates.length - 1];
  if (profile.last_active_at) return profile.last_active_at.slice(0, 10);
  return null;
}

function buildTrend(points: Map<string, number>, days: number): TrendPoint[] {
  const trend: TrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dateKey(daysAgo(i));
    trend.push({ date, value: points.get(date) ?? 0 });
  }
  return trend;
}

function recentSessionsForWindow(sessions: StoredSessionSummary[], days: number): StoredSessionSummary[] {
  const cutoff = dateKey(daysAgo(days));
  return sessions.filter((session) => dateKey(session.started_at) >= cutoff);
}

function buildSessionIndex(sessions: StoredSessionSummary[]): Map<string, StoredSessionSummary[]> {
  const byAgent = new Map<string, StoredSessionSummary[]>();
  for (const session of sessions) {
    const list = byAgent.get(session.agent_id) ?? [];
    list.push(session);
    byAgent.set(session.agent_id, list);
  }
  for (const list of byAgent.values()) {
    list.sort((a, b) => a.started_at.localeCompare(b.started_at));
  }
  return byAgent;
}

export async function recordSessionSummary(
  env: Env,
  agentId: string,
  session: AnalyticsSessionSummary,
): Promise<void> {
  const normalized: StoredSessionSummary = {
    ...session,
    agent_id: agentId,
    trace_version: session.trace_version ?? "unknown",
    api_calls: Math.max(0, session.api_calls ?? 0),
    discovery_queries: Math.max(0, session.discovery_queries ?? 0),
    cached_skill_calls: Math.max(0, session.cached_skill_calls ?? 0),
    fresh_index_calls: Math.max(0, session.fresh_index_calls ?? 0),
    browser_mode: session.browser_mode ?? "unknown",
  };
  await statsKV(env).put(`${SESSION_PREFIX}${session.session_id}`, JSON.stringify(normalized));
}

export async function recordAdoptionSnapshot(env: Env, snapshot: AdoptionSnapshot): Promise<void> {
  const normalized: AdoptionSnapshot = {
    metric: snapshot.metric,
    value: Math.max(0, Math.round(snapshot.value)),
    captured_at: snapshot.captured_at ?? new Date().toISOString(),
  };
  const key = `${SNAPSHOT_PREFIX}${snapshot.metric}:${dateKey(normalized.captured_at)}`;
  await statsKV(env).put(key, JSON.stringify(normalized));
}

export async function getRevenuePricing(env: Env): Promise<RevenuePricingModel> {
  const raw = await statsKV(env).get(PRICING_KEY) as string | null;
  if (!raw) return { ...DEFAULT_PRICING };
  try {
    return { ...DEFAULT_PRICING, ...(JSON.parse(raw) as Partial<RevenuePricingModel>) };
  } catch {
    return { ...DEFAULT_PRICING };
  }
}

export async function saveRevenuePricing(env: Env, pricing: Partial<RevenuePricingModel>): Promise<RevenuePricingModel> {
  const merged = { ...(await getRevenuePricing(env)), ...pricing };
  await statsKV(env).put(PRICING_KEY, JSON.stringify(merged));
  return merged;
}

export async function getGrowthMetrics(env: Env, days = 30): Promise<GrowthMetrics> {
  const [profiles, npmInstallSnapshots, githubStarSnapshots] = await Promise.all([
    loadProfiles(env),
    loadSnapshots(env, "npm_installs"),
    loadSnapshots(env, "github_stars"),
  ]);

  const newUsersByDay = new Map<string, number>();
  for (const profile of profiles) {
    const day = dateKey(profile.created_at);
    newUsersByDay.set(day, (newUsersByDay.get(day) ?? 0) + 1);
  }

  const dailyNewUsers = buildTrend(newUsersByDay, days);
  const last7 = dailyNewUsers.slice(-7).reduce((sum, point) => sum + point.value, 0);
  const prior7 = dailyNewUsers
    .slice(Math.max(0, dailyNewUsers.length - 14), Math.max(0, dailyNewUsers.length - 7))
    .reduce((sum, point) => sum + point.value, 0);

  return {
    cumulative_users: profiles.length,
    daily_new_users: dailyNewUsers,
    last_7d_new_users: last7,
    prior_7d_new_users: prior7,
    new_user_growth_rate: prior7 > 0 ? safeRatio(last7 - prior7, prior7) : (last7 > 0 ? 1 : 0),
    npm_install_trend: npmInstallSnapshots.map((snapshot) => ({ date: dateKey(snapshot.captured_at), value: snapshot.value })),
    github_star_trend: githubStarSnapshots.map((snapshot) => ({ date: dateKey(snapshot.captured_at), value: snapshot.value })),
  };
}

export async function getUsageMetrics(env: Env): Promise<UsageMetrics> {
  const [profiles, sessions] = await Promise.all([loadProfiles(env), loadSessions(env)]);
  const recentSessions = recentSessionsForWindow(sessions, 30);
  const totalApiCalls = recentSessions.reduce((sum, session) => sum + Math.max(0, session.api_calls), 0);
  const sessionAgents = new Set(recentSessions.map((session) => session.agent_id));
  const engagedProfiles = profiles.filter((profile) => profile.total_executions > 0);
  const repeatUsers = engagedProfiles.filter((profile) =>
    normalizeActivityDates(profile.activity_dates).length >= 2 || profile.total_executions >= 2,
  );
  const churnCutoff = dateKey(daysAgo(30));

  const postAgents = new Set(
    recentSessions
      .filter((session) => session.browser_mode === "replaced")
      .map((session) => session.agent_id),
  );
  const preAgents = new Set(
    recentSessions
      .filter((session) => session.browser_mode !== "replaced")
      .map((session) => session.agent_id),
  );

  const churnRateFor = (agentIds: Set<string>): number | null => {
    if (agentIds.size === 0) return null;
    const relevantProfiles = profiles.filter((profile) => agentIds.has(profile.agent_id));
    if (relevantProfiles.length === 0) return null;
    const churned = relevantProfiles.filter((profile) => {
      const lastActive = profileLastActiveDate(profile);
      return !lastActive || lastActive < churnCutoff;
    }).length;
    return safeRatio(churned, relevantProfiles.length);
  };

  const versionMap = new Map<string, { sessions: number; api_calls: number; agents: Set<string> }>();
  for (const session of recentSessions) {
    const traceVersion = session.trace_version ?? "unknown";
    const entry = versionMap.get(traceVersion) ?? { sessions: 0, api_calls: 0, agents: new Set<string>() };
    entry.sessions++;
    entry.api_calls += Math.max(0, session.api_calls);
    entry.agents.add(session.agent_id);
    versionMap.set(traceVersion, entry);
  }

  const version_breakdown_30d = [...versionMap.entries()]
    .map(([trace_version, entry]) => ({
      trace_version,
      sessions: entry.sessions,
      agents: entry.agents.size,
      api_calls: entry.api_calls,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.trace_version.localeCompare(b.trace_version));

  return {
    total_sessions_30d: recentSessions.length,
    unique_agents_30d: sessionAgents.size,
    api_calls_per_session: safeRatio(totalApiCalls, recentSessions.length),
    api_calls_per_user_per_session: safeRatio(totalApiCalls, recentSessions.length),
    repeat_usage_rate: safeRatio(repeatUsers.length, engagedProfiles.length),
    churn_pre_default_browser_replacement: churnRateFor(preAgents),
    churn_post_default_browser_replacement: churnRateFor(postAgents),
    version_breakdown_30d,
  };
}

export async function getOptimizationFunnel(env: Env, days = 30): Promise<OptimizationFunnel> {
  const [profiles, sessions] = await Promise.all([loadProfiles(env), loadSessions(env)]);
  const cohortStart = dateKey(daysAgo(days));
  const cohortEnd = dateKey(new Date());
  const cohortProfiles = profiles.filter((profile) => {
    const created = dateKey(profile.created_at);
    return created >= cohortStart && created <= cohortEnd && profile.profile_origin !== "recovered";
  });
  const recoveredProfilesExcluded = profiles.filter((profile) => {
    const created = dateKey(profile.created_at);
    return created >= cohortStart && created <= cohortEnd && profile.profile_origin === "recovered";
  }).length;
  const sessionsByAgent = buildSessionIndex(sessions);
  const dataQualityWarnings: string[] = [];

  const activated = cohortProfiles.filter((profile) => {
    const agentSessions = sessionsByAgent.get(profile.agent_id) ?? [];
    return profile.total_executions > 0 || agentSessions.length > 0;
  });
  const aha = activated.filter((profile) => {
    const agentSessions = sessionsByAgent.get(profile.agent_id) ?? [];
    return agentSessions.some((session) =>
      session.api_calls >= 1 ||
      (session.cached_skill_calls ?? 0) >= 1 ||
      (session.fresh_index_calls ?? 0) >= 1,
    );
  });
  const repeat = aha.filter((profile) => {
    const agentSessions = sessionsByAgent.get(profile.agent_id) ?? [];
    return agentSessions.length >= 2 || normalizeActivityDates(profile.activity_dates).length >= 2;
  });

  if (activated.some((profile) => (sessionsByAgent.get(profile.agent_id) ?? []).length === 0)) {
    dataQualityWarnings.push("missing_session_coverage_for_some_activated_users");
  }
  if (recoveredProfilesExcluded > 0) {
    dataQualityWarnings.push("recovered_profiles_excluded_from_canonical_funnel");
  }

  const retainedD7Eligible = repeat.filter((profile) => addDays(dateKey(profile.created_at), 7) <= cohortEnd);
  const retainedD7 = retainedD7Eligible.filter((profile) => {
    const target = addDays(dateKey(profile.created_at), 7);
    return normalizeActivityDates(profile.activity_dates).some((day) => day >= target);
  });

  const retainedD30Eligible = retainedD7.filter((profile) => addDays(dateKey(profile.created_at), 30) <= cohortEnd);
  const retainedD30 = retainedD30Eligible.filter((profile) => {
    const target = addDays(dateKey(profile.created_at), 30);
    return normalizeActivityDates(profile.activity_dates).some((day) => day >= target);
  });

  const registeredCount = cohortProfiles.length;
  const stages: FunnelStage[] = [
    {
      key: "registered",
      label: "Registered",
      users: registeredCount,
      eligible_users: registeredCount,
      conversion_from_previous: 1,
      conversion_from_cohort: 1,
    },
    {
      key: "activated",
      label: "Activated",
      users: activated.length,
      eligible_users: registeredCount,
      conversion_from_previous: safeRatio(activated.length, registeredCount),
      conversion_from_cohort: safeRatio(activated.length, registeredCount),
    },
    {
      key: "aha",
      label: "Aha",
      users: aha.length,
      eligible_users: activated.length,
      conversion_from_previous: safeRatio(aha.length, activated.length),
      conversion_from_cohort: safeRatio(aha.length, registeredCount),
    },
    {
      key: "repeat",
      label: "Repeat",
      users: repeat.length,
      eligible_users: aha.length,
      conversion_from_previous: safeRatio(repeat.length, aha.length),
      conversion_from_cohort: safeRatio(repeat.length, registeredCount),
    },
    {
      key: "retained_d7",
      label: "Retained D7",
      users: retainedD7.length,
      eligible_users: retainedD7Eligible.length,
      conversion_from_previous: safeRatio(retainedD7.length, retainedD7Eligible.length),
      conversion_from_cohort: safeRatio(retainedD7.length, registeredCount),
    },
    {
      key: "retained_d30",
      label: "Retained D30",
      users: retainedD30.length,
      eligible_users: retainedD30Eligible.length,
      conversion_from_previous: safeRatio(retainedD30.length, retainedD30Eligible.length),
      conversion_from_cohort: safeRatio(retainedD30.length, registeredCount),
    },
  ];

  return {
    window_days: days,
    cohort_start: cohortStart,
    cohort_end: cohortEnd,
    recovered_profiles_excluded: recoveredProfilesExcluded,
    data_quality_warnings: dataQualityWarnings,
    stages,
  };
}

export async function getNetworkHealthMetrics(env: Env): Promise<NetworkHealthMetrics> {
  const [skills, perf, sessions] = await Promise.all([loadActiveSkills(env), getPerf(env), loadSessions(env)]);
  const recentSessions = recentSessionsForWindow(sessions, 30);
  const domainSet = new Set(skills.map((skill) => skill.domain).filter(Boolean));
  const sessionCachedSkillCalls = recentSessions.reduce((sum, session) => sum + Math.max(0, session.cached_skill_calls ?? 0), 0);
  const sessionFreshIndexCalls = recentSessions.reduce((sum, session) => sum + Math.max(0, session.fresh_index_calls ?? 0), 0);
  const hasSessionCoverage = recentSessions.length > 0;
  const indexedSkillCalls = hasSessionCoverage ? sessionCachedSkillCalls : perf.marketplace_hits;
  const routeCacheCalls = hasSessionCoverage ? 0 : perf.cache_hits;
  const freshIndexCalls = hasSessionCoverage ? sessionFreshIndexCalls : perf.live_captures;
  const reuseDenominator = indexedSkillCalls + routeCacheCalls + freshIndexCalls;

  return {
    total_indexed_skills: skills.length,
    total_indexed_endpoints: skills.reduce((sum, skill) => sum + skill.endpoints.length, 0),
    coverage_breadth: domainSet.size,
    indexed_skill_calls: indexedSkillCalls,
    route_cache_calls: routeCacheCalls,
    fresh_index_calls: freshIndexCalls,
    skill_reuse_rate: safeRatio(indexedSkillCalls + routeCacheCalls, reuseDenominator),
  };
}

export async function getUnitEconomicsMetrics(env: Env): Promise<UnitEconomicsMetrics> {
  const [pricing, perf, feeSummary, sessions] = await Promise.all([
    getRevenuePricing(env),
    getPerf(env),
    getFeesSummary(env),
    loadSessions(env),
  ]);
  const savings = computeSavings(perf);
  const recentSessions = recentSessionsForWindow(sessions, 30);
  const routeCalls30d = recentSessions.reduce((sum, session) => sum + Math.max(0, session.api_calls), 0);
  const sessionDiscoveryQueries30d = recentSessions.reduce((sum, session) => sum + Math.max(0, session.discovery_queries ?? 0), 0);
  const discoveryQueries30d = sessionDiscoveryQueries30d > 0
    ? sessionDiscoveryQueries30d
    : Math.round((feeSummary.by_operation.search ?? 0) / GRAPH_OPERATION_COST_UC.search);
  const uniqueAgents30d = new Set(recentSessions.map((session) => session.agent_id)).size;

  const avgBrowserCostPerAction = perf.total_resolves > 0
    ? savings.estimated_browser_cost_usd / perf.total_resolves
    : 0;
  const avgUnbrowseCostPerAction = savings.actual_cost_usd;
  const avgRouteRevenue = pricing.route_price_usd * pricing.route_take_rate;
  const avgDiscoveryRevenue = pricing.discovery_price_usd * pricing.discovery_take_rate;
  const avgDiscoveryCost = GRAPH_OPERATION_COST_UC.search / 1_000_000;
  const routeMargin = Math.max(0, avgRouteRevenue - avgUnbrowseCostPerAction);
  const discoveryMargin = Math.max(0, avgDiscoveryRevenue - avgDiscoveryCost);
  const monthlyRunRate = safeMoney(routeCalls30d * avgRouteRevenue + discoveryQueries30d * avgDiscoveryRevenue);
  const avgRevenuePerActiveUser30d = uniqueAgents30d > 0
    ? safeMoney(((routeCalls30d * routeMargin) + (discoveryQueries30d * discoveryMargin)) / uniqueAgents30d)
    : 0;
  const targetRevenue = pricing.target_monthly_revenue_usd;

  return {
    pricing,
    route_calls_30d: routeCalls30d,
    discovery_queries_30d: discoveryQueries30d,
    avg_unbrowse_cost_per_action_usd: safeMoney(avgUnbrowseCostPerAction),
    avg_browser_agent_cost_per_action_usd: safeMoney(avgBrowserCostPerAction),
    cost_savings_per_action_usd: safeMoney(Math.max(0, avgBrowserCostPerAction - avgUnbrowseCostPerAction)),
    speed_improvement_per_action_ms: Math.max(0, Math.round(43_000 - perf.avg_total_ms)),
    speedup_multiplier: perf.avg_total_ms > 0 ? Math.round((43_000 / perf.avg_total_ms) * 100) / 100 : 0,
    revenue_per_route_usd: safeMoney(avgRouteRevenue),
    revenue_per_discovery_query_usd: safeMoney(avgDiscoveryRevenue),
    estimated_monthly_revenue_run_rate_usd: monthlyRunRate,
    required_route_volume_for_target_revenue: avgRouteRevenue > 0 ? Math.ceil(targetRevenue / avgRouteRevenue) : null,
    required_discovery_volume_for_target_revenue: avgDiscoveryRevenue > 0 ? Math.ceil(targetRevenue / avgDiscoveryRevenue) : null,
    break_even_user_count: pricing.monthly_fixed_cost_usd > 0 && avgRevenuePerActiveUser30d > 0
      ? Math.ceil(pricing.monthly_fixed_cost_usd / avgRevenuePerActiveUser30d)
      : null,
    savings,
  };
}
