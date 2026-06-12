/**
 * Popular-unreviewed query primitive.
 *
 * Surfaces local skills that:
 *   - have NO `reviewed_at` stamp AND no published publish-artifact
 *     (i.e. genuinely never shipped to the public marketplace), AND
 *   - have been used N+ times locally (proven utility), AND
 *   - have a healthy success rate.
 *
 * the platform's job is to TELL the truth about what exists locally. It does
 * NOT decide what to publish. The MCP tool that exposes this primitive
 * returns evidence (execution_count, success_rate, last_used) so the calling
 * agent can decide whether to batch-publish (no reviewed_at is stamped —
 * that field records an actual unbrowse_review).
 *
 * Why this exists when `auto_review` defaults to true:
 *   - Existing users who installed before auto_review existed have a backlog
 *     of unreviewed local skills.
 *   - Users who flipped `share_pointers=false` and back accumulate a backlog.
 *   - Domains the agent put on the prompt-list never publish until invited.
 *
 * Joins `listSkills()` (manifest cache, has reviewed_at + domain + endpoints)
 * with `readTraces()` per domain (JSONL execution traces, has
 * selected_endpoint_id + success + timestamp).
 */

import * as client from "../client/index.js";
import { getRecentTraces, type StoredTrace } from "../lib/graph-core/trace-store.js";
import { readWorkflowPublishArtifact } from "../workflow/publish.js";
import type { SkillManifest } from "../types/skill.js";

export interface PopularUnreviewedSkill {
  skill_id: string;
  domain: string;
  endpoint_count: number;
  execution_count: number;
  success_count: number;
  success_rate: number;
  last_used: string;
  most_used_endpoint?: { endpoint_id: string; uses: number };
}

export interface PopularUnreviewedOptions {
  min_executions?: number;
  min_success_rate?: number;
  limit?: number;
  trace_window?: number;
}

const DEFAULTS = {
  min_executions: 3,
  min_success_rate: 0.7,
  limit: 10,
  trace_window: 1000,
} as const;

export async function getPopularUnreviewedSkills(
  opts: PopularUnreviewedOptions = {},
): Promise<PopularUnreviewedSkill[]> {
  const min_executions = opts.min_executions ?? DEFAULTS.min_executions;
  const min_success_rate = opts.min_success_rate ?? DEFAULTS.min_success_rate;
  const limit = opts.limit ?? DEFAULTS.limit;
  const trace_window = opts.trace_window ?? DEFAULTS.trace_window;

  const all = await client.listSkills();
  const out: PopularUnreviewedSkill[] = [];

  for (const skill of all) {
    if (skill.reviewed_at) continue;
    // Auto-published skills carry no reviewed_at (the stamp records an
    // actual review) — the publish artifact is the publish-state witness.
    if (readWorkflowPublishArtifact(skill.skill_id)?.publish_status === "published") continue;
    if (!skill.domain) continue;
    if (!skill.endpoints?.length) continue;

    const endpointIds = new Set(skill.endpoints.map((e) => e.endpoint_id));
    const traces = getRecentTraces(skill.domain, trace_window);
    const skillTraces = traces.filter(
      (t) => t.selected_endpoint_id && endpointIds.has(t.selected_endpoint_id),
    );
    if (skillTraces.length < min_executions) continue;

    const successes = skillTraces.filter((t) => t.success).length;
    const rate = successes / skillTraces.length;
    if (rate < min_success_rate) continue;

    out.push({
      skill_id: skill.skill_id,
      domain: skill.domain,
      endpoint_count: skill.endpoints.length,
      execution_count: skillTraces.length,
      success_count: successes,
      success_rate: Number(rate.toFixed(2)),
      last_used: skillTraces[0]!.timestamp,
      most_used_endpoint: pickMostUsed(skillTraces),
    });
  }

  out.sort((a, b) => b.execution_count - a.execution_count);
  return out.slice(0, limit);
}

function pickMostUsed(
  traces: StoredTrace[],
): { endpoint_id: string; uses: number } | undefined {
  const counts = new Map<string, number>();
  for (const t of traces) {
    if (!t.selected_endpoint_id) continue;
    counts.set(t.selected_endpoint_id, (counts.get(t.selected_endpoint_id) ?? 0) + 1);
  }
  let best: { endpoint_id: string; uses: number } | undefined;
  for (const [endpoint_id, uses] of counts) {
    if (!best || uses > best.uses) best = { endpoint_id, uses };
  }
  return best;
}

export async function countPopularUnreviewedSkills(
  opts: PopularUnreviewedOptions = {},
): Promise<number> {
  const list = await getPopularUnreviewedSkills({ ...opts, limit: 1_000_000 });
  return list.length;
}

/**
 * Skills the named agent contributed to (as indexer or contributor),
 * each annotated with the local execution count for THIS process's
 * trace store. Used by `/v1/account/earnings?verbose=true` to surface
 * which captures are actually being executed.
 */
export interface MyContribution {
  skill_id: string;
  domain: string;
  role: "indexer" | "contributor";
  share?: number;
  endpoints_contributed?: number;
  local_execution_count: number;
  reviewed_at?: string;
}

export async function getMyContributions(agentId: string): Promise<MyContribution[]> {
  if (!agentId) return [];
  const skills = await client.listSkills();
  const out: MyContribution[] = [];
  for (const skill of skills) {
    const isIndexer = skill.indexer_id === agentId;
    const contributor = skill.contributors?.find((c) => c.agent_id === agentId);
    if (!isIndexer && !contributor) continue;
    const traces = skill.domain ? getRecentTraces(skill.domain, 1000) : [];
    const epIds = new Set((skill.endpoints ?? []).map((e) => e.endpoint_id));
    const localCount = traces.filter((t) => t.selected_endpoint_id && epIds.has(t.selected_endpoint_id)).length;
    out.push({
      skill_id: skill.skill_id,
      domain: skill.domain,
      role: isIndexer ? "indexer" : "contributor",
      ...(contributor ? { share: contributor.share, endpoints_contributed: contributor.endpoints_contributed } : {}),
      local_execution_count: localCount,
      ...(skill.reviewed_at ? { reviewed_at: skill.reviewed_at } : {}),
    });
  }
  out.sort((a, b) => b.local_execution_count - a.local_execution_count);
  return out;
}

/**
 * Pure milestone math for total earnings. the platform exposes the
 * truth (passed_usd, next_usd, progress_to_next_pct); the calling
 * agent decides whether to surface it to the user.
 */
export const EARNINGS_MILESTONES_USD = [1, 10, 100, 1000] as const;

export interface MilestoneState {
  passed_usd: number[];
  next_usd: number | null;
  progress_to_next_pct: number;
}

export function computeMilestoneState(totalUsd: number): MilestoneState {
  const passed = EARNINGS_MILESTONES_USD.filter((m) => totalUsd >= m);
  const next = EARNINGS_MILESTONES_USD.find((m) => totalUsd < m) ?? null;
  const progress = next ? Math.min(100, Math.round((totalUsd / next) * 100)) : 100;
  return { passed_usd: [...passed], next_usd: next, progress_to_next_pct: progress };
}
