/**
 * Analytics service — retention cohorts, activation funnels, engagement metrics.
 *
 * Storage design (all in statsKV):
 *   active:{YYYY-MM-DD}  → JSON string[] of agent_ids active that day (TTL 90d)
 *   cohort:{YYYY-MM-DD}  → JSON string[] of agent_ids registered that day (TTL 180d)
 *
 * Agent lifecycle fields on AgentProfile:
 *   first_execution_at, last_active_at (set by agents.ts)
 */

import type { Env, AgentProfile } from "../types.js";
import { statsKV } from "./kv.js";

// ─── Helpers ───

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ─── Record activity (called on every execution/feedback) ───

export async function recordActivity(env: Env, agentId: string): Promise<void> {
  const today = dateKey(new Date());
  const key = `active:${today}`;
  const kv = statsKV(env);

  const raw = await kv.get(key) as string | null;
  const agents: string[] = raw ? JSON.parse(raw) : [];

  if (!agents.includes(agentId)) {
    agents.push(agentId);
    await kv.put(key, JSON.stringify(agents), { expirationTtl: 90 * 86400 });
  }
}

// ─── Record registration cohort ───

export async function recordRegistration(env: Env, agentId: string): Promise<void> {
  const today = dateKey(new Date());
  const key = `cohort:${today}`;
  const kv = statsKV(env);

  const raw = await kv.get(key) as string | null;
  const agents: string[] = raw ? JSON.parse(raw) : [];

  if (!agents.includes(agentId)) {
    agents.push(agentId);
    await kv.put(key, JSON.stringify(agents), { expirationTtl: 180 * 86400 });
  }
}

// ─── Daily active set loader ───

async function getActiveSet(env: Env, date: string): Promise<Set<string>> {
  const raw = await statsKV(env).get(`active:${date}`) as string | null;
  return new Set(raw ? JSON.parse(raw) : []);
}

async function getCohort(env: Env, date: string): Promise<string[]> {
  const raw = await statsKV(env).get(`cohort:${date}`) as string | null;
  return raw ? JSON.parse(raw) : [];
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
  // Fetch last 30 days of daily active sets in parallel
  const dates: string[] = [];
  for (let i = 0; i < 30; i++) {
    dates.push(dateKey(daysAgo(i)));
  }

  const sets = await Promise.all(dates.map(d => getActiveSet(env, d)));

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
  const checkpoints = [1, 3, 7, 14, 30];
  const cohorts: RetentionCohort[] = [];

  // Look at cohorts from 2..days+30 days ago (need at least d1 data)
  const startDay = 2;
  const endDay = Math.min(days + 30, 60); // cap to avoid too many KV reads

  // Pre-fetch all needed active sets
  const allDates: string[] = [];
  for (let i = 0; i <= endDay + 30; i++) {
    allDates.push(dateKey(daysAgo(i)));
  }
  const activeSetPromises = new Map<string, Promise<Set<string>>>();
  for (const d of allDates) {
    if (!activeSetPromises.has(d)) {
      activeSetPromises.set(d, getActiveSet(env, d));
    }
  }

  // Pre-fetch cohorts
  for (let daysBack = startDay; daysBack <= endDay; daysBack++) {
    const cohortDate = dateKey(daysAgo(daysBack));
    const cohortAgents = await getCohort(env, cohortDate);
    if (cohortAgents.length === 0) continue;

    const retention: Record<string, number> = {};

    for (const cp of checkpoints) {
      if (cp > daysBack) break; // can't compute d30 for a 7-day-old cohort
      const checkDate = dateKey(daysAgo(daysBack - cp));
      const activeOnDay = await (activeSetPromises.get(checkDate) ?? Promise.resolve(new Set()));
      const retained = cohortAgents.filter(id => activeOnDay.has(id)).length;
      retention[`d${cp}`] = Math.round((retained / cohortAgents.length) * 100) / 100;
    }

    cohorts.push({
      cohort_date: cohortDate,
      cohort_size: cohortAgents.length,
      retention,
    });
  }

  return cohorts;
}

// ─── Activation funnel ───

export interface ActivationFunnel {
  total_registered: number;
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
  const entries = await statsKV(env).listWithValues("agent:");
  const profiles: AgentProfile[] = entries.map(e => {
    try { return JSON.parse(e.value) as AgentProfile; }
    catch { return null; }
  }).filter((p): p is AgentProfile => p !== null);

  const total = profiles.length;
  const executedOnce = profiles.filter(p => p.total_executions >= 1).length;
  const discoveredSkill = profiles.filter(p => p.skills_discovered.length >= 1).length;
  const repeatUser = profiles.filter(p => p.total_executions >= 5).length;
  const powerUser = profiles.filter(p => p.total_executions >= 20).length;

  return {
    total_registered: total,
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
  const entries = await statsKV(env).listWithValues("agent:");
  const profiles: AgentProfile[] = entries.map(e => {
    try { return JSON.parse(e.value) as AgentProfile; }
    catch { return null; }
  }).filter((p): p is AgentProfile => p !== null);

  const now = Date.now();
  const dayMs = 86400_000;

  const activeToday = profiles.filter(p =>
    p.last_active_at && (now - new Date(p.last_active_at).getTime()) < dayMs
  ).length;

  const activeWeek = profiles.filter(p =>
    p.last_active_at && (now - new Date(p.last_active_at).getTime()) < 7 * dayMs
  ).length;

  const activeMonth = profiles.filter(p =>
    p.last_active_at && (now - new Date(p.last_active_at).getTime()) < 30 * dayMs
  ).length;

  const churned = profiles.filter(p =>
    p.total_executions > 0 &&
    (!p.last_active_at || (now - new Date(p.last_active_at).getTime()) > 30 * dayMs)
  ).length;

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
    active_today: activeToday,
    active_this_week: activeWeek,
    active_this_month: activeMonth,
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
 * One-time backfill: reads all existing AgentProfiles and seeds
 * cohort:{date} from created_at and active:{date} from last_active_at.
 * Safe to run multiple times — deduplicates agent_ids in each set.
 */
export async function backfillFromProfiles(env: Env): Promise<BackfillResult> {
  const entries = await statsKV(env).listWithValues("agent:");
  const profiles: AgentProfile[] = entries.map(e => {
    try { return JSON.parse(e.value) as AgentProfile; }
    catch { return null; }
  }).filter((p): p is AgentProfile => p !== null);

  // Group by registration date
  const cohortMap = new Map<string, string[]>();
  // Group by last active date (best we can do without full history)
  const activeMap = new Map<string, string[]>();

  for (const p of profiles) {
    // Seed cohort from created_at
    if (p.created_at) {
      const date = p.created_at.slice(0, 10);
      const arr = cohortMap.get(date) ?? [];
      if (!arr.includes(p.agent_id)) arr.push(p.agent_id);
      cohortMap.set(date, arr);
    }

    // Seed active day from last_active_at (if available) or created_at as fallback
    const activeDate = p.last_active_at ?? (p.total_executions > 0 ? p.created_at : null);
    if (activeDate) {
      const date = activeDate.slice(0, 10);
      const arr = activeMap.get(date) ?? [];
      if (!arr.includes(p.agent_id)) arr.push(p.agent_id);
      activeMap.set(date, arr);
    }
  }

  const kv = statsKV(env);

  // Write cohort sets
  for (const [date, agents] of cohortMap) {
    const key = `cohort:${date}`;
    const existing = await kv.get(key) as string | null;
    const merged = new Set<string>(existing ? JSON.parse(existing) : []);
    for (const id of agents) merged.add(id);
    await kv.put(key, JSON.stringify([...merged]), { expirationTtl: 180 * 86400 });
  }

  // Write active sets
  for (const [date, agents] of activeMap) {
    const key = `active:${date}`;
    const existing = await kv.get(key) as string | null;
    const merged = new Set<string>(existing ? JSON.parse(existing) : []);
    for (const id of agents) merged.add(id);
    await kv.put(key, JSON.stringify([...merged]), { expirationTtl: 90 * 86400 });
  }

  return {
    agents_processed: profiles.length,
    cohorts_seeded: cohortMap.size,
    active_days_seeded: activeMap.size,
  };
}
