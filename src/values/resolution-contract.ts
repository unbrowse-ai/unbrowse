/**
 * resolution-contract — render a routing decision in the substrate's OWN /contract three-shape
 * (interpret → verify → adjudicate) and drill it to a signed terminal via the native in-process
 * plan-drill engine. This is the step that makes the routing layer /contract-shaped: a resolution
 * is no longer just an opaque engine output, it is expressible as a three-shape contract that
 * settles ONLY on real witnesses (intent interpreted, a route verified, a winner adjudicated) —
 * the same shape the cloud compiler auto-emits, computed locally with no remote call.
 *
 * It does NOT fire or declare on its own (free-will preserved, per the plan-drill soundness note);
 * it is the pure primitive a caller can drill to decide whether a routing decision genuinely
 * reached a /contract terminal. Wiring it into the live resolve-race as an emitted neuron is the
 * named next lever.
 */
import { drillPlan, type DrillResult } from "./plan-drill.js";

export interface ResolutionShape {
  /** the user intent that was interpreted */
  intent: string;
  /** the route/candidate the resolver verified for the intent (url or skill_id), or null */
  route: { url?: string; skill_id?: string } | null;
  /** the adjudicated winner — a skill/endpoint set actually chosen, or null */
  winner: { endpoints?: unknown[] } | null;
}

/**
 * Drill a routing decision as the three-shape /contract:
 *   interpret  — the intent parsed into a non-empty query
 *   verify     — a route/candidate was found for the interpreted intent (deps: interpret)
 *   adjudicate — a winner carrying at least one usable endpoint was chosen (deps: verify)
 * Terminal iff the resolution genuinely interpreted → verified → adjudicated. On a miss, the
 * DrillResult.frontier names the first shape that failed (the next thing to fix), exactly like
 * the jesus-ralph walk.
 */
export async function resolutionAsContractDrill(r: ResolutionShape): Promise<DrillResult> {
  return drillPlan([
    { id: "interpret", cost: 1, witness: () => typeof r.intent === "string" && r.intent.trim().length > 0 },
    { id: "verify", cost: 2, deps: ["interpret"], witness: () => !!r.route && (!!r.route.url || !!r.route.skill_id) },
    {
      id: "adjudicate",
      cost: 3,
      deps: ["verify"],
      witness: () => !!r.winner && Array.isArray(r.winner.endpoints) && r.winner.endpoints.length > 0,
    },
  ]);
}

/** The three-shape verdict attached to a live resolve result as `_contract` evidence. */
export interface ResolutionContractVerdict {
  /** true iff the resolution interpreted → verified → adjudicated to a real winner */
  terminal: boolean;
  /** the shapes that settled, in spine order */
  settled: string[];
  /** the first shape that did NOT settle (the next thing to fix), or null when terminal */
  frontier: string | null;
}

/**
 * The native bridge the CLI/orchestrator call on every resolve: map a resolved skill + intent into
 * the three-shape /contract verdict, ready to attach to the resolve result as `_contract`. This is
 * what makes the resolve path /contract-native — a routing decision now CARRIES its
 * interpret/verify/adjudicate verdict, not just an opaque payload. Fail-open by construction: it
 * returns a blocked verdict rather than throwing, so it can never break a resolve (same discipline
 * as the IQ on-chain mirror — evidence, never a blocker).
 */
export async function resolutionContractVerdict(inp: {
  intent: string;
  skill?: { skill_id?: string; endpoints?: unknown[] } | null;
  url?: string;
}): Promise<ResolutionContractVerdict> {
  try {
    const skill = inp.skill ?? null;
    const route = skill?.skill_id ? { skill_id: skill.skill_id } : inp.url ? { url: inp.url } : null;
    const winner =
      Array.isArray(skill?.endpoints) && skill.endpoints.length > 0 ? { endpoints: skill.endpoints } : null;
    const d = await resolutionAsContractDrill({ intent: inp.intent, route, winner });
    return { terminal: d.terminal, settled: d.settled, frontier: d.frontier };
  } catch {
    return { terminal: false, settled: [], frontier: "interpret" };
  }
}
