/**
 * hole-harness — P3 of the hole-descent-dag: the CLI is a HARNESS. It SURFACES, per
 * hole, the candidate producers (with shape + reason, INCLUDING rejected ones) so the
 * user's own in-thread agent can MAP the dep — the harness never auto-decides. And it
 * GATES publish on that map: a hole the agent declared producer-filled (fill="dep") but
 * never mapped is under-determined, and publish is refused until the agent maps it.
 *
 * "harness collects, agent judges" + "judge the routing, don't force pipes": no hard
 * exclusion silently hides a candidate — every producer is surfaced, admissible or not,
 * with the reason, and the agent picks.
 */
import type { BindingGraph } from "./hole-binding.js";
import type { Hole } from "../../capture/hole-template.js";
import type { DescentLayer } from "../../values/signed-descent.js";

/** One surfaced candidate producer for a hole — admissible or rejected, always with a
 *  reason. The harness presents the whole set; the agent judges which to bind. */
export interface HoleCandidate {
  producer: string;
  binding: string;
  layer?: DescentLayer;
  admissible: boolean;
  reason: string;
}

/**
 * Surface ALL producers for `hole` on `consumerId`: which yield the binding (admissible,
 * edge-bound or free) and which do not (rejected, with what they DO yield). Collect +
 * surface only — no auto-pick, no silent hard-exclusion. The agent reads this and maps.
 */
export function surfaceCandidates(
  hole: Pick<Hole, "name">,
  consumerId: string,
  graph: BindingGraph,
): HoleCandidate[] {
  const nodes = Array.isArray(graph?.endpoints) ? graph.endpoints : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const out: HoleCandidate[] = [];
  for (const n of nodes) {
    if (n.endpoint_id === consumerId) continue;
    const provides = (n.provides ?? []).includes(hole.name);
    const hasEdge = edges.some((e) => e.from === n.endpoint_id && e.binding === hole.name && e.to === consumerId);
    if (provides && hasEdge) {
      out.push({ producer: n.endpoint_id, binding: hole.name, admissible: true, reason: "explicit edge: producer yields this binding to this consumer" });
    } else if (provides) {
      out.push({ producer: n.endpoint_id, binding: hole.name, admissible: true, reason: "yields this binding (no explicit edge — agent may bind it)" });
    } else {
      const yields = (n.provides ?? []).join(", ") || "nothing";
      out.push({ producer: n.endpoint_id, binding: hole.name, admissible: false, reason: `does not yield "${hole.name}" (yields: ${yields})` });
    }
  }
  return out;
}

/** A hole is DETERMINED (publishable) if it can be filled: vault/llm at runtime, or — when
 *  declared producer-filled (fill="dep") — it actually carries its mapped dep edge. */
export function isHoleDetermined(hole: Hole): boolean {
  if (hole.fill === "dep") return !!hole.dep;
  return hole.fill === "vault" || hole.fill === "llm";
}

/**
 * Publish gate: the agent must map every producer-fill hole before publish. Returns the
 * names of under-determined holes; publish is refused (ready=false) while any remain.
 * This is what makes "the agent maps the deps BEFORE publish" a runnable precondition,
 * not a convention.
 */
export function publishReadiness(holes: Hole[]): { ready: boolean; unmapped: string[] } {
  const unmapped = holes.filter((h) => !isHoleDetermined(h)).map((h) => h.name);
  return { ready: unmapped.length === 0, unmapped };
}
