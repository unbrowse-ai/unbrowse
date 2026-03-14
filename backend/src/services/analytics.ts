/**
 * Analytics service — retention cohorts, activation funnels, engagement metrics.
 *
 * Source of truth: agent profiles in statsKV.
 * Each profile tracks lifecycle counters plus a bounded `activity_dates[]`
 * set, which avoids shared-key races during high-write telemetry periods.
 */

import type { Env, AgentProfile } from "../types.js";
import { statsKV } from "./kv.js";

// ─── Helpers ───

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return dateKey(next);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function normalizeActivityDates(dates: string[] | undefined): string[] {
  return Array.from(new Set((dates ?? []).filter(Boolean))).sort().slice(-90);
}

async function loadProfiles(env: Env): Promise<AgentProfile[]> {
  const entries = await statsKV(env).listWithValues("agent:");
  return entries.map((entry) => {
    try {
      const profile = JSON.parse(entry.value) as AgentProfile;
      profile.activity_dates = normalizeActivityDates(profile.activity_dates);
      return profile;
    } catch {
      return null;
    }
  }).filter((profile): profile is AgentProfile => profile !== null);
}

function buildActivityIndex(profiles: AgentProfile[]): Map<string, Set<string>> {
  const byDate = new Map<string, Set<string>>();
  for (const profile of profiles) {
    for (const day of normalizeActivityDates(profile.activity_dates)) {
      const set = byDate.get(day) ?? new Set<string>();
      set.add(profile.agent_id);
      byDate.set(day, set);
    }
  }
  return byDate;
}

function profileLastActiveDate(profile: AgentProfile): string | null {
  const activityDates = normalizeActivityDates(profile.activity_dates);
  if (activityDates.length > 0) return activityDates[activityDates.length - 1];
  if (profile.last_active_at) return profile.last_active_at.slice(0, 10);
  return null;
}

// ─── Engagement: DAU / WAU / MAU ───

export interface EngagementMetrics {
  dau: number;        // unique agents today
  wau: number;        // unique agents last 7 days
  mau: number;        // unique agents last 30 days
  dau_wau_ratio: number;  // stickiness
  dau_mau_ratio: number;
  daily_trend: Array<{ date: string; active: number }>;  // last 14 days
}

export async function getEngagement(env: Env): Promise<EngagementMetrics> {
  const profiles = await loadProfiles(env);
  const activityByDate = buildActivityIndex(profiles);
  const dates: string[] = [];
  for (let i = 0; i < 30; i++) {
    dates.push(dateKey(daysAgo(i)));
  }

  const sets = dates.map((date) => activityByDate.get(date) ?? new Set<string>());

  const today = sets[0];
  const weekSet = new Set<string>();
  const monthSet = new Set<string>();

  for (let i = 0; i < 30; i++) {
    for (const id of sets[i]) {
      monthSet.add(id);
      if (i < 7) weekSet.add(id);
    }
  }

  const dau = today.size;
  const wau = weekSet.size;
  const mau = monthSet.size;

  // Last 14 days trend
  const daily_trend = dates.slice(0, 14).map((date, i) => ({
    date,
    active: sets[i].size,
  }));

  return {
    dau,
    wau,
    mau,
    dau_wau_ratio: wau > 0 ? Math.round((dau / wau) * 100) / 100 : 0,
    dau_mau_ratio: mau > 0 ? Math.round((dau / mau) * 100) / 100 : 0,
    daily_trend,
  };
}

// ─── Retention cohorts ───

export interface RetentionCohort {
  cohort_date: string;
  cohort_size: number;
  retention: Record<string, number>;  // "d1": 0.45, "d7": 0.20, etc.
}

export async function getRetention(env: Env, days = 30): Promise<RetentionCohort[]> {
  const profiles = await loadProfiles(env);
  const activityByDate = buildActivityIndex(profiles);
  const checkpoints = [1, 3, 7, 14, 30];
  const cohorts: RetentionCohort[] = [];

  // Look at cohorts from 2..days+30 days ago (need at least d1 data)
  const startDay = 2;
  const endDay = Math.min(days + 30, 60); // cap to avoid too many KV reads

  for (let daysBack = startDay; daysBack <= endDay; daysBack++) {
    const cohortDate = dateKey(daysAgo(daysBack));
    const cohortProfiles = profiles.filter((profile) => profile.created_at.slice(0, 10) === cohortDate);
    if (cohortProfiles.length === 0) continue;

    const retention: Record<string, number> = {};

    for (const cp of checkpoints) {
      if (cp > daysBack) break; // can't compute d30 for a 7-day-old cohort
      const activeOnDay = activityByDate.get(addDays(cohortDate, cp)) ?? new Set<string>();
      const retained = cohortProfiles.filter((profile) => activeOnDay.has(profile.agent_id)).length;
      retention[`d${cp}`] = Math.round((retained / cohortProfiles.length) * 100) / 100;
    }

    cohorts.push({
      cohort_date: cohortDate,
      cohort_size: cohortProfiles.length,
      retention,
    });
  }

  return cohorts;
}

// ─── Activation funnel ───

export interface ActivationFunnel {
  total_registered: number;
  recovered_profiles: number;
  executed_once: number;       // had at least 1 execution
  discovered_skill: number;    // discovered at least 1 skill
  repeat_user: number;         // 5+ executions
  power_user: number;          // 20+ executions
  rates: {
    registration_to_first_exec: number;
    first_exec_to_discovery: number;
    discovery_to_repeat: number;
    repeat_to_power: number;
  };
}

export async function getActivation(env: Env): Promise<ActivationFunnel> {
  const profiles = await loadProfiles(env);

  const total = profiles.length;
  const recoveredProfiles = profiles.filter((p) => p.profile_origin === "recovered").length;
  const executedOnce = profiles.filter(p => p.total_executions >= 1).length;
  const discoveredSkill = profiles.filter(p => p.skills_discovered.length >= 1).length;
  const repeatUser = profiles.filter(p => p.total_executions >= 5).length;
  const powerUser = profiles.filter(p => p.total_executions >= 20).length;

  return {
    total_registered: total,
    recovered_profiles: recoveredProfiles,
    executed_once: executedOnce,
    discovered_skill: discoveredSkill,
    repeat_user: repeatUser,
    power_user: powerUser,
    rates: {
      registration_to_first_exec: total > 0 ? Math.round((executedOnce / total) * 100) / 100 : 0,
      first_exec_to_discovery: executedOnce > 0 ? Math.round((discoveredSkill / executedOnce) * 100) / 100 : 0,
      discovery_to_repeat: discoveredSkill > 0 ? Math.round((repeatUser / discoveredSkill) * 100) / 100 : 0,
      repeat_to_power: repeatUser > 0 ? Math.round((powerUser / repeatUser) * 100) / 100 : 0,
    },
  };
}

// ─── Agent health overview ───

export interface AgentHealth {
  total_agents: number;
  recovered_profiles: number;
  active_today: number;
  active_this_week: number;
  active_this_month: number;
  churned_30d: number;         // had activity > 30 days ago, none since
  avg_executions_per_agent: number;
  median_executions_per_agent: number;
  top_agents: Array<{
    agent_id: string;
    name: string;
    executions: number;
    skills_discovered: number;
    last_active: string | null;
  }>;
}

export async function getAgentHealth(env: Env): Promise<AgentHealth> {
  const profiles = await loadProfiles(env);
  const activityByDate = buildActivityIndex(profiles);
  const today = dateKey(new Date());
  const last7 = new Set<string>();
  const last30 = new Set<string>();

  for (let i = 0; i < 30; i++) {
    const day = dateKey(daysAgo(i));
    const active = activityByDate.get(day);
    if (!active) continue;
    for (const agentId of active) {
      last30.add(agentId);
      if (i < 7) last7.add(agentId);
    }
  }

  const churnCutoff = dateKey(daysAgo(30));
  const churned = profiles.filter((profile) => {
    if (profile.total_executions === 0) return false;
    const lastActive = profileLastActiveDate(profile);
    return !lastActive || lastActive < churnCutoff;
  }).length;

  const execCounts = profiles.map(p => p.total_executions).sort((a, b) => a - b);
  const avg = execCounts.length > 0
    ? Math.round(execCounts.reduce((s, n) => s + n, 0) / execCounts.length)
    : 0;
  const median = execCounts.length > 0
    ? execCounts[Math.floor(execCounts.length / 2)]
    : 0;

  const topAgents = [...profiles]
    .sort((a, b) => b.total_executions - a.total_executions)
    .slice(0, 10)
    .map(p => ({
      agent_id: p.agent_id,
      name: p.name,
      executions: p.total_executions,
      skills_discovered: p.skills_discovered.length,
      last_active: p.last_active_at ?? null,
    }));

  return {
    total_agents: profiles.length,
    recovered_profiles: profiles.filter((profile) => profile.profile_origin === "recovered").length,
    active_today: activityByDate.get(today)?.size ?? 0,
    active_this_week: last7.size,
    active_this_month: last30.size,
    churned_30d: churned,
    avg_executions_per_agent: avg,
    median_executions_per_agent: median,
    top_agents: topAgents,
  };
}

// ─── Backfill: seed cohort data from existing agent profiles ───

export interface BackfillResult {
  agents_processed: number;
  cohorts_seeded: number;
  active_days_seeded: number;
}

/**
 * One-time backfill: reads existing AgentProfiles and adds a bounded
 * `activity_dates` history from `last_active_at` (or `created_at` as fallback
 * for older agents with executions). Safe to run multiple times.
 */
export async function backfillFromProfiles(env: Env): Promise<BackfillResult> {
  const kv = statsKV(env);
  const profiles = await loadProfiles(env);
  let activeDaysSeeded = 0;

  for (const profile of profiles) {
    const existing = normalizeActivityDates(profile.activity_dates);
    const derived = profile.last_active_at
      ? profile.last_active_at.slice(0, 10)
      : (profile.total_executions > 0 ? profile.created_at.slice(0, 10) : null);
    if (!derived || existing.includes(derived)) continue;
    profile.activity_dates = normalizeActivityDates([...existing, derived]);
    await kv.put(`agent:${profile.agent_id}`, JSON.stringify(profile));
    activeDaysSeeded++;
  }

  return {
    agents_processed: profiles.length,
    cohorts_seeded: new Set(profiles.map((profile) => profile.created_at.slice(0, 10))).size,
    active_days_seeded: activeDaysSeeded,
  };
}
