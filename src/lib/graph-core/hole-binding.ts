/**
 * hole-binding — which hole fits into which (Ex 28:32: "a binding of woven work around its hole,
 * that it not be torn"). A consumer endpoint's required HOLE is filled by a producer's YIELD. When
 * two producers yield the same key, an ambient first-by-key match TEARS (binds the wrong value); the
 * explicit dependency EDGE {from, binding, to} disambiguates — feed.token ← loginB.token, not loginA.
 *
 * Pure + fs-free: it decides WHICH producer fills a hole given the graph + the already-extracted
 * yields. The orchestrator adapts its OperationBinding[] / prerequisite walk to this shape and threads
 * the resolved values; a value change is caught by valueSetPointer over the bound set (the cascade).
 */

export interface BindingNode {
  endpoint_id: string;
  /** binding keys this endpoint PROVIDES (yields). */
  provides?: string[];
  /** binding keys this endpoint REQUIRES (its holes). */
  requires?: string[];
}
export interface BindingEdge {
  /** producer endpoint_id (yields the binding). */
  from: string;
  /** the binding key carried across the edge (producer's yield → consumer's hole). */
  binding: string;
  /** consumer endpoint_id (the hole). */
  to: string;
}
export interface BindingGraph {
  endpoints: BindingNode[];
  edges: BindingEdge[];
}

export interface ResolvedBinding {
  /** the producer endpoint whose yield fills the hole. */
  producer: string;
  /** the value that fills the hole (scalar; an array/object yield threads its first scalar upstream). */
  value: unknown;
}

/**
 * Resolve which producer's yield fills `param` (a hole) on `consumerId`.
 *
 * 1. EXPLICIT EDGE wins: an edge `{from, binding: param, to: consumerId}` binds the hole to `from`
 *    unambiguously — even if other producers also yield `param`. This is the "which hole fits which".
 * 2. FALLBACK (no edge): the first producer in `order` (else graph order) that PROVIDES `param`.
 *    Preserves the prior ambient-match behaviour when the graph carries no explicit edge.
 *
 * Returns null when no producer provides the key, or the chosen producer has no extracted value for
 * it (the caller then defers to LLM/agent fill). Deterministic; no clock, no fs.
 */
export function resolveHoleBinding(
  param: string,
  consumerId: string,
  graph: BindingGraph,
  yields: Record<string, Record<string, unknown>>,
  order?: string[],
): ResolvedBinding | null {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodes = Array.isArray(graph?.endpoints) ? graph.endpoints : [];

  // 1) explicit edge — the binding around the hole, so it is not torn.
  const edge = edges.find((e) => e.to === consumerId && e.binding === param);
  let producer: string | undefined = edge?.from;

  // 2) fallback — first provider in dependency order (or graph order).
  if (!producer) {
    const provides = (id: string) => nodes.find((n) => n.endpoint_id === id)?.provides ?? [];
    const search = order && order.length ? order : nodes.map((n) => n.endpoint_id);
    producer = search.find((id) => provides(id).includes(param));
  }
  if (!producer) return null;

  const raw = yields[producer]?.[param];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null) return null;
  return { producer, value };
}

/**
 * Pre-execution: which producer endpoint SHOULD be run to fill `param` on `consumerId`. Same edge-first,
 * order-fallback rule as resolveHoleBinding, but it returns the producer BEFORE its yield exists (so the
 * walker knows which prerequisite to execute). null = no producer found (defer to LLM/agent fill).
 */
export function selectHoleProducer(
  param: string,
  consumerId: string,
  graph: BindingGraph,
  order?: string[],
): string | null {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const edge = edges.find((e) => e.to === consumerId && e.binding === param);
  if (edge?.from) return edge.from;
  const nodes = Array.isArray(graph?.endpoints) ? graph.endpoints : [];
  const provides = (id: string) => nodes.find((n) => n.endpoint_id === id)?.provides ?? [];
  const search = order && order.length ? order : nodes.map((n) => n.endpoint_id);
  return search.find((id) => provides(id).includes(param)) ?? null;
}

/**
 * Bridge — connect a request-skeleton HOLE (src/capture/hole-template.ts) to the
 * operation DAG. The hole's `name` is the binding key; resolveHoleBinding decides
 * which producer at the layer below yields it. This is the edge the Explore map
 * flagged missing (hole↔DAG was PAPER-ONLY): a hole filled not from vault/llm but
 * from another operation's output — the first thread of the cross-layer dep spine.
 * Type-only import of Hole/HoleDep keeps this one-directional (no runtime cycle).
 */
import type { Hole, HoleDep } from "../../capture/hole-template.js";

/** Resolve which producer fills `hole` (by its name) on `consumerId`, via the DAG. */
export function resolveHoleDep(
  hole: Pick<Hole, "name">,
  consumerId: string,
  graph: BindingGraph,
  yields: Record<string, Record<string, unknown>>,
  order?: string[],
): ResolvedBinding | null {
  return resolveHoleBinding(hole.name, consumerId, graph, yields, order);
}

/**
 * Route a set of holes against the DAG: for each hole whose name a producer yields,
 * stamp the routing edge (`dep` + fill="dep") and collect the fill value. Holes with
 * no producer are left untouched (they stay vault/llm). Returns the annotated holes
 * (NEW objects; input not mutated) + the fills map keyed by hole.name — the agent's
 * judged map, made concrete and persistable.
 */
export function routeHoles(
  holes: Hole[],
  consumerId: string,
  graph: BindingGraph,
  yields: Record<string, Record<string, unknown>>,
  order?: string[],
): { holes: Hole[]; fills: Record<string, unknown> } {
  const fills: Record<string, unknown> = {};
  const out = holes.map((h) => {
    const r = resolveHoleBinding(h.name, consumerId, graph, yields, order);
    if (!r) return h;
    const dep: HoleDep = { producer: r.producer, binding: h.name };
    fills[h.name] = r.value;
    return { ...h, fill: "dep" as const, dep };
  });
  return { holes: out, fills };
}

/** Minimal shape of the skill's operation_graph this adapter reads (endpoint_id-keyed, not op-id). */
interface OpGraphLike {
  operations?: Array<{ operation_id?: string; endpoint_id?: string; requires?: unknown; provides?: unknown }>;
  edges?: Array<{ from_operation_id?: string; to_operation_id?: string; binding_key?: string }>;
}

/**
 * Adapt a skill's `operation_graph` (operation_id-keyed, with SkillOperationEdge edges) into the
 * endpoint_id-keyed BindingGraph this module reasons over. Edges whose endpoints map to known
 * operations become explicit `{from, binding, to}` bindings — the disambiguators. Tolerant of missing
 * fields (returns empty graph) so a skill without an operation_graph falls back to order-based binding.
 */
export function bindingGraphFromOperationGraph(og: OpGraphLike | undefined | null): BindingGraph {
  const ops = Array.isArray(og?.operations) ? og!.operations : [];
  const opIdToEndpoint = new Map<string, string>();
  for (const o of ops) if (o.operation_id && o.endpoint_id) opIdToEndpoint.set(o.operation_id, o.endpoint_id);
  const endpoints: BindingNode[] = ops
    .filter((o) => o.endpoint_id)
    .map((o) => ({
      endpoint_id: o.endpoint_id as string,
      provides: Array.isArray(o.provides) ? (o.provides as unknown[]).map(String) : [],
      requires: Array.isArray(o.requires) ? (o.requires as unknown[]).map(String) : [],
    }));
  const edges: BindingEdge[] = [];
  for (const e of Array.isArray(og?.edges) ? og!.edges : []) {
    const from = e.from_operation_id ? opIdToEndpoint.get(e.from_operation_id) : undefined;
    const to = e.to_operation_id ? opIdToEndpoint.get(e.to_operation_id) : undefined;
    if (from && to && e.binding_key) edges.push({ from, binding: e.binding_key, to });
  }
  return { endpoints, edges };
}
