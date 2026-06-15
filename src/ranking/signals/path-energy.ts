/**
 * src/ranking/signals/path-energy.ts — the fractal layer over the route ranker.
 *
 * Layer 1 (ledger-energy) and layer 3 (learned-energy) score ONE hop: how reliable is this
 * single route? `routeEnergy(domain, endpoint, source, intent)` ∈ [0,1] ≈ P(this hop succeeds).
 * But a real task walks a CHAIN over the requires/yields DAG (login → token → feed): the value
 * a consumer needs is produced by an upstream operation. The reliability of the WHOLE chain is
 * not the best hop — it is the weakest link. A greedy ranker that picks the single best-looking
 * endpoint will happily route through a chain with one 0.2 hop.
 *
 * `chainEnergy` composes the SAME per-hop primitive up the dependency DAG, self-similarly:
 *   - a leaf op (no producers) → chainEnergy == routeEnergy (base case; identical at scale 1)
 *   - a chain → the product of its hops' success probs = exp(−Σ −log(hop)) over the prerequisite
 *     sub-DAG. In log-space this is Bellman/Viterbi shortest-path with edge cost −log(routeEnergy),
 *     so the min-cost (max-reliability) chain is selected — dynamic programming on the graph.
 *
 * This is the biological shape (Gen 41:48 — every field's yield gathered into its city, cities
 * into Egypt: the same gather op at every scale; Friston's free-energy — each layer minimises the
 * same energy and surprise sums up the hierarchy). Local settlement is BOUNDED at depth 7 and then
 * escalates (the prerequisite is treated as a settled leaf), matching the bounded-settlement /
 * break-at-7 rule (Gen 2:2). Cycles short-circuit on a visited-set: bounded + deterministic, never
 * exact past a back-edge, never a crash.
 *
 * The producer→consumer edges this walks are the ones buildSkillOperationGraph auto-generates
 * (the localStorage/requires-yields wiring). hopEnergy is injectable for deterministic witnesses;
 * production passes none and the real routeEnergy primitive is used unchanged.
 */
import { routeEnergy } from "./learned-energy.js";

export interface ChainNode {
  endpoint_id: string;
  source?: string;
  requires?: Array<{ key: string }>;
  provides?: Array<{ key: string; type?: string }>;
}
export interface ChainEdge {
  from_operation_id: string;
  to_operation_id: string;
  binding_key?: string;
}
export interface ChainGraph {
  operations: ChainNode[];
  edges?: ChainEdge[];
}

/** Gen 2:2 — local settlement is bounded; prerequisites deeper than this escalate (settle as leaf). */
const MAX_DEPTH = 7;
const EPS = 1e-6;

export type HopEnergy = (op: ChainNode) => number;

/**
 * Composed reliability of the WHOLE prerequisite chain ending at `targetOpId`, in [0,1].
 * Reuses routeEnergy as the per-hop primitive (the fractal leaf). Bounded recursion + memo + a
 * visited-set make it total and deterministic on any graph (DAG → exact; cycles → bounded).
 *
 * @param opts.hopEnergy injected per-hop energy (default: the real routeEnergy with domain/intent).
 */
export function chainEnergy(
  graph: ChainGraph,
  targetOpId: string,
  opts?: { domain?: string; intent?: string; hopEnergy?: HopEnergy },
): number {
  const ops = new Map(graph.operations.map((o) => [o.endpoint_id, o]));
  const edges = graph.edges ?? [];
  const domain = opts?.domain ?? "";
  const intent = opts?.intent ?? "";
  const hop: HopEnergy =
    opts?.hopEnergy ?? ((o) => routeEnergy(domain, o.endpoint_id, o.source, intent));
  const memo = new Map<string, number>();

  // cost(op) = −log( P(success of the prerequisite chain ending at op) ). Additive in log-space
  // = Bellman/Viterbi over edge cost −log(routeEnergy). chainEnergy = exp(−cost).
  function cost(opId: string, depth: number, seen: Set<string>): number {
    const cached = memo.get(opId);
    if (cached !== undefined) return cached;
    const op = ops.get(opId);
    if (!op) return 0; // unknown producer → no constraint on the chain
    const e = Math.max(EPS, Math.min(1, hop(op)));
    const local = -Math.log(e);
    // escalate: at the depth bound or on a back-edge, settle this op as a leaf (local cost only)
    if (depth >= MAX_DEPTH || seen.has(opId)) {
      memo.set(opId, local);
      return local;
    }
    const seen2 = new Set(seen);
    seen2.add(opId);
    // producers feeding THIS op (edges whose consumer is op); dedup so a producer feeding many keys counts once
    const producers = new Set(
      edges.filter((x) => x.to_operation_id === opId).map((x) => x.from_operation_id),
    );
    let pre = 0;
    for (const p of producers) pre += cost(p, depth + 1, seen2);
    const total = local + pre;
    memo.set(opId, total);
    return total;
  }

  return Math.exp(-cost(targetOpId, 0, new Set()));
}

/**
 * Rank candidate target operations by the reliability of their WHOLE chain (descending). This is
 * the selection greedy per-hop ranking cannot make: a target with a great leaf but one weak
 * upstream hop ranks below a modest leaf whose chain has no weak link.
 */
export function rankByChainEnergy(
  graph: ChainGraph,
  targetOpIds: string[],
  opts?: { domain?: string; intent?: string; hopEnergy?: HopEnergy },
): Array<{ opId: string; energy: number }> {
  return targetOpIds
    .map((opId) => ({ opId, energy: chainEnergy(graph, opId, opts) }))
    .sort((a, b) => b.energy - a.energy);
}
