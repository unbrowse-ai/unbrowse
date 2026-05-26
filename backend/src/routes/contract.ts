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
import { projectStatus, searchSatisfiedCells, isCallerInLineage } from "../services/contract-ledger";
import { verifyDeclareSignature, type CanonicalDeclareBody } from "../services/declare-signature";

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
  /**
   * Visibility class — see ContractEventRow.visibility. Default = "lineage"
   * (only lineage-chain callers can read via /v1/contract/status). Public
   * surfaces explicitly set "public" or "marketplace".
   *
   * Backwards compat: when the caller omits both wallet_identity AND
   * visibility, the row is treated as anonymous-public so unsigned writes
   * (pre-#33-signed-declare) don't lock themselves out.
   */
  visibility?: "lineage" | "public" | "marketplace";
  /** Ed25519 pubkey (hex) — binds this declare to a callable identity. */
  wallet_identity?: string;
  /** Ed25519 signature over the canonical declare body, signed by wallet_identity. */
  declare_signature?: string;
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

/**
 * POST /v1/contract/mirror — Π4 raw-row mirror endpoint.
 *
 * Accepts a *raw* ContractEventRow from a local /contract ledger (any
 * event type: declared / iterated / satisfied / spawned / merged /
 * crystallized / corroborated). The row IS the wire — per the schema
 * doctrine (Φ6+Φ7) translating into domain-typed wire shapes here
 * would force two sources of truth and drift the moment a new
 * event-type lands locally.
 *
 * `strip_pii=true` routes the row to the configured GLOBAL ledger
 * with identity fields stripped (agent, audience, parent_id) and text
 * fields email-redacted (plan, learning, reason). This is the moat
 * boundary — private rows stay private; the depersonalized projection
 * goes to the cross-project mirror so doctrine can propagate without
 * leaking sender identity.
 *
 * `strip_pii=false` (or absent) writes the row verbatim to the
 * caller's PRIVATE ledger — identity preserved, no global write.
 *
 * Idempotency: re-mirroring the same row.id replaces nothing at this
 * layer; the underlying ledger's append semantics govern (the durable
 * postgres binding uses ON CONFLICT DO NOTHING keyed on
 * (namespace, event_id) where event_id is a content hash). At the
 * in-memory layer the row is appended; downstream readers project
 * over all events and take the latest.
 */
export interface MirrorRequest {
  /** Full raw ContractEventRow as emitted by contract_core.py's _append. */
  row: ContractEventRow;
  /** When true, depersonalize + route to globalLedger. When falsey,
   *  write verbatim to the private (caller-bound) ledger. */
  strip_pii?: boolean;
}

export interface MirrorResponse {
  /** Always true on success — the row was written to a ledger. */
  mirrored: boolean;
  /** ISO-8601 timestamp the mirror call completed. */
  mirrored_at: string;
  /** Which ledger the row landed in. */
  routed_to: "private" | "global";
  /** The contract id this row is about — convenience echo. */
  contract_id: string;
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
  // Visibility coercion: anonymous declares (no wallet_identity) are
  // auto-public so the writer doesn't lock themselves out of reading their
  // own row. Wallet-bound declares default to "lineage" (default-hidden,
  // synaptic-specificity model). Explicit visibility wins over both.
  const visibility: "lineage" | "public" | "marketplace" =
    req.visibility ?? (req.wallet_identity ? "lineage" : "public");
  // Caller-supplied ts wins (signed declares need the ts the client signed
  // over to round-trip exactly); otherwise server stamps now.
  const callerTs = (req as { ts?: string }).ts;
  const row: ContractEventRow = {
    event: "declared",
    id,
    ts: callerTs || new Date().toISOString(),
    plan: req.plan,
    action: req.action,
    pointer_type: req.pointer_type ?? guessPointerType(req.action),
    parent_id: req.parent_id,
    agent: req.agent,
    learning: req.learning,
    visibility,
    wallet_identity: req.wallet_identity,
    declare_signature: req.declare_signature,
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
  opts: { caller_pubkey?: string | null } = {},
): Promise<StatusResponse> {
  const rows = (await ledger.get(id)) ?? [];
  if (rows.length === 0) {
    return { id, status: projectStatus(rows), rows };
  }
  // Pre-visibility-field rows (older than this PR) have no wallet_identity;
  // isCallerInLineage treats them as public to preserve back-compat. Newer
  // rows declared with wallet_identity bind to that pubkey.
  const declared = rows.find((r) => r.event === "declared") ?? rows[0];

  // Build parent walker — uses the same ledger reader so chained ancestry
  // checks against EmergentDB consistently. Cheap because lineage chains
  // are typically depth ≤ 5; uncached is fine.
  const parentCache = new Map<string, ContractEventRow | null>();
  const walkParent = (parentId: string): ContractEventRow | null => {
    if (parentCache.has(parentId)) return parentCache.get(parentId) ?? null;
    // Ledger.get returns rows for that id; we want the declared event row.
    // Sync API mismatch — we eagerly drain via Promise.resolve in the loop;
    // the walker stays sync via a pre-warm pass below.
    const cached = parentCache.get(parentId);
    return cached ?? null;
  };

  // Pre-warm the parent chain so the sync walker has data. Depth ≤ 8 hops.
  let cursor: string | undefined = declared.parent_id;
  let depth = 0;
  while (cursor && depth < 8 && !parentCache.has(cursor)) {
    const parentRows = (await ledger.get(cursor)) ?? [];
    const parentDeclared = parentRows.find((r) => r.event === "declared") ?? parentRows[0] ?? null;
    parentCache.set(cursor, parentDeclared);
    cursor = parentDeclared?.parent_id;
    depth++;
  }

  const visible = isCallerInLineage(declared, opts.caller_pubkey ?? null, walkParent);
  if (!visible) {
    // Synthetic empty — security-through-obscurity. Don't leak "exists but
    // forbidden" vs "doesn't exist". Mirrors npm's 404-on-no-publish-scope.
    return { id, status: "pending", rows: [] };
  }
  return { id, status: projectStatus(rows), rows };
}

/**
 * POST /v1/contract/mirror — Π4 cross-project mirror. See MirrorRequest
 * docstring above for the moat-boundary rationale (strip_pii=true
 * routes to globalLedger with identity stripped; strip_pii=false
 * writes verbatim to the caller's private ledger).
 *
 * Throws when:
 *   - req.row is missing or not an object
 *   - req.row lacks event or id (the two non-negotiable fields)
 *   - strip_pii=true but no globalLedger was provided (config gap
 *     surfaced honestly instead of silently swallowing the row)
 */
export async function handleMirror(
  req: MirrorRequest,
  privateLedger: ContractLedger,
  opts: { globalLedger?: ContractLedger } = {},
): Promise<MirrorResponse> {
  if (!req?.row || typeof req.row !== "object") {
    throw new Error("MirrorRequest requires { row: ContractEventRow }");
  }
  const row = req.row;
  if (!row.event || !row.id) {
    throw new Error("row must carry both event and id (any ContractEventType)");
  }

  const stripPii = req.strip_pii === true;

  if (stripPii) {
    if (!opts.globalLedger) {
      throw new Error(
        "strip_pii=true requires a global ledger to be configured; got none",
      );
    }
    const sanitized = depersonalizeRow(row);
    await opts.globalLedger.append(sanitized);
    return {
      mirrored: true,
      mirrored_at: new Date().toISOString(),
      routed_to: "global",
      contract_id: row.id,
    };
  }

  const stamped = { ...row, ts: row.ts || new Date().toISOString() };
  await privateLedger.append(stamped);
  return {
    mirrored: true,
    mirrored_at: new Date().toISOString(),
    routed_to: "private",
    contract_id: row.id,
  };
}

/** Strip identity fields and redact emails from a row destined for the
 *  global mirror. Identity stripping: agent, audience, parent_id are
 *  removed (they're sender-bound; the global view is project-blind).
 *  Text sanitization: email-shaped tokens in plan, learning, reason
 *  are replaced with `<redacted-email>`. Truth-claim fields (id, event,
 *  action, pointer_type, ts, wave, action_exit, action_result) are
 *  preserved unchanged — that's what doctrine propagation needs. */
function depersonalizeRow(row: ContractEventRow): ContractEventRow {
  // Allow extra fields like `audience` that the test passes via cast.
  const wide = row as ContractEventRow & {
    audience?: unknown;
  };
  const {
    agent: _agent,
    audience: _audience,
    parent_id: _parent,
    ...rest
  } = wide;

  const sanitized: ContractEventRow = {
    ...(rest as ContractEventRow),
  };
  if (typeof sanitized.plan === "string") {
    sanitized.plan = redactEmails(sanitized.plan);
  }
  if (typeof sanitized.learning === "string") {
    sanitized.learning = redactEmails(sanitized.learning);
  }
  if (typeof sanitized.reason === "string") {
    sanitized.reason = redactEmails(sanitized.reason);
  }
  if (!sanitized.ts) sanitized.ts = new Date().toISOString();
  return sanitized;
}

/** Replace anything that looks like an email with `<redacted-email>`. */
function redactEmails(text: string): string {
  return text.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "<redacted-email>",
  );
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
import type { Context } from "hono";
import type { Env } from "../types";

// Variables map kept generic for forward compatibility with middleware that
// pulls agent_id off the context (other routes in this codebase use the
// same pattern). The contract declare route itself doesn't consume it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContractRouteEnv = { Bindings: Env; Variables: any };
export const contractRoutes = new Hono<ContractRouteEnv>();

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

/**
 * Pure declare-auth result. Doesn't touch HTTP — the route handler maps
 * each kind to a Response. Extracted so the same auth verdict can be
 * consulted BEFORE the x402 gate (for onramp routing on identified
 * wallets) AND inside executeDeclare (for the actual write).
 */
type DeclareAuthResult =
  | { kind: "anonymous" }                                            // no wallet, no signature → coerce agent="anonymous"
  | { kind: "verified"; wallet_identity: string; ts: string }        // wallet+sig OK
  | { kind: "missing_signature" }                                    // wallet present, sig absent → 400
  | { kind: "invalid_signature" }                                    // wallet+sig present, sig didn't verify → 401
  | { kind: "signature_without_identity" };                          // sig present, wallet absent → 400

async function verifyDeclareAuth(req: DeclareRequest): Promise<DeclareAuthResult> {
  if (req.wallet_identity) {
    if (!req.declare_signature) return { kind: "missing_signature" };
    const ts = (req as { ts?: string }).ts ?? new Date().toISOString();
    const canonical: CanonicalDeclareBody = {
      plan: req.plan,
      action: req.action,
      parent_id: req.parent_id ?? null,
      agent: req.agent ?? null,
      wallet_identity: req.wallet_identity,
      ts,
    };
    const ok = await verifyDeclareSignature(canonical, req.declare_signature);
    if (!ok) return { kind: "invalid_signature" };
    return { kind: "verified", wallet_identity: req.wallet_identity, ts };
  }
  if (req.declare_signature) return { kind: "signature_without_identity" };
  return { kind: "anonymous" };
}

/**
 * Run the signed-declare gate + handleDeclare. Auth check is now factored
 * out into verifyDeclareAuth (above) so the route handler can pre-verify
 * and surface the wallet identity to the x402 gate. This function honors
 * a pre-verified ts when set and otherwise re-runs the auth check.
 */
async function executeDeclare(
  c: Context<ContractRouteEnv>,
  req: DeclareRequest,
): Promise<Response> {
  try {
    const auth = await verifyDeclareAuth(req);
    switch (auth.kind) {
      case "missing_signature":
        return c.json(
          {
            error:
              "declare_signature required when wallet_identity is set — sign the canonical body with the matching ed25519 private key",
          },
          400,
        );
      case "invalid_signature":
        return c.json({ error: "declare_signature invalid for wallet_identity" }, 401);
      case "signature_without_identity":
        return c.json(
          { error: "declare_signature without wallet_identity is meaningless" },
          400,
        );
      case "verified":
        (req as { ts?: string }).ts = auth.ts;
        break;
      case "anonymous":
        req.agent = "anonymous";
        break;
    }
    const result = await handleDeclare(req, ephemeralLedger());
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

contractRoutes.post("/contract/declare", async (c) => {
  const req = await c.req.json<DeclareRequest>();

  // ─── Creation Order (Genesis 1:3): the word lands first ───
  //
  // Every signed declare appends a row regardless of payment state.
  // Declaration is identity-gated only (the signed-declare verify in
  // executeDeclare). Compilation — the LLM-expansion into child
  // neurons — is the costly act and is gated separately, per skill
  // opt-in (PR #810 + #818), not by operator env (which #818 removed
  // as a footgun — "no env escape hatches").
  //
  // The aiko-client conditional 402 envelope (introduced in #808 +
  // #809) is REMOVED here in favor of single-lever doctrine: every
  // declare lands; per-skill opt-in elsewhere in the codebase is the
  // only gate. This route returns 200 with the declared row, period.
  // The Vine Doctrine's economic loop runs through the per-skill
  // Flex/x402 path on monetized routes, not through the contract
  // declaration primitive (which is the substrate's bedrock and
  // should stay maximally available).
  return executeDeclare(c, req);
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
    // Caller pubkey for lineage check — reads X-Wallet-Pubkey OR derives
    // from X-Aiko-Signature pubkey (when signed declares ship in #33). For
    // now, header-bearing callers identify themselves; unauthenticated
    // GET still works but only returns visibility=public/marketplace rows
    // and any pre-visibility-field rows where wallet_identity is unset.
    const callerPubkey =
      c.req.header("X-Wallet-Pubkey") ||
      c.req.header("x-wallet-pubkey") ||
      null;
    const result = await handleStatus(id, ephemeralLedger(), { caller_pubkey: callerPubkey });
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

/**
 * Module-scoped ledgers — DEFERRED-contracts-mirror-storage.
 *
 * The mirror route is gated on the substrate-faithful invariant that
 * write-paths to /v1/contract/mirror are namespaced per (agent, scope).
 * Until the durable EmergentDB / Postgres binding wires through (see
 * contract-ledger-postgres.ts on the feat/v1-exec-substrate-remote-proxy
 * branch), we use module-scoped ephemeral ledgers so successive POSTs
 * to the SAME process do see each other (unlike the per-request
 * ephemeralLedger() above). This is enough for the unblock signal and
 * for live `/v1/contract/status?id=` reads after a mirror within the
 * same Worker isolate. Survival across isolate restarts requires the
 * durable binding — explicit DEFERRED.
 */
const moduleScopedPrivateLedger: ContractLedger = (() => {
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
})();
const moduleScopedGlobalLedger: ContractLedger = (() => {
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
})();

/** Timing-safe equality for the bearer-token check. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Auth gate for the mirror route — `Authorization: Bearer <ADMIN_KEY>`
 *  matching the worker's configured ADMIN_KEY env. Returns true iff the
 *  request carries a matching token; returns false (without leaking
 *  configured key length/prefix) otherwise. */
function isMirrorAuthorized(c: { env: Env; req: { header: (k: string) => string | undefined } }): boolean {
  const configured = c.env.ADMIN_KEY?.trim();
  if (!configured) return false;
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return timingSafeEqual(header.slice(7), configured);
}

/**
 * POST /v1/contract/mirror — Π4 doctrine mirror endpoint.
 *
 * Accepts a raw ContractEventRow + optional `strip_pii: true` flag.
 * Gated by `Authorization: Bearer <ADMIN_KEY>` until per-agent auth
 * wires through (Privy JWT binding is on the separate fundraise org).
 * Also accepts the plural alias `/contracts/mirror` for callers that
 * use the doctrine-spec wording.
 */
async function mirrorRouteHandler(c: any) {
  if (!isMirrorAuthorized(c)) {
    return c.json({ error: "unauthorized — Bearer ADMIN_KEY required" }, 401);
  }
  let req: MirrorRequest;
  try {
    req = await c.req.json();
  } catch {
    return c.json({ error: "request body must be valid JSON" }, 400);
  }
  try {
    const result = await handleMirror(req, moduleScopedPrivateLedger, {
      globalLedger: moduleScopedGlobalLedger,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}
contractRoutes.post("/contract/mirror", mirrorRouteHandler);
contractRoutes.post("/contracts/mirror", mirrorRouteHandler);

// Self-introspection — what does the cloud /contract surface expose?
// Lets the thin client discover its tools without a hardcoded list.
contractRoutes.get("/contract/tools", (c) => {
  return c.json({
    routes: [
      { method: "POST", path: "/v1/contract/declare", purpose: "declare a new truth claim" },
      { method: "POST", path: "/v1/contract/iterate", purpose: "run one wave + return key2 prompt" },
      { method: "GET", path: "/v1/contract/status", purpose: "projection over all events for an id" },
      { method: "POST", path: "/v1/contract/plan-for-intent", purpose: "ranked shortlist over satisfied cells" },
      { method: "POST", path: "/v1/contract/mirror", purpose: "Π4 doctrine mirror — accepts raw ContractEventRow (alias /v1/contracts/mirror)" },
      { method: "GET", path: "/v1/contract/tools", purpose: "self-introspect (this endpoint)" },
    ],
    local_capabilities: ["kuri", "cookies", "vault", "browser", "fs"],
    persistence_note:
      "this stage is per-request in-memory; durable ledger binding lands in organ ddff0c96 stage D",
  });
});
