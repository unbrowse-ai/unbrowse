/**
 * Cloud-side /v1/contract/* HTTP route surface — stage A of organ
 * ddff0c96 (thin client over remote /contract harness).
 *
 * This is the SUBSTRATE EXPOSED AS HTTP. The thin client (stage B,
 * src/lib/contract-thin-client.ts) calls these routes and never speaks
 * to a local ledger; this Worker IS the ledger from the local's POV.
 * The KV/EmergentDB binding for persistence is a downstream stage; this
 * route file declares the surface and types so consumers can be wired
 * against it.
 *
 * The cloud holds the moat (compute, decision-trace, ranking, marketplace,
 * settlement, ledger). The local holds only pointers to capabilities
 * the cloud can't execute remotely (browser, cookies, vault, kuri binary).
 * See contract:50d0419e (pointers over payload) + contract:1db6f5e3
 * (local/cloud split).
 */

import type {
  ContractEventRow,
  ContractEventType,
  ContractLedger,
  ContractPointerType,
  SatisfiedCellMatch,
} from "../services/contract-ledger";
import { projectStatus, searchSatisfiedCells } from "../services/contract-ledger";

// ---------------------------------------------------------------------------
// Request / response shapes — the wire contract between thin client and cloud.
// Match these JSON shapes exactly in the consumer; drift here is a fake-
// witness violation (default #11 — every result traces to a real source).
// ---------------------------------------------------------------------------

/** POST /v1/contract/declare — register a new truth claim. */
export interface DeclareRequest {
  plan: string;
  action: string;
  pointer_type?: ContractPointerType;
  parent_id?: string;
  agent?: string;
  learning?: string;
}
export interface DeclareResponse {
  id: string;
  row: ContractEventRow;
}

/** POST /v1/contract/iterate — record an iterate wave + return next-step plan. */
export interface IterateRequest {
  id: string;
  /** Optional: locally-executed result the client returns when it
   *  satisfied a step requiring local capability. */
  local_result?: {
    capability: string;
    success: boolean;
    body?: unknown;
    error?: string;
  };
  agent?: string;
}

/** A step the local thin client may need to execute. When
 *  `required_local_capabilities` is empty, the cloud has executed the
 *  whole step and `result` carries the payload. Otherwise the client
 *  invokes its local dispatcher and POSTs the result back. */
export interface IterateStep {
  step_id: string;
  description: string;
  required_local_capabilities: string[];
  cloud_payload?: unknown;
  result?: unknown;
}
export interface IterateResponse {
  id: string;
  wave: number;
  /** Coarse machine verdict — "pass" | "fail" | "agent-judges". */
  action_result: string;
  /** Steps remaining the client must execute locally. Empty when the
   *  iterate completed without local capability requirements. */
  pending_local_steps: IterateStep[];
  /** Two-key exit prompt for the calling agent (KEY 2 stays agent-judged). */
  key2_prompt: string;
}

/** GET /v1/contract/status?id=… — projection of all events for the id. */
export interface StatusResponse {
  id: string;
  status: ReturnType<typeof projectStatus>;
  rows: ContractEventRow[];
}

/** POST /v1/contract/plan-for-intent — given a free-text intent, return
 *  a ranked shortlist of cells whose plan matches the intent. This IS
 *  the search-as-resolve mapping (organ b9c8a64d stage 5) exposed over
 *  HTTP. Local thin-client calls this when an agent has an intent and
 *  needs to know which contract to iterate. */
export interface PlanForIntentRequest {
  intent: string;
  limit?: number;
}
export interface PlanForIntentResponse {
  matches: SatisfiedCellMatch[];
}

// ---------------------------------------------------------------------------
// Route handlers — pure projection over a ContractLedger implementation.
// The actual binding to a Worker env (DurableObject, KV, EmergentDB) lands
// in the next stage; these handlers are written against the interface so
// any concrete ledger can be plugged in.
// ---------------------------------------------------------------------------

/**
 * POST /v1/contract/declare — write one `declared` row.
 */
export async function handleDeclare(
  req: DeclareRequest,
  ledger: ContractLedger,
): Promise<DeclareResponse> {
  if (!req.plan || !req.action) {
    throw new Error("DeclareRequest requires both plan and action");
  }
  const id = generateContractId();
  const row: ContractEventRow = {
    event: "declared",
    id,
    ts: new Date().toISOString(),
    plan: req.plan,
    action: req.action,
    pointer_type: req.pointer_type ?? guessPointerType(req.action),
    parent_id: req.parent_id,
    agent: req.agent,
    learning: req.learning,
  };
  const persisted = await ledger.append(row);
  return { id, row: persisted };
}

/**
 * POST /v1/contract/iterate — run one wave + return a typed response
 * the thin client knows how to consume. The cloud carries the
 * action-spec; the local executes capability-bound steps; the cloud
 * appends the iterated row.
 */
export async function handleIterate(
  req: IterateRequest,
  ledger: ContractLedger,
): Promise<IterateResponse> {
  if (!req.id) throw new Error("IterateRequest requires id");
  const rows = await ledger.get(req.id);
  if (!rows) throw new Error(`contract ${req.id} not declared`);

  const priorWaves = rows.filter((r) => r.event === "iterated").length;
  const wave = priorWaves + 1;

  // Foundation: every iterate appends a wave row. Decision-trace
  // (action_result, pending_local_steps) is determined by the
  // contract's `action` field; that resolver lives in the next stage
  // and is referenced by this route, not inlined here.
  const persisted = await ledger.append({
    event: "iterated",
    id: req.id,
    ts: new Date().toISOString(),
    wave,
    action_exit: req.local_result?.success === false ? 1 : 0,
    action_result: req.local_result?.success === false ? "fail" : "pass",
    agent_verdict: null,
    agent: req.agent,
  });

  return {
    id: req.id,
    wave: persisted.wave ?? wave,
    action_result: persisted.action_result ?? "agent-judges",
    pending_local_steps: [],
    key2_prompt:
      "KEY 2 (agent): JUDGE — is this GENUINELY satisfied, or fake-green? If genuine → POST /v1/contract/mark {id}. Otherwise fix root cause then iterate again.",
  };
}

/**
 * GET /v1/contract/status?id=… — projection over all rows for the id.
 */
export async function handleStatus(
  id: string,
  ledger: ContractLedger,
): Promise<StatusResponse> {
  const rows = (await ledger.get(id)) ?? [];
  return { id, status: projectStatus(rows), rows };
}

/**
 * POST /v1/contract/plan-for-intent — ranked-shortlist over the
 * satisfied-cell corpus. The thin client posts the agent's intent; the
 * cloud returns the candidate cells whose truth claims the calling
 * LLM can pick from. This IS unbrowse resolve, made substrate-faithful.
 */
export async function handlePlanForIntent(
  req: PlanForIntentRequest,
  ledger: ContractLedger,
): Promise<PlanForIntentResponse> {
  if (!req.intent) throw new Error("PlanForIntentRequest requires intent");
  const all = await ledger.listAll({ showMerged: false });
  // Restrict to satisfied cells per the resolve-as-search mapping
  // (organ b9c8a64d stage 5).
  const satisfiedCellIds = new Set(
    all
      .filter((r) => r.event === "satisfied")
      .map((r) => r.id),
  );
  const candidates = all
    .filter(
      (r) =>
        r.event === "declared" &&
        satisfiedCellIds.has(r.id) &&
        typeof r.plan === "string",
    )
    .map((r) => ({ id: r.id, plan: r.plan as string }));
  const matches = searchSatisfiedCells(req.intent, candidates, { limit: req.limit });
  return { matches };
}

// ---------------------------------------------------------------------------
// Local helpers — no I/O.
// ---------------------------------------------------------------------------

function generateContractId(): string {
  // 8-hex ID matching contract_core.py's shape. Replace with a real
  // cryptographic source in the bound implementation; this is the
  // declared shape only.
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function guessPointerType(action: string): ContractPointerType {
  if (action === "sequence") return "sequence";
  if (action === "funnel" || action === "children-satisfy") return "funnel";
  if (action === "funnel-first") return "funnel-first";
  if (action === "agent-judges") return "agent-judges";
  if (action.startsWith("contract:")) return "contract-ref";
  if (action.startsWith("loop-until:")) return "loop";
  if (action.startsWith("harness:")) return "harness";
  if (action.startsWith("tool-guard:")) return "tool-guard";
  if (action.startsWith("quorum:")) return "quorum";
  if (action.startsWith("http://") || action.startsWith("https://")) return "api";
  return "cli";
}

/** Re-export the ContractEventType union so consumers can reference
 *  it without reaching into the services layer. */
export type { ContractEventType };

// ---------------------------------------------------------------------------
// Hono router — mounts the four handlers above onto a real Worker.
// The in-memory ledger here is per-request (no Worker state survives
// requests in this stage); the durable KV/EmergentDB binding lands in
// the next stage of organ ddff0c96. Routes are LIVE and respond with
// real shapes; persistence is the next layer.
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../types";

export const contractRoutes = new Hono<{ Bindings: Env }>();

/** Per-request in-memory ledger. Replace with a durable binding
 *  (KV/D1/EmergentDB) in the next stage — same interface, just persistent. */
function ephemeralLedger(): ContractLedger {
  const rows: ContractEventRow[] = [];
  return {
    async append(row) {
      const stamped = { ...row, ts: row.ts || new Date().toISOString() };
      rows.push(stamped);
      return stamped;
    },
    async get(id) {
      const hit = rows.filter((r) => r.id === id);
      return hit.length ? hit : null;
    },
    async listAll() {
      return rows.slice();
    },
    async listChildren(parentId) {
      return rows.filter((r) => r.parent_id === parentId);
    },
  };
}

contractRoutes.post("/contract/declare", async (c) => {
  const req = await c.req.json<DeclareRequest>();
  try {
    const result = await handleDeclare(req, ephemeralLedger());
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

contractRoutes.post("/contract/iterate", async (c) => {
  const req = await c.req.json<IterateRequest>();
  try {
    const result = await handleIterate(req, ephemeralLedger());
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

contractRoutes.get("/contract/status", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "?id query param required" }, 400);
  try {
    const result = await handleStatus(id, ephemeralLedger());
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

contractRoutes.post("/contract/plan-for-intent", async (c) => {
  const req = await c.req.json<PlanForIntentRequest>();
  try {
    const result = await handlePlanForIntent(req, ephemeralLedger());
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Self-introspection — what does the cloud /contract surface expose?
// Lets the thin client discover its tools without a hardcoded list.
contractRoutes.get("/contract/tools", (c) => {
  return c.json({
    routes: [
      { method: "POST", path: "/v1/contract/declare", purpose: "declare a new truth claim" },
      { method: "POST", path: "/v1/contract/iterate", purpose: "run one wave + return key2 prompt" },
      { method: "GET", path: "/v1/contract/status", purpose: "projection over all events for an id" },
      { method: "POST", path: "/v1/contract/plan-for-intent", purpose: "ranked shortlist over satisfied cells" },
      { method: "GET", path: "/v1/contract/tools", purpose: "self-introspect (this endpoint)" },
    ],
    local_capabilities: ["kuri", "cookies", "vault", "browser", "fs"],
    persistence_note:
      "this stage is per-request in-memory; durable ledger binding lands in organ ddff0c96 stage D",
  });
});
