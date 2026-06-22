/**
 * contract-shape (frontend copy) — the SAME pure three-shape verdict the CLI + backend use, so the
 * frontend layer reads/renders any operation as a /contract: interpret (an op/route is named) →
 * verify (a target is present) → adjudicate (it succeeded). A separate copy ON PURPOSE: the
 * frontend is its own CF-worker deploy artifact and cannot import the CLI's src/ or the backend's.
 * The SHAPE (ContractVerdict) is the canonical /contract verdict — identical across all three.
 * Pure, dependency-free, never throws.
 */

export interface ContractVerdict {
  terminal: boolean;
  settled: string[];
  frontier: string | null;
  engine: "native" | "fallback";
}

const SPINE = ["interpret", "verify", "adjudicate"] as const;

/** Derive the three-shape verdict from any contract/API object the frontend renders. */
export function contractVerdictFromEnvelope(data: Record<string, unknown>): ContractVerdict {
  const settled: string[] = [];
  const hasOp = !!(data.op || data.route || data.path || data.subcommand || data.kind || data.id);
  if (hasOp) settled.push("interpret");

  const hasRoute = !!(data.url || data.path || data.route || data.endpoint_id || data.domain || data.id);
  if (hasOp && hasRoute) settled.push("verify");

  const status = typeof data.status === "number" ? (data.status as number) : undefined;
  const ok = data.ok === true || (status !== undefined && status < 400);
  if (hasOp && hasRoute && ok) settled.push("adjudicate");

  const frontier = SPINE.find((s) => !settled.includes(s)) ?? null;
  return { terminal: settled.length === SPINE.length, settled, frontier, engine: "fallback" };
}

/** A human label for a verdict — for rendering a /contract status badge on any surface. */
export function verdictLabel(v: ContractVerdict): string {
  return v.terminal ? "settled" : `pending:${v.frontier ?? "interpret"}`;
}
