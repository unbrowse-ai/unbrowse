/**
 * contract-shape — the PURE, sync three-shape verdict derived from ANY CLI emit envelope.
 *
 * This is what makes the substrate "/contract shaped all the way through": instead of wiring
 * the interpret→verify→adjudicate verdict into each of the ~15 breath primitives by hand
 * (leaven — Synapse-kind minimum, Matt 5:37; and a hard per-primitive list violates
 * "never a hard filter when a structural signal exists"), the shared emit() boundary attaches
 * this verdict to EVERY envelope from its universal shape. Zero per-primitive entries; a new
 * primitive is /contract-shaped for free the moment it emits.
 *
 * Kept dependency-free ON PURPOSE: emit() is on every command's hot path, so this must NOT drag
 * the native bun:ffi substrate (contract-native) into universal output. The hot paths that want
 * the native bible-anchor enrichment (resolve, execute) compute their OWN richer verdict via
 * resolution-contract.ts and set `_contract` themselves; emit() never overwrites an existing one.
 */

export interface ContractVerdict {
  /** true iff the op interpreted → verified a route/target → adjudicated a real success */
  terminal: boolean;
  /** the shapes that settled, in spine order */
  settled: string[];
  /** the first shape that did NOT settle (the next thing to fix), or null when terminal */
  frontier: string | null;
  /** "fallback" = pure-shape (this module); "native" = bible-anchor-enriched (resolution-contract) */
  engine: "native" | "fallback";
}

const SPINE = ["interpret", "verify", "adjudicate"] as const;

/**
 * Derive the three-shape verdict from a universal CLI emit envelope, structurally (not by a
 * per-primitive name list):
 *   interpret  — an operation was named (the envelope has a subcommand)
 *   verify     — a route/target/collection is present (url | endpoint | domain | session | shortlist | …)
 *   adjudicate — the op actually succeeded (ok === true)
 * Pure + never throws.
 */
export function contractVerdictFromEnvelope(data: Record<string, unknown>): ContractVerdict {
  const settled: string[] = [];
  const hasOp = typeof data.subcommand === "string" && (data.subcommand as string).length > 0;
  if (hasOp) settled.push("interpret");

  const shortlist = data.shortlist;
  const hasRoute = !!(
    data.url ||
    data.endpoint_id ||
    data.domain ||
    data.session_id ||
    data.api_base ||
    data.ctx_url ||
    (Array.isArray(shortlist) && shortlist.length > 0)
  );
  if (hasOp && hasRoute) settled.push("verify");

  if (hasOp && hasRoute && data.ok === true) settled.push("adjudicate");

  const frontier = SPINE.find((s) => !settled.includes(s)) ?? null;
  return { terminal: settled.length === SPINE.length, settled, frontier, engine: "fallback" };
}
