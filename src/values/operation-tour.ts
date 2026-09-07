/**
 * operation-tour — multi-hop residual TSP over a skill operation_graph.
 *
 * Topological order (buildExecutionPlan) is the correctness spine for
 * prerequisite DAGs. orderTour adds a *cost* preference among siblings /
 * optional nodes when several orders are valid: prefer high-reliability
 * ops and existing dependency edges (cheap transitions).
 *
 * When a full topo order is required, pass only the topo-sorted ids and use
 * costBetween that heavily penalizes reversing edges — the tour then mostly
 * preserves topo while breaking ties by reliability.
 */

import { orderTour, type TourNode } from "./semantic-layer-walk.js";

/** Minimal edge surface — avoids hard dependency on full SkillOperationGraph types. */
export interface TourableEdge {
  from_operation_id: string;
  to_operation_id: string;
  kind?: string;
}

export interface TourableOperation {
  operation_id: string;
  /** 0–1 reliability if known; higher is cheaper to visit first among peers. */
  reliability_score?: number;
  /** Optional fixed visit cost override. */
  cost?: number;
}

export interface OperationTourInput {
  operations: readonly TourableOperation[];
  edges?: readonly TourableEdge[];
  /** Restrict tour to these operation_ids (e.g. prerequisite set). */
  include?: readonly string[];
  start?: string;
  twoOpt?: boolean;
}

/**
 * Cost between two ops:
 *  - forward dependency edge → 1
 *  - reverse edge → 100 (avoid undoing topo)
 *  - no edge → 10 + reliability penalty
 */
export function operationTransitionCost(
  from: string,
  to: string,
  edges: readonly TourableEdge[],
  reliability: Map<string, number>,
): number {
  let forward = false;
  let reverse = false;
  for (const e of edges) {
    const kind = e.kind ?? "dependency";
    if (kind !== "dependency" && kind !== "parent_child" && kind !== "auth") continue;
    if (e.from_operation_id === from && e.to_operation_id === to) forward = true;
    if (e.from_operation_id === to && e.to_operation_id === from) reverse = true;
  }
  if (forward) return 1;
  if (reverse) return 100;
  const relTo = reliability.get(to) ?? 0.5;
  // Prefer more reliable next hop (lower cost).
  return 10 + Math.round((1 - relTo) * 10);
}

/** Order operations as a cheapest open tour under graph edges + reliability. */
export function orderOperationTour(input: OperationTourInput): {
  order: string[];
  cost: number;
} {
  const include = input.include ? new Set(input.include) : null;
  const ops = input.operations.filter((o) => !include || include.has(o.operation_id));
  if (ops.length === 0) return { order: [], cost: 0 };

  const reliability = new Map(
    ops.map((o) => [o.operation_id, clamp01(o.reliability_score ?? 0.5)]),
  );
  const edges = input.edges ?? [];
  const nodes: TourNode[] = ops.map((o) => ({
    id: o.operation_id,
    // Lower visit cost for higher reliability (tie-break start).
    cost: o.cost ?? Math.round((1 - clamp01(o.reliability_score ?? 0.5)) * 5),
  }));

  return orderTour(
    nodes,
    (from, to) => operationTransitionCost(from, to, edges, reliability),
    { start: input.start, twoOpt: input.twoOpt !== false },
  );
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
