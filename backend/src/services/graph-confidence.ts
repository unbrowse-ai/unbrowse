/**
 * Server-authoritative operation-graph edge-confidence store (the DAG moat).
 *
 * Memory: project_dag_recompute_north_star. "Edge confidences are
 * online-learned and propagated to the marketplace." This service is where
 * that learning lives, server-side, aggregated ACROSS ALL AGENTS.
 *
 * What stays on the client: the graph WALK at execute time (it drives the
 * real HTTP/browser with the user's auth context) and the structural
 * `buildSkillOperationGraph` topology. Those do NOT move.
 *
 * What moved here: the cross-user confidence LEARNING and the aggregate
 * store. The client sends already-sanitized per-execution edge outcomes UP
 * (no secrets, no payloads, no auth context; just
 * domain/edge_id/outcome). It receives the PROJECTED confidence DOWN at
 * resolve. A forked client never sees the per-domain success/total
 * counters, the prior, or this projection function. It can only observe
 * the single number for the specific edges it asks about. It cannot
 * reconstruct the cross-user posterior it never sees.
 *
 * Substrate principle (CLAUDE.md): the projected confidence is
 * EVIDENCE-derived (a smoothed posterior mean over OBSERVED success/total
 * across all agents), never a prescribed constant. The prior is the only
 * non-observed term and it is the neutral Beta(1,1) Laplace prior, not an
 * opinion about any specific domain or edge.
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

/** One sanitized edge outcome reported by a client after an execution. */
export interface EdgeOutcomeSignal {
  /** Operation-graph edge id (`<from>:<to>:<binding_key>`). */
  edge_id: string;
  /** `true` when the execution that traversed this edge succeeded. */
  succeeded: boolean;
  /**
   * Optional explicit-negative weight. A judge-rejected result is a
   * stronger negative than a plain failure. `1` (default) = one
   * observation; `2` = counts as two failed observations. Clamped 1..4.
   */
  weight?: number;
}

/** The projection returned to the client at resolve. */
export interface EdgeConfidenceProjection {
  /** `edge_id -> server-authoritative confidence in [0,1]`. */
  confidences: Record<string, number>;
  /** `edge_id -> total observations` so the client can show evidence depth. */
  observations: Record<string, number>;
}

/** Per-edge aggregate counter persisted in statsKV. Cross-user. */
interface EdgeAggregate {
  /** Sum of successful observations across all agents. */
  succ: number;
  /** Sum of all observations across all agents. */
  total: number;
  /** Last-updated epoch ms (telemetry only, never a confidence input). */
  updated_at: number;
}

/** KV key for a domain's edge aggregate. Cross-user, never per-agent. */
function aggKey(domain: string, edgeId: string): string {
  return `gc:agg:${domain}:${edgeId}`;
}

function normalizeDomain(env: Env, domain: string): string {
  const clean = domain.replace(/^www\./, "").trim().toLowerCase();
  return env.ENVIRONMENT === "staging" ? `stg-${clean}` : clean;
}

/**
 * Project a confidence from OBSERVED outcomes.
 *
 * Posterior mean of a Beta(1,1) (Laplace / "rule of succession") prior
 * updated by the observed (succ, total): `(succ + 1) / (total + 2)`.
 *
 * - Zero observations -> 0.5 (maximum uncertainty, the neutral prior).
 * - All successes -> asymptotes toward 1.0 as evidence accumulates but
 *   never asserts certainty from thin evidence (1/1 -> 0.667, not 1.0).
 * - All failures -> asymptotes toward 0.0 the same way.
 *
 * This is evidence-derived: the only non-observed term is the neutral
 * +1/+2 Laplace prior, which is a uniform prior, not an opinion about any
 * domain or edge. No per-domain arm, no hardcoded confidence ladder.
 */
export function projectEdgeConfidence(succ: number, total: number): number {
  const s = Number.isFinite(succ) && succ >= 0 ? succ : 0;
  const t = Number.isFinite(total) && total >= s ? total : s;
  const posterior = (s + 1) / (t + 2);
  // Guard the [0,1] range against any float drift.
  return Math.max(0, Math.min(1, posterior));
}

async function readAggregate(env: Env, key: string): Promise<EdgeAggregate> {
  try {
    const raw = (await statsKV(env).get(key)) as string | null;
    if (!raw) return { succ: 0, total: 0, updated_at: 0 };
    const parsed = JSON.parse(raw) as Partial<EdgeAggregate>;
    const succ = Number.isFinite(parsed.succ) && (parsed.succ as number) >= 0 ? (parsed.succ as number) : 0;
    const total = Number.isFinite(parsed.total) && (parsed.total as number) >= succ ? (parsed.total as number) : succ;
    const updated_at = Number.isFinite(parsed.updated_at) ? (parsed.updated_at as number) : 0;
    return { succ, total, updated_at };
  } catch {
    return { succ: 0, total: 0, updated_at: 0 };
  }
}

async function writeAggregate(env: Env, key: string, agg: EdgeAggregate): Promise<void> {
  try {
    await statsKV(env).put(key, JSON.stringify(agg));
  } catch (err) {
    // Aggregation must never break the response; the projection still
    // returns last-known values; the client degrades to local fallback.
    console.warn(`[graph-confidence] failed to persist ${key}: ${(err as Error).message}`);
  }
}

function clampWeight(weight: number | undefined): number {
  if (!Number.isFinite(weight as number)) return 1;
  return Math.max(1, Math.min(4, Math.round(weight as number)));
}

/**
 * Ingest a batch of sanitized edge outcomes for a domain and return the
 * fresh cross-user projection for every edge touched.
 *
 * Read-modify-write per edge. KV has no CAS but per-domain-per-edge
 * collisions across the agent fleet are rare relative to the smoothing
 * window; the worst case is one delayed observation, which the posterior
 * absorbs. This mirrors the codebase's existing sponsor-spend rollup
 * pattern (`backend/src/middleware/sponsor.ts`).
 */
export async function ingestEdgeOutcomes(
  env: Env,
  domain: string,
  outcomes: EdgeOutcomeSignal[],
): Promise<EdgeConfidenceProjection> {
  const dom = normalizeDomain(env, domain);
  const confidences: Record<string, number> = {};
  const observations: Record<string, number> = {};

  // Collapse duplicate edge_ids in the batch so one read-modify-write per
  // distinct edge.
  const byEdge = new Map<string, { succ: number; total: number }>();
  for (const o of outcomes) {
    if (!o || typeof o.edge_id !== "string" || o.edge_id.length === 0) continue;
    const w = clampWeight(o.weight);
    const cur = byEdge.get(o.edge_id) ?? { succ: 0, total: 0 };
    cur.total += w;
    if (o.succeeded) cur.succ += w;
    byEdge.set(o.edge_id, cur);
  }

  for (const [edgeId, delta] of byEdge) {
    const key = aggKey(dom, edgeId);
    const prev = await readAggregate(env, key);
    const next: EdgeAggregate = {
      succ: prev.succ + delta.succ,
      total: prev.total + delta.total,
      updated_at: Date.now(),
    };
    await writeAggregate(env, key, next);
    confidences[edgeId] = projectEdgeConfidence(next.succ, next.total);
    observations[edgeId] = next.total;
  }

  return { confidences, observations };
}

/**
 * Read-only projection for a set of edge ids (no ingest). Used when the
 * client wants the latest cross-user confidence at resolve without
 * reporting an outcome. Edges with zero observations are returned at the
 * neutral prior so the client can still overlay a value.
 */
export async function projectConfidences(
  env: Env,
  domain: string,
  edgeIds: string[],
): Promise<EdgeConfidenceProjection> {
  const dom = normalizeDomain(env, domain);
  const confidences: Record<string, number> = {};
  const observations: Record<string, number> = {};
  const seen = new Set<string>();
  for (const edgeId of edgeIds) {
    if (typeof edgeId !== "string" || edgeId.length === 0 || seen.has(edgeId)) continue;
    seen.add(edgeId);
    const agg = await readAggregate(env, aggKey(dom, edgeId));
    confidences[edgeId] = projectEdgeConfidence(agg.succ, agg.total);
    observations[edgeId] = agg.total;
  }
  return { confidences, observations };
}
