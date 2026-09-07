/**
 * contract-shape (backend copy) — the SAME pure three-shape verdict the CLI uses, tuned for the
 * backend's API-response shape. Every backend op settles as a /contract: interpret (an op was
 * named: path/route/op) → verify (a target/route is present) → adjudicate (the op succeeded).
 *
 * A separate copy ON PURPOSE: the backend is its own CF-worker deploy artifact and cannot import
 * the CLI's src/. The SHAPE (ContractVerdict) is the canonical /contract verdict — identical to
 * src/values/contract-shape.ts and frontend/src/lib/contract-shape.ts. Pure, dependency-free,
 * never throws — safe to attach to any response.
 */

export interface ContractVerdict {
  terminal: boolean;
  settled: string[];
  frontier: string | null;
  engine: "native" | "fallback";
}

const SPINE = ["interpret", "verify", "adjudicate"] as const;

/** Derive the verdict from a backend response envelope, structurally (not a per-route list). */
export function contractVerdictFromEnvelope(data: Record<string, unknown>): ContractVerdict {
  const settled: string[] = [];
  const hasOp = !!(data.op || data.route || data.path || data.subcommand || data.kind);
  if (hasOp) settled.push("interpret");

  const hasRoute = !!(
    data.url || data.path || data.route || data.endpoint_id || data.domain || data.id || data.api_base
  );
  if (hasOp && hasRoute) settled.push("verify");

  const status = typeof data.status === "number" ? (data.status as number) : undefined;
  const ok = data.ok === true || (status !== undefined && status < 400);
  if (hasOp && hasRoute && ok) settled.push("adjudicate");

  const frontier = SPINE.find((s) => !settled.includes(s)) ?? null;
  return { terminal: settled.length === SPINE.length, settled, frontier, engine: "fallback" };
}
