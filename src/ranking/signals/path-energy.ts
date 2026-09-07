/**
 * src/ranking/signals/path-energy.ts — the CLIENT fractal layer. Delegates the composition to the
 * fs-free path-energy-core and defaults the per-hop energy to the client routeEnergy (fs ledger +
 * learned head). The server injects its own fs-free hopEnergy and calls the core directly.
 *
 * The route ranker scores ONE hop (routeEnergy ≈ P(this route succeeds)); a real task walks a CHAIN
 * over the producer→consumer DAG (login → token → feed), and a chain is only as reliable as its
 * weakest link — so greedy per-hop ranking happily routes through a chain with one bad hop. chainEnergy
 * composes the same primitive up the DAG (leaf == routeEnergy; a chain == product of hops). The edges
 * are the ones buildSkillOperationGraph auto-generates.
 */
import { routeEnergy } from "./learned-energy.js";
import { composeChainEnergy, type ChainGraph, type ChainNode, type HopEnergy } from "./path-energy-core.js";

export type { ChainGraph, ChainNode, ChainEdge, HopEnergy } from "./path-energy-core.js";

/**
 * Composed reliability of the whole prerequisite chain ending at `targetOpId`. hopEnergy defaults to
 * the client routeEnergy (fs ledger + learned head); inject it for deterministic witnesses.
 */
export function chainEnergy(
  graph: ChainGraph,
  targetOpId: string,
  opts?: { domain?: string; intent?: string; hopEnergy?: HopEnergy },
): number {
  const domain = opts?.domain ?? "";
  const intent = opts?.intent ?? "";
  const hop: HopEnergy =
    opts?.hopEnergy ?? ((o: ChainNode) => routeEnergy(domain, o.endpoint_id, o.source, intent));
  return composeChainEnergy(graph, targetOpId, hop);
}

/** Rank candidate target operations by the reliability of their WHOLE chain (descending). */
export function rankByChainEnergy(
  graph: ChainGraph,
  targetOpIds: string[],
  opts?: { domain?: string; intent?: string; hopEnergy?: HopEnergy },
): Array<{ opId: string; energy: number }> {
  return targetOpIds
    .map((opId) => ({ opId, energy: chainEnergy(graph, opId, opts) }))
    .sort((a, b) => b.energy - a.energy);
}
