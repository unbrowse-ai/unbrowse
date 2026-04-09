import type { Env } from "../types.js";
import { statsKV, skillsKV } from "./kv.js";

export interface SummaryCounters {
  skills: number;
  endpoints: number;
  domains: number;
  executions: number;
  agents: number;
  domain_set: string[];
  rebuilt_at: string;
}

const KEY = "meta:summary";

export async function getSummaryCounters(env: Env): Promise<SummaryCounters | null> {
  const raw = await statsKV(env).get(KEY) as string | null;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveSummary(env: Env, counters: SummaryCounters): Promise<void> {
  await statsKV(env).put(KEY, JSON.stringify(counters));
}

/** Delta update — read-modify-write a single KV key instead of scanning all entries. */
export async function updateSummaryCounters(
  env: Env,
  delta: { skills?: number; endpoints?: number; executions?: number; agents?: number },
  domainChange?: { add?: string; remove?: string },
): Promise<void> {
  let c = await getSummaryCounters(env);
  if (!c) c = await rebuildSummaryCounters(env);

  if (delta.skills) c.skills = Math.max(0, c.skills + delta.skills);
  if (delta.endpoints) c.endpoints = Math.max(0, c.endpoints + delta.endpoints);
  if (delta.executions) c.executions = Math.max(0, c.executions + delta.executions);
  if (delta.agents) c.agents = Math.max(0, c.agents + delta.agents);

  if (domainChange?.add && !c.domain_set.includes(domainChange.add)) {
    c.domain_set.push(domainChange.add);
    c.domains = c.domain_set.length;
  }
  if (domainChange?.remove) {
    c.domain_set = c.domain_set.filter((d) => d !== domainChange.remove);
    c.domains = c.domain_set.length;
  }

  await saveSummary(env, c);
}

/** Full scan rebuild — run once on first request or via admin endpoint. */
export async function rebuildSummaryCounters(env: Env): Promise<SummaryCounters> {
  const [skillEntries, statEntries, agentEntries] = await Promise.all([
    skillsKV(env).listWithValues("skill:"),
    statsKV(env).listWithValues("stats:"),
    statsKV(env).listWithValues("agent:"),
  ]);

  let skillCount = 0;
  let endpointCount = 0;
  const domainSet = new Set<string>();
  for (const { value } of skillEntries) {
    try {
      const s = JSON.parse(value) as { endpoints?: unknown[]; domain?: string; lifecycle?: string };
      if (s.lifecycle === "deprecated" || s.lifecycle === "disabled") continue;
      skillCount++;
      endpointCount += s.endpoints?.length ?? 0;
      if (s.domain) domainSet.add(s.domain);
    } catch {}
  }

  let totalExecutions = 0;
  for (const { value } of statEntries) {
    try {
      const s = JSON.parse(value) as { total_executions?: number };
      totalExecutions += s.total_executions ?? 0;
    } catch {}
  }

  const counters: SummaryCounters = {
    skills: skillCount,
    endpoints: endpointCount,
    domains: domainSet.size,
    executions: totalExecutions,
    agents: agentEntries.length,
    domain_set: [...domainSet],
    rebuilt_at: new Date().toISOString(),
  };

  await saveSummary(env, counters);
  return counters;
}
