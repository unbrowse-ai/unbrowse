import type { EndpointStats, Env, SkillManifest } from "../types.js";
import { listSkills } from "./marketplace.js";
import { statsKV } from "./kv.js";

export interface PopularSkillSummary {
  skill_id: string;
  name: string;
  domain: string;
  description: string;
  version: string;
  execution_type: SkillManifest["execution_type"];
  endpoint_count: number;
  total_executions: number;
  successful_executions: number;
  avg_reliability_score: number;
  updated_at: string;
  last_execution_at?: string;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit!)));
}

function resolveSkillIdFromStatsKey(
  name: string,
  skillsById: Map<string, SkillManifest>,
  sortedSkillIds: string[],
): string | null {
  if (!name.startsWith("stats:")) return null;
  const body = name.slice("stats:".length);
  const lastSeparator = body.lastIndexOf("--");
  if (lastSeparator > 0) {
    const direct = body.slice(0, lastSeparator);
    if (skillsById.has(direct)) return direct;
  }
  for (const skillId of sortedSkillIds) {
    if (body.startsWith(`${skillId}--`)) return skillId;
  }
  return null;
}

export async function listPopularSkills(env: Env, limit?: number): Promise<PopularSkillSummary[]> {
  const [skills, statEntries] = await Promise.all([
    listSkills(env),
    statsKV(env).listWithValues("stats:"),
  ]);

  const activeSkills = skills.filter((skill) => skill.lifecycle === "active");
  const skillsById = new Map(activeSkills.map((skill) => [skill.skill_id, skill]));
  const sortedSkillIds = activeSkills
    .map((skill) => skill.skill_id)
    .sort((a, b) => b.length - a.length);

  const summaries = new Map<string, PopularSkillSummary>();
  for (const skill of activeSkills) {
    const avgReliabilityScore = skill.endpoints.length > 0
      ? skill.endpoints.reduce((sum, endpoint) => sum + endpoint.reliability_score, 0) / skill.endpoints.length
      : 0;
    summaries.set(skill.skill_id, {
      skill_id: skill.skill_id,
      name: skill.name,
      domain: skill.domain,
      description: skill.description,
      version: skill.version,
      execution_type: skill.execution_type,
      endpoint_count: skill.endpoints.length,
      total_executions: 0,
      successful_executions: 0,
      avg_reliability_score: avgReliabilityScore,
      updated_at: skill.updated_at,
    });
  }

  for (const entry of statEntries) {
    const skillId = resolveSkillIdFromStatsKey(entry.name, skillsById, sortedSkillIds);
    if (!skillId) continue;
    let stats: EndpointStats;
    try {
      stats = JSON.parse(entry.value) as EndpointStats;
    } catch {
      continue;
    }
    const summary = summaries.get(skillId);
    if (!summary) continue;
    summary.total_executions += stats.total_executions ?? 0;
    summary.successful_executions += stats.successful_executions ?? 0;
    if (stats.last_execution_at && (!summary.last_execution_at || stats.last_execution_at > summary.last_execution_at)) {
      summary.last_execution_at = stats.last_execution_at;
    }
  }

  return Array.from(summaries.values())
    .sort((a, b) =>
      b.total_executions - a.total_executions ||
      b.successful_executions - a.successful_executions ||
      b.avg_reliability_score - a.avg_reliability_score ||
      b.endpoint_count - a.endpoint_count ||
      b.updated_at.localeCompare(a.updated_at))
    .slice(0, clampLimit(limit));
}
