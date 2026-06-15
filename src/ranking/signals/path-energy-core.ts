/**
 * path-energy-core — the fs-free fractal composer. Composes a per-hop energy up the requires/yields
 * DAG with the SAME primitive at every scale (leaf op → chainEnergy == its hop energy; a chain →
 * product of hops = Bellman/Viterbi over -log(hop)). hopEnergy is REQUIRED (injected) here, so this
 * module imports nothing fs-bound and bundles into the worker. The client wrapper (path-energy.ts)
 * defaults hopEnergy to the fs-aware routeEnergy; the server injects a fs-free leaf.
 */
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
 * Composed reliability of the WHOLE prerequisite chain ending at `targetOpId`, in [0,1], using the
 * injected per-hop `hopEnergy`. Bounded recursion + memo + visited-set → total + deterministic on any
 * graph (DAG exact; cycles bounded). Leaf op (no producers) → hopEnergy(op) (self-similar base case).
 */
export function composeChainEnergy(graph: ChainGraph, targetOpId: string, hopEnergy: HopEnergy): number {
  // Defensive: the graph can be client-supplied (untrusted). `?? []` only catches null/undefined, so a
  // non-array operations/edges (e.g. a string) would throw on .map/.filter — guard with Array.isArray.
  const ops = new Map((Array.isArray(graph?.operations) ? graph.operations : []).map((o) => [o.endpoint_id, o]));
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const memo = new Map<string, number>();

  function cost(opId: string, depth: number, seen: Set<string>): number {
    const cached = memo.get(opId);
    if (cached !== undefined) return cached;
    const op = ops.get(opId);
    if (!op) return 0; // unknown producer → no constraint
    const e = Math.max(EPS, Math.min(1, hopEnergy(op)));
    const local = -Math.log(e);
    if (depth >= MAX_DEPTH || seen.has(opId)) {
      memo.set(opId, local);
      return local;
    }
    const seen2 = new Set(seen);
    seen2.add(opId);
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
