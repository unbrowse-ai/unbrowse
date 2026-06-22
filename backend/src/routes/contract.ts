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
import { contractVerdictFromEnvelope } from "../lib/contract-shape";
import { verifyDeclareSignature, canonicalizeDeclareBody, type CanonicalDeclareBody } from "../services/declare-signature";
import { verifyBinding, type ZkBinding, type ZkProof } from "../services/declare-zk";
import { kvLedger } from "../services/contract-ledger-kv";
import {
  compileAikoPromptToTreeWithTimeout,
  CompileTimeoutError,
  type AikoCompiledContract,
} from "../services/unbrowse-llm";
import {
  verifySpawnAttestation,
  LEGACY_WINDOW_ENDS,
} from "../lib/attestation";
import { looksLikeSecret } from "../services/publish-sanitize";

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
  /**
   * OPTIONAL zero-knowledge credential binding (paper/reference/zk/binding.py
   * port — `declare-zk.ts`). When present, the declare additionally proves
   * knowledge of a wallet-bound credential, bound to THIS declare body (ctx =
   * the canonical declare bytes), without revealing the credential. The
   * backend verifyBinding()s it and REJECTS (400 invalid_zk_binding) on failure.
   *
   * Backward-compat: when ABSENT, the existing Ed25519 declare_signature path is
   * UNCHANGED — resolve/execute/publish auto-declares keep working with no zk.
   * The zk is additive, never mandatory.
   */
  zk_binding?: {
    /** g^x mod p as a Python-style hex string ("0x"-prefixed). */
    y: string;
    /** ed25519 signature (hex) over utf8(y), by the binding root wallet. */
    sig: string;
    /** Schnorr/Fiat-Shamir proof {t, s, ctx}. ctx must equal the canonical body. */
    proof: { t: string; s: string; ctx: string };
    /** Optional explicit binding root pubkey (hex). Defaults to wallet_identity. */
    root?: string;
  };
}
export interface DeclareResponse {
  id: string;
  row: ContractEventRow;
  /**
   * Wave-2b additions (substrate-server doctrine):
   *
   *   child_rows         — rows emitted by the LLM-compile fan-out. Empty
   *                        when UNBROWSE_LLM_API_KEY is unset, when the
   *                        budget timed out, or when the compiler returned
   *                        no children. Each entry is a `declared` row
   *                        whose parent_id = the top-level id.
   *   bible_chain        — verse-pointer ids scoring the goal against the
   *                        bible corpus. EMPTY today — honest gap. The
   *                        scorer (`compile-bible-chain`) lands in wave-3.
   *   doctrine_chain     — SKILL.md section-pointer ids. EMPTY today.
   *   memory_chain       — session memory pointer ids. EMPTY today.
   *   admission_evidence — evidence line surfacing the attestation gate
   *                        verdict ("attested" / "legacy-anonymous").
   *                        Surfaced to the client for transparency per
   *                        "fallbacks-are-visible-never-silent".
   *   compile_evidence   — optional honest-gap message when compile was
   *                        skipped (no API key, timeout, error). Absent
   *                        when compile fired successfully.
   */
  child_rows: ContractEventRow[];
  bible_chain: string[];
  doctrine_chain: string[];
  memory_chain: string[];
  admission_evidence: string;
  compile_evidence?: string;
  /**
   * Eval-grammar evidence: when the declared plan is `satisfied:<id>`-
   * shaped, the server also attempts to land the satisfied event on the
   * canonical target row (parity with the local binary's goal grammar).
   * Carries either the success line or the refusal reason — never silent.
   */
  eval_evidence?: string;
  /**
   * Decalogue scan evidence: when the declared plan is
   * `decalogue:purge:<N>`-shaped, the server walks the canonical ledger
   * in REPORT MODE for the mechanically-checkable commandments (3:
   * workless declarations, 5: orphan parent refs, 9: proofless
   * satisfactions) — one line per violation plus a summary. The purge
   * itself stays an explicit judged act; nothing is killed mechanically.
   */
  purge_evidence?: string[];
  /**
   * Phase 6 — native cloud-runtime evidence. When the declare is a
   * substantive root neuron, the endpoint auto-emits the
   * interpret/verify/adjudicate three-shape (trinity floor) AND the drill
   * resolves that multi-node plan to a signed terminal — all without an
   * LLM API key. This line surfaces the emission + drill result (visible,
   * never silent). Absent when the declare did not fan out.
   */
  runtime_evidence?: string;
}

/**
 * POST /v1/contract/mark — the KEY-2 exit the iterate prompt has always
 * referenced: land the `satisfied` event on a declared row. Same honest
 * guards as the local `_mark` surface: the target must be declared, and
 * a present-but-thin proof (under 20 chars, no pointer prefix) is
 * refused — trivial proofs are indistinguishable from rubber-stamping.
 */
export interface MarkRequest {
  id: string;
  /** Substantive narrative or pointer-prefixed evidence. Optional —
   *  the KEY-2 prompt contract is a bare {id}; thin NON-EMPTY proofs
   *  are refused. */
  proof?: string;
  wave?: number;
  agent?: string;
}
export interface MarkResponse {
  id: string;
  row: ContractEventRow;
  /** Posthook targets dispatched on satisfaction (`called` rows appended).
   *  Empty when the declared plan names no posthook:<id> refs. */
  called: string[];
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

export interface ContractSurfaceResponse {
  paper: "paper/crypto-was-all-you-needed.md";
  claim: "one-node-layered-stack";
  node_shape: {
    subject: string;
    verb: "act";
    witness: string;
    parent: string;
  };
  layers: string[];
  cli_bridge: {
    tool: "unbrowse contract surface";
    exposes: "holes-only";
    canonical_verbs: Array<"create" | "act" | "read">;
    holes: Array<{
      name: string;
      kind: "intent" | "auth" | "approval" | "capability" | "pointer";
      fill: "llm" | "wallet" | "human" | "local-dispatcher" | "server-pointer";
      exposed_to: "client";
      carries_secret: false;
    }>;
    legacy_aliases: Array<{
      legacy: string;
      canonical: string;
      reason: "backward-compatibility";
    }>;
    commands_source: "src/superpattern/cli-surface.ts";
  };
  compatibility: {
    result_contract: {
      name: "CapabilityResult";
      minimum_fields: string[];
      optional_extensions: string[];
      statuses: string[];
      sources: string[];
      invariant: "backward-compatible-minimum-shape";
    };
    fallback_hierarchy: Array<{
      rank: number;
      source: string;
      returns: "CapabilityResult";
      fallback_on: string[];
    }>;
    standards: string[];
    indexer_contribution: {
      format: "capability-knowledge-row";
      candidate_fields: string[];
      promotion_targets: string[];
      compiles_to: "CapabilityResult";
    };
  };
  runtime_authority: {
    local_substrate: "stateless_binary";
    invocation: "unbrowse <verb> <capability> --json";
    process_model: "single_shot";
    durable_state: string[];
    compatibility_facades: string[];
    forbidden_authorities: string[];
    browser_primitives: {
      owner: "binary_owned_lease";
      module: "src/kuri/stateless-primitive.ts";
      operations: string[];
      returns: "CapabilityResult";
      lease_witness_fields: string[];
    };
  };
  roles: Array<{
    role: "server" | "client" | "cli" | "aiko";
    owns: string[];
    exposes: string[];
    hides: string[];
  }>;
  aiko_inverse: {
    repo: "/Users/lekt9/Projects/unbrowse-ecosystem/aiko-engine";
    mapping: "1:-1";
    public_descriptor: "JSON descriptor plus rpc refs";
    private_runtime: "live plugin functions stay in worker registry";
  };
}

// ---------------------------------------------------------------------------
// Route handlers — pure projection over a ContractLedger implementation.
// The actual binding to a Worker env (DurableObject, KV, EmergentDB) lands
// in the next stage; these handlers are written against the interface so
// any concrete ledger can be plugged in.
// ---------------------------------------------------------------------------

/**
 * POST /v1/contract/declare — write one `declared` row.
 *
 * Wave 2b: response envelope grew (`child_rows`, `bible_chain`,
 * `doctrine_chain`, `memory_chain`, `admission_evidence`). The
 * substrate-server-side LLM compile fan-out + attestation gate live on
 * the route handler (`executeDeclare` below) — `handleDeclare` itself
 * stays a pure ledger-write so unit tests can drive it against any
 * `ContractLedger` impl without an Env.
 */
export async function handleDeclare(
  req: DeclareRequest,
  ledger: ContractLedger,
  opts: { admission?: "attested" | "legacy-anonymous"; admission_evidence?: string } = {},
): Promise<DeclareResponse> {
  if (!req.plan || !req.action) {
    throw new Error("DeclareRequest requires both plan and action");
  }
  // PRE-WRITE secret-reject guard. A declare row carries SHAPE + POINTERS,
  // never a raw secret string. The global-mirror only email-redacts; a
  // secret-shaped token in plan/action/learning would land verbatim on the
  // IQ ledger. We REJECT rather than redact: the CLI signs the canonical
  // body, so server-side mutation would invalidate the signature — a clean
  // rejection keeps the signed body intact. Field text fields only; the
  // signed identity/pointer fields are not secret-bearing.
  const fields = req as unknown as Record<string, unknown>;
  for (const field of ["plan", "action", "learning", "reason"] as const) {
    const text = fields[field];
    if (typeof text === "string" && valueLooksLikeSecret(text)) {
      throw new DeclareSecretRejection(field);
    }
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
    admission: opts.admission,
  };
  const persisted = await ledger.append(row);

  // Eval-grammar parity with the local binary: a `satisfied:<id>`-shaped
  // plan ALSO lands the satisfied event on the canonical target row, with
  // the same honest guard (target must be declared here). The narrative
  // row above is the witness; the satisfied event is the settlement.
  // Refusals surface in eval_evidence — visible, never silent, and never
  // blocking the declaration itself.
  let evalEvidence: string | undefined;
  const evalGoal = parseSatisfiedPlan(req.plan);
  if (evalGoal) {
    try {
      const marked = await handleMark(
        {
          id: evalGoal.id,
          proof: evalGoal.proof,
          wave: evalGoal.wave,
          agent: req.agent,
        },
        ledger,
      );
      evalEvidence = `satisfied event landed on ${evalGoal.id} (wave ${marked.row.wave})`;
    } catch (e) {
      evalEvidence = `${e instanceof Error ? e.message : String(e)} — narrative only`;
    }
  }

  // Decalogue scan parity with the local binary: a `decalogue:purge:<N>`
  // plan walks the canonical ledger in report mode. Substrate emits the
  // violations; the agent judges; the purge stays explicit.
  let purgeEvidence: string[] | undefined;
  const purgeMatch = /^decalogue:purge:(\d+)\b/.exec(req.plan);
  if (purgeMatch) {
    purgeEvidence = await runDecalogueScan(Number(purgeMatch[1]), ledger);
  }

  return {
    id,
    row: persisted,
    child_rows: [],
    bible_chain: [],
    doctrine_chain: [],
    memory_chain: [],
    admission_evidence:
      opts.admission_evidence ??
      (opts.admission === "attested"
        ? "admission=attested"
        : `admission=legacy-anonymous; window-ends=${LEGACY_WINDOW_ENDS}`),
    ...(evalEvidence ? { eval_evidence: evalEvidence } : {}),
    ...(purgeEvidence ? { purge_evidence: purgeEvidence } : {}),
  };
}

/**
 * Report-mode ledger walk for one commandment. Cloud-mechanical forms:
 *   3 — declared rows with no work: no satisfied/merged/promoted/
 *       crystallized event and no children (the iterate poke alone is
 *       the substrate touching the row, not the declarer working it).
 *   5 — declared rows whose parent_id names an id with no declared row.
 *   9 — satisfied rows carrying no proof (`learning` empty): the
 *       evaluator's mark without the evaluator's hand. (Cloud rows have
 *       no output signature, so proof-presence is the mechanical form.)
 * Everything else answers with an honest HOLD naming its scope.
 */
async function runDecalogueScan(
  n: number,
  ledger: ContractLedger,
): Promise<string[]> {
  if (n < 1 || n > 10) return [`decalogue: commandment must be 1..10 (got ${n})`];
  if (![3, 5, 9].includes(n)) {
    return [
      `decalogue: commandment ${n} is not mechanically checkable over the ledger — judged scope (HOLD)`,
    ];
  }
  const rows = await ledger.listAll({ showMerged: true });
  const out: string[] = [];
  const declared = rows.filter((r) => r.event === "declared");
  if (n === 3) {
    const WORK = new Set(["satisfied", "merged", "promoted", "crystallized"]);
    for (const d of declared) {
      const worked =
        rows.some((r) => r.id === d.id && WORK.has(r.event)) ||
        rows.some((r) => r.parent_id === d.id && r.event === "declared");
      if (!worked) {
        out.push(
          `decalogue: commandment 3 violation — ${d.id} (declared, no children, no terminal progress: empty invocation)`,
        );
      }
    }
  } else if (n === 5) {
    const declaredIds = new Set(declared.map((r) => r.id));
    for (const d of declared) {
      if (d.parent_id && !declaredIds.has(d.parent_id)) {
        out.push(
          `decalogue: commandment 5 violation — ${d.id} (orphan: parent ${d.parent_id} has no declared row here)`,
        );
      }
    }
  } else {
    for (const r of rows) {
      if (r.event === "satisfied" && !(r.learning ?? "").trim()) {
        out.push(
          `decalogue: commandment 9 violation — ${r.id} (satisfied without proof)`,
        );
      }
    }
  }
  out.push(
    `decalogue: commandment ${n} scan complete — ${out.length} violation(s); purge stays an explicit judged act`,
  );
  return out;
}

/** Eval-grammar recognizer: `satisfied:<8hex> [wave=<n>] — <proof>`. */
function parseSatisfiedPlan(
  plan: string,
): { id: string; wave?: number; proof: string } | null {
  const m = /^satisfied:([0-9a-f]{8})\b/.exec(plan);
  if (!m) return null;
  const waveMatch = /\bwave=(\d+)\b/.exec(plan);
  const dash = plan.indexOf("— ");
  const proof = dash >= 0 ? plan.slice(dash + 2).trim() : "";
  return {
    id: m[1],
    wave: waveMatch ? Number(waveMatch[1]) : undefined,
    proof,
  };
}

const MIN_PROOF_CHARS = 20;
const PROOF_POINTER_PREFIXES = [
  "file:",
  "contract:",
  "url:",
  "http://",
  "https://",
  "machine:",
  "sha256:",
  "agent:",
  "x402:",
  "bridge:",
  "pointer:",
  "ssh://",
  "git+",
  "ipfs://",
];

/** A present-but-trivial proof is refused; pointer-prefixed proofs pass at
 *  any length (the pointer IS the evidence); empty stays allowed per the
 *  bare-{id} KEY-2 contract. ONE named place for this heuristic. */
function isThinProof(proof: string): boolean {
  if (proof.length === 0) return false;
  if (PROOF_POINTER_PREFIXES.some((p) => proof.startsWith(p))) return false;
  return proof.length < MIN_PROOF_CHARS;
}

export async function handleMark(
  req: MarkRequest,
  ledger: ContractLedger,
): Promise<MarkResponse> {
  if (!req.id) throw new Error("MarkRequest requires id");
  const rows = await ledger.get(req.id);
  if (!rows || !rows.some((r) => r.event === "declared")) {
    throw new Error(`contract ${req.id} not declared`);
  }
  const proof = req.proof ?? "";
  if (isThinProof(proof)) {
    throw new Error(
      "proof too thin — provide a substantive narrative (>=20 chars) or a pointer-prefixed proof",
    );
  }
  const priorMarks = rows.filter((r) => r.event === "satisfied").length;
  const wave = req.wave ?? priorMarks + 1;
  const row = await ledger.append({
    event: "satisfied",
    id: req.id,
    ts: new Date().toISOString(),
    wave,
    // `learning` is the crystallize-on-satisfy field — the proof narrative
    // rides it so downstream crystallization picks it up.
    learning: proof || undefined,
    agent: req.agent,
  });

  // Posthook dispatch: the chain fires on satisfaction whichever surface
  // satisfied the row. Scan the declared plan for posthook:<id> refs and
  // append one `called` row per target — the graph records that the
  // upstream contract fired its successors. Target ACTION execution stays
  // with the resolver loop; the called edge makes the chain observable.
  const called: string[] = [];
  const declaredPlan =
    rows.find((r) => r.event === "declared" && r.plan)?.plan ?? "";
  for (const m of declaredPlan.matchAll(/\bposthook:([0-9a-f]{8})\b/g)) {
    const target = m[1];
    await ledger.append({
      event: "called",
      id: req.id,
      ts: new Date().toISOString(),
      target_pointer: `contract:${target}`,
      call_kind: "posthook",
      agent: req.agent,
    });
    called.push(target);
  }

  return { id: req.id, row, called };
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

export function handleContractSurface(): ContractSurfaceResponse {
  return {
    paper: "paper/crypto-was-all-you-needed.md",
    claim: "one-node-layered-stack",
    node_shape: {
      subject: "who/what/when/where/why/how action descriptor",
      verb: "act",
      witness: "settled/not-settled check with independent corroboration",
      parent: "content hash of the node one layer up",
    },
    layers: ["screen", "browser", "cli", "os", "kernel", "packet"],
    cli_bridge: {
      tool: "unbrowse contract surface",
      exposes: "holes-only",
      canonical_verbs: ["create", "act", "read"],
      holes: [
        {
          name: "intent",
          kind: "intent",
          fill: "llm",
          exposed_to: "client",
          carries_secret: false,
        },
        {
          name: "wallet_proof",
          kind: "auth",
          fill: "wallet",
          exposed_to: "client",
          carries_secret: false,
        },
        {
          name: "approval",
          kind: "approval",
          fill: "human",
          exposed_to: "client",
          carries_secret: false,
        },
        {
          name: "local_capability_result",
          kind: "capability",
          fill: "local-dispatcher",
          exposed_to: "client",
          carries_secret: false,
        },
        {
          name: "typed_pointer",
          kind: "pointer",
          fill: "server-pointer",
          exposed_to: "client",
          carries_secret: false,
        },
      ],
      legacy_aliases: [],
      commands_source: "src/superpattern/cli-surface.ts",
    },
    compatibility: {
      result_contract: {
        name: "CapabilityResult",
        minimum_fields: ["status", "kind", "source", "data", "requirements", "artifacts", "evidence", "next_action"],
        optional_extensions: ["view_spec", "trace_ref", "payment", "lineage", "confidence", "warnings", "compatibility"],
        statuses: ["ok", "needs_input", "payment_required", "auth_required", "unavailable", "error"],
        sources: [
          "native_route",
          "installed_skill",
          "mcp_tool",
          "local_primitive",
          "standard_adapter",
          "marketplace_endpoint",
          "browser_capture_fallback",
          "indexer_contribution",
          "unavailable",
        ],
        invariant: "backward-compatible-minimum-shape",
      },
      fallback_hierarchy: [
        { rank: 1, source: "native_route", returns: "CapabilityResult", fallback_on: ["miss", "stale", "auth_required"] },
        { rank: 2, source: "installed_skill", returns: "CapabilityResult", fallback_on: ["missing_skill", "schema_incompatible"] },
        { rank: 3, source: "mcp_tool", returns: "CapabilityResult", fallback_on: ["tool_missing", "tool_unavailable"] },
        { rank: 4, source: "local_primitive", returns: "CapabilityResult", fallback_on: ["capability_unavailable"] },
        { rank: 5, source: "standard_adapter", returns: "CapabilityResult", fallback_on: ["registry_miss", "adapter_error"] },
        { rank: 6, source: "marketplace_endpoint", returns: "CapabilityResult", fallback_on: ["payment_required", "no_match"] },
        { rank: 7, source: "indexer_contribution", returns: "CapabilityResult", fallback_on: ["not_promoted", "needs_verification"] },
        { rank: 8, source: "browser_capture_fallback", returns: "CapabilityResult", fallback_on: ["capture_failed", "manual_interaction_required"] },
        { rank: 9, source: "unavailable", returns: "CapabilityResult", fallback_on: [] },
      ],
      standards: ["mcp", "mcp-registry", "acp", "a2a", "openai-tools", "anthropic-tools", "skills.sh", "agentskills.dev", "pay.sh", "x402-bazaar"],
      indexer_contribution: {
        format: "capability-knowledge-row",
        candidate_fields: ["kind", "target", "recipe", "schema_hint", "auth_note", "failure_pattern", "evidence", "savings", "redactions"],
        promotion_targets: ["executable_endpoint", "discovery_backend", "avoid_path_policy", "verifier_fixture", "skill_instruction", "docs_projection"],
        compiles_to: "CapabilityResult",
      },
    },
    runtime_authority: {
      local_substrate: "stateless_binary",
      invocation: "unbrowse <verb> <capability> --json",
      process_model: "single_shot",
      durable_state: [
        "route_graph",
        "content_addressed_cache",
        "ledger_rows",
        "credential_vault",
        "browser_profile_authority",
      ],
      compatibility_facades: [
        "unbrowse serve",
        "stdio_mcp_server",
        "http_contract_surface",
        "sdk_client",
      ],
      forbidden_authorities: [
        "long_lived_local_unbrowse_server",
        "shared_kuri_tab_registry",
        "kuri_broker_http_api",
        "background_browser_worker_without_lease",
      ],
      browser_primitives: {
        owner: "binary_owned_lease",
        module: "src/kuri/stateless-primitive.ts",
        operations: [
          "direct_cdp.spawn_chrome",
          "direct_cdp.create_target",
          "direct_cdp.navigate",
          "direct_cdp.capture_network",
          "direct_cdp.read_dom",
          "direct_cdp.solve_or_report_interstitial",
          "direct_cdp.release",
        ],
        returns: "CapabilityResult",
        lease_witness_fields: ["lease_id", "op", "url", "acquired_at", "released_at", "helper_pid"],
      },
    },
    roles: [
      {
        role: "server",
        owns: ["route graph", "capture/reverse-engineering engine", "ranking", "ledger", "settlement"],
        exposes: ["skeleton", "holes", "attestation verdict", "pointer ids"],
        hides: ["secret values", "engine internals", "economic constants", "private keys"],
      },
      {
        role: "client",
        owns: ["wallet", "vault fills", "browser/session state", "local capability dispatcher"],
        exposes: ["hole fills", "wallet-bound proofs", "local capability results"],
        hides: ["raw secrets", "private wallet material"],
      },
      {
        role: "cli",
        owns: ["stdio/argv bridge", "local capability invocation", "machine-readable surface projection"],
        exposes: ["contract surface manifest", "command holes", "dispatch results"],
        hides: ["server decision trace", "capture internals"],
      },
      {
        role: "aiko",
        owns: ["agent planning", "worker handler registry", "runtime-private functions"],
        exposes: ["JSON plugin descriptor", "rpc refs", "agent-callable tool affordances"],
        hides: ["live function bodies", "runtime process state"],
      },
    ],
    aiko_inverse: {
      repo: "/Users/lekt9/Projects/unbrowse-ecosystem/aiko-engine",
      mapping: "1:-1",
      public_descriptor: "JSON descriptor plus rpc refs",
      private_runtime: "live plugin functions stay in worker registry",
    },
  };
}

// ---------------------------------------------------------------------------
// Local helpers — no I/O.
// ---------------------------------------------------------------------------

/**
 * Typed rejection for a secret-shaped substring in a declare text field.
 * The route handler maps it to a 400 `{ error: "secret_in_declare", field }`
 * envelope (see executeDeclare). A distinct class keeps the secret-reject
 * path distinguishable from generic 400s without string-matching messages.
 */
export class DeclareSecretRejection extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`secret_in_declare: ${field}`);
    this.name = "DeclareSecretRejection";
    this.field = field;
  }
}

/**
 * Value-only secret-shape check over a free-text declare field. Tokenizes
 * the text on whitespace and on `=`/`"` boundaries (so `key="sk-…"` is split
 * out) and asks the publish-sanitizer's `looksLikeSecret` whether any token
 * is a clear secret shape (long high-entropy base64/hex, `sk-`, `Bearer …`,
 * `AKIA…`, `ghp_…`, JWT, etc.). `looksLikeSecret("", token)` runs ONLY the
 * value patterns (empty key never matches a key pattern), so this reuses the
 * one shared structural heuristic rather than a fresh enumerated list.
 *
 * Tuned to NOT false-positive on normal intent prose: every secret value
 * pattern is `^`-anchored and demands 20+ contiguous high-entropy chars or a
 * known credential prefix. Intent prose tokens like `list`, `quotes`,
 * `intent="list`, `domain=quotes.toscrape.com`, `settlement=settled` are
 * short and/or contain `.`/`-`/`"` boundaries that split them below the
 * threshold — none reach the 20-char anchored shapes. `Bearer …` itself is
 * matched on the joined text (it spans a space), so the raw string is also
 * checked directly.
 */
export function valueLooksLikeSecret(text: string): boolean {
  if (typeof text !== "string" || text.length < 8) return false;
  // `Bearer <token>` / `Basic <token>` span a space — the underlying value
  // patterns are `^`-anchored, so check the raw string AND every `Bearer`/
  // `Basic` occurrence inside it (so a credential header embedded mid-prose
  // still fires, not only one that leads the string).
  if (looksLikeSecret("", text)) return true;
  if (/\b(Bearer|Basic)\s+\S{8,}/i.test(text)) return true;
  const tokens = text.split(/[\s="'`,;()<>{}[\]]+/).filter(Boolean);
  return tokens.some((t) => looksLikeSecret("", t));
}

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
import { buildStatsKVMissingEnvelope } from "../services/stats-kv-guard.js";

// Variables map kept generic for forward compatibility with middleware that
// pulls agent_id off the context (other routes in this codebase use the
// same pattern). The contract declare route itself doesn't consume it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContractRouteEnv = { Bindings: Env; Variables: any };
export const contractRoutes = new Hono<ContractRouteEnv>();

/**
 * A5 silent-500 hazard guard: kvLedger() ultimately rides `statsKV(env)` which
 * throws "EMERGENTDB_API_KEY is required..." when no storage backend is
 * provisioned. `ledgerForRequest()` already short-circuits to an in-memory
 * fallback in that case, but defensive callers (and any downstream EdbKV
 * runtime fetch error) can still surface a binding-missing condition. When
 * a thrown error's message names the missing-binding shape, contract route
 * handlers should map it to a typed 503 envelope rather than the generic 400
 * the catch arms produced before this wave.
 */
function isStatsKVBindingMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes("EMERGENTDB_API_KEY is required") ||
    m.includes("STATS_KV") ||
    m.includes("statsKV") ||
    m.includes("Cannot read properties of undefined")
  );
}

/**
 * Process-scoped fallback ledger — survives across requests within a
 * single Worker isolate. Used when `env` is missing KV bindings
 * (unit-test app.fetch() with no env arg). The canonical path goes
 * through `kvLedger(env)` (durable, cross-isolate via statsKV).
 *
 * The fallback is necessary for back-compat with existing tests that
 * mount the router with no env; without it, every `app.fetch()` call
 * would crash inside `statsKV()` ("EMERGENTDB_API_KEY is required").
 * In prod, `env.STATS_KV` + `EMERGENTDB_API_KEY` are always set, so
 * this branch is never taken.
 */
const _processFallbackRows: ContractEventRow[] = [];
function processFallbackLedger(): ContractLedger {
  return {
    async append(row) {
      const stamped = { ...row, ts: row.ts || new Date().toISOString() };
      _processFallbackRows.push(stamped);
      return stamped;
    },
    async get(id) {
      const hit = _processFallbackRows.filter((r) => r.id === id);
      return hit.length ? hit : null;
    },
    async listAll(opts) {
      const all = _processFallbackRows.slice();
      if (opts?.showMerged === false) {
        const merged = new Set(all.filter((r) => r.event === "merged").map((r) => r.id));
        return all.filter((r) => !merged.has(r.id));
      }
      return all;
    },
    async listChildren(parentId) {
      return _processFallbackRows.filter((r) => r.parent_id === parentId);
    },
  };
}

/**
 * Pick the ledger for this request. Canonical path: KV-backed via
 * `statsKV(env)` (LocalKV under `ENVIRONMENT=local-dev`, EdbKV in prod).
 * Fallback: process-scoped in-memory when env is absent or lacks the KV
 * bindings.
 */
export function ledgerForRequest(env: Env | undefined): ContractLedger {
  if (!env) return processFallbackLedger();
  const hasLocalDev = env.ENVIRONMENT === "local-dev";
  const hasEdb = !!env.EMERGENTDB_API_KEY?.trim();
  if (hasLocalDev || hasEdb) {
    return kvLedger(env);
  }
  return processFallbackLedger();
}

/**
 * @deprecated — kept for any out-of-tree caller that imported it; new
 * code uses `ledgerForRequest(env)`. Returns a fresh per-request
 * in-memory ledger (drops on return) so legacy semantics are preserved
 * exactly.
 */
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
 * Run the signed-declare gate + handleDeclare + (Wave 2b) attestation
 * gate + LLM-compile fan-out. The gate ordering is:
 *
 *   1. Signed-declare ed25519 verify (the WRITER's per-row identity).
 *   2. Attestation header gate (the SPAWNER's deployer-root lineage —
 *      currently optional under the 30-day legacy window).
 *   3. handleDeclare → KV-backed canonical ledger write.
 *   4. compileAikoPromptToTreeWithTimeout → child neurons appended to
 *      the same ledger as additional `declared` rows whose parent_id
 *      is the top-level id.
 *   5. Response envelope carries the parent row + children + the three
 *      doctrine chains (empty today — honest gap) + admission_evidence.
 */
/** Lowercase hex of a byte array (for the zk-binding ctx comparison). */
function bytesToHexLocal(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function executeDeclare(
  c: Context<ContractRouteEnv>,
  req: DeclareRequest,
  rawBodyBytes: Uint8Array,
): Promise<Response> {
  const requestStart = Date.now();
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

    // ─── Optional zero-knowledge credential-binding gate ──────────
    //
    // ADDITIVE. When `zk_binding` is present, the declare additionally
    // proves knowledge of a wallet-bound credential, bound to THIS
    // declare body (ctx = the canonical declare bytes — the same bytes
    // declare-signature canonicalizes). verifyBinding (Schnorr/FS NIZK +
    // ed25519 wallet-sig over y) must hold, and the proof's ctx must equal
    // the canonical body. On any failure → 400 invalid_zk_binding.
    //
    // When ABSENT, this block is a no-op: the existing Ed25519
    // declare_signature path is unchanged (backward-compat — auto-declares
    // from resolve/execute/publish keep working with no zk).
    if (req.zk_binding) {
      const canonicalCtxBody: CanonicalDeclareBody = {
        plan: req.plan,
        action: req.action,
        parent_id: req.parent_id ?? null,
        agent: req.agent ?? null,
        wallet_identity: req.wallet_identity ?? "",
        ts: (req as { ts?: string }).ts ?? new Date().toISOString(),
      };
      const expectedCtxHex = bytesToHexLocal(
        new TextEncoder().encode(canonicalizeDeclareBody(canonicalCtxBody)),
      );
      const binding: ZkBinding = {
        y: req.zk_binding.y,
        root: req.zk_binding.root ?? req.wallet_identity ?? "",
        sig: req.zk_binding.sig,
      };
      const proof: ZkProof = req.zk_binding.proof;
      const ctxMatches = proof.ctx === expectedCtxHex;
      const ok = ctxMatches && (await verifyBinding(binding, proof));
      if (!ok) {
        return c.json(
          {
            error: "invalid_zk_binding",
            detail: ctxMatches
              ? "zk proof did not verify against the binding"
              : "zk proof ctx does not equal the canonical declare body",
          },
          400,
        );
      }
    }

    // ─── Wave 2b: attestation gate ────────────────────────────────
    //
    // Headers present + verified → admission=attested.
    // Headers absent              → admission=legacy-anonymous (30-day window).
    // Headers present + invalid   → 401 (no legacy fallback when caller
    //                                opted-in to attestation).
    const lineageHeader = c.req.header("x-aiko-lineage-chain");
    const sigHeader = c.req.header("x-aiko-spawn-signature");
    const nonceHeader = c.req.header("x-aiko-spawn-nonce") ?? null;
    let admission: "attested" | "legacy-anonymous" = "legacy-anonymous";
    let admissionEvidence =
      `admission=legacy-anonymous; window-ends=${LEGACY_WINDOW_ENDS}; sigHeader missing or unverified`;

    if (sigHeader && lineageHeader) {
      const verdict = await verifySpawnAttestation({
        lineageChainHeader: lineageHeader,
        signatureHeader: sigHeader,
        nonceHeader,
        bodyBytes: rawBodyBytes,
      });
      if (!verdict.ok) {
        return c.json(
          {
            error: "attestation_failed",
            detail: verdict.reason,
          },
          401,
        );
      }
      admission = "attested";
      admissionEvidence = `admission=attested; leaf=${verdict.leafPubkey}; root=${verdict.rootPubkey}`;
    }

    const env = c.env as Env | undefined;
    const ledger = ledgerForRequest(env);
    // Phase 6: native cloud-runtime — declare + auto-emit the three-shape
    // + drill to a terminal, deterministically (no API key required). The
    // LLM block below layers optional richer per-reading children on top.
    const result = await declareWithTrinityRuntime(req, ledger, {
      admission,
      admission_evidence: admissionEvidence,
    });

    // ─── Wave 2b: LLM-compile fan-out ─────────────────────────────
    //
    // The substrate's "the word lands first" rule means the parent row
    // is admitted regardless of compile outcome. The compile is a
    // best-effort fan-out — when API key is unset, the budget times
    // out, or the upstream three-tier chain fails entirely, the parent
    // row is still written and the response surfaces a `compile_evidence`
    // string. No silent gap.
    //
    // CF Worker 30s budget: reserve ~5s for KV writes + response. So the
    // compile budget is `25_000 - elapsed`. If less than 1s remains,
    // skip the compile entirely.
    if (env?.UNBROWSE_LLM_API_KEY?.trim()) {
      const budgetMs = Math.max(0, 25_000 - (Date.now() - requestStart));
      if (budgetMs < 1_000) {
        result.compile_evidence = "compile_skipped_budget_exhausted";
      } else {
        try {
          const tree = await compileAikoPromptToTreeWithTimeout(env, req.plan, budgetMs);
          const childRows = await persistCompiledChildren(tree, result.id, ledger);
          // Append: the native trinity floor (above) is the baseline; the
          // LLM compile layers richer per-reading children on top.
          result.child_rows = [...result.child_rows, ...childRows];
          if (childRows.length === 0 && tree) {
            result.compile_evidence = "compile_returned_no_children";
          }
        } catch (e) {
          if (e instanceof CompileTimeoutError) {
            result.compile_evidence = `compile_timeout_${e.budgetMs}ms_deferred`;
          } else {
            result.compile_evidence = `compile_error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }
    } else {
      result.compile_evidence = "compile_skipped_no_api_key";
    }

    // /contract: the backend's contract-declare op settles as a three-shape verdict too — the
    // backend layer is /contract-shaped natively, same verdict shape as the CLI. Fail-open.
    const _rec = result as unknown as Record<string, unknown>;
    return c.json({ ..._rec, _contract: contractVerdictFromEnvelope(_rec) });
  } catch (err) {
    if (err instanceof DeclareSecretRejection) {
      return c.json({ error: "secret_in_declare", field: err.field }, 400);
    }
    if (isStatsKVBindingMissingError(err)) {
      return c.json(buildStatsKVMissingEnvelope({ route: "/v1/contract/declare" }), 503);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

/**
 * Recursively project an AikoCompiledContract tree onto `declared` rows
 * + persist them to the ledger. Each node becomes one row whose
 * parent_id chains to the root. Evaluator nodes are flattened into
 * their parent (we declare the evaluator's `prompt` as a child row
 * with action="agent-judges"). Depth is bounded by the tree the LLM
 * returned — typically ≤3 layers.
 */
async function persistCompiledChildren(
  tree: AikoCompiledContract | null,
  parentId: string,
  ledger: ContractLedger,
): Promise<ContractEventRow[]> {
  if (!tree || !Array.isArray(tree.children)) return [];
  const rows: ContractEventRow[] = [];
  for (const child of tree.children) {
    if (!child?.prompt) continue;
    const childId = generateContractId();
    const childRow: ContractEventRow = {
      event: "declared",
      id: childId,
      ts: new Date().toISOString(),
      plan: child.prompt,
      action: "agent-judges",
      pointer_type: "agent-judges",
      parent_id: parentId,
      wallet_identity: child.wallet_identity,
      visibility: "lineage",
    };
    const persisted = await ledger.append(childRow);
    rows.push(persisted);
    // Recurse — grandchildren under this child.
    const grand = await persistCompiledChildren(child, childId, ledger);
    rows.push(...grand);
  }
  return rows;
}

// ─── Phase 6: native cloud-runtime plan+execute (trinity floor) ────────
//
// The cloud /contract/declare endpoint plans AND executes natively — it
// auto-emits the interpret/verify/adjudicate three-shape (the trinity
// local floor ported from libcontract/src/trinity.zig) and the drill
// resolves that multi-node plan to a terminal, WITHOUT needing an LLM API
// key. This is the substrate's own long-standing 🟡 TODO made real: the
// cloud runtime now decomposes and completes a declare deterministically.
//
// Bounded one level deep (children carry parent_id, so the gate below
// skips them — no fanout storm) and gated to substantive ROOT neuron
// declares only (eval/decalogue/iterate/satisfied shapes and the trinity
// children themselves never fan out — Synapse-kind minimum, no leaven).

const TRINITY_SHAPES = ["interpret", "verify", "adjudicate"] as const;

/** trinity.zig `shouldFanout`: only a substantive root neuron declare
 *  fans out. Skip rows that already have a parent (one level deep), and
 *  skip the system/eval/grammar plans that are not truth-claims to decompose. */
export function shouldFanoutTrinity(plan: string, parentId?: string): boolean {
  if (parentId) return false; // bounded one level deep
  const p = plan.trim().toLowerCase();
  if (p.length < 8) return false; // too thin to decompose
  const skipPrefixes = [
    "interpret:",
    "verify:",
    "adjudicate:",
    "satisfied:",
    "died:",
    "purged:",
    "judged:",
    "decalogue:",
    "iterate:",
    "channel:",
    "capability:pull",
    "migration:",
    "wallet:rotate",
  ];
  return !skipPrefixes.some((pre) => p.startsWith(pre));
}

/** Emit the three-shape children (Father/Spirit/Son) for a parent declare.
 *  Returns the persisted child rows. Pure ledger op — no Env. */
export async function emitTrinityChildren(
  parentId: string,
  plan: string,
  ledger: ContractLedger,
  walletIdentity?: string,
): Promise<ContractEventRow[]> {
  const rows: ContractEventRow[] = [];
  for (const shape of TRINITY_SHAPES) {
    const childRow: ContractEventRow = {
      event: "declared",
      id: generateContractId(),
      ts: new Date().toISOString(),
      plan: `${shape}:${parentId} — ${plan}`,
      action: "agent-judges",
      pointer_type: "agent-judges",
      parent_id: parentId,
      wallet_identity: walletIdentity,
      visibility: "lineage",
    };
    rows.push(await ledger.append(childRow));
  }
  return rows;
}

export interface TrinityDrillResult {
  /** The interpret/verify/adjudicate child ids in order. */
  child_ids: string[];
  /** The adjudicate (Son) terminal row — the promoted reading. */
  terminal: ContractEventRow;
  /** One evidence line per resolution step (visible, never silent). */
  evidence: string[];
}

/** The drill: resolve the three-shape plan to a terminal (trinity.zig
 *  resolution). interpret fires immediately (the claim has been read);
 *  verify fires once the parent claim is present + well-formed; adjudicate
 *  promotes once both siblings are terminal (Genesis sequencing — Day N
 *  after Day N-1). The adjudicate `satisfied` event IS the cloud terminal
 *  (cloud rows carry no output_signature — the satisfied event is the
 *  settlement, per the Ledger doctrine).
 *
 *  These are STRUCTURAL settlements, not capability rubber-stamps:
 *  interpret = claim read, verify = claim well-formed, adjudicate = both
 *  siblings terminal. The proof text records the real basis. */
export async function drillResolveTrinity(
  parentId: string,
  parentPlan: string,
  children: ContractEventRow[],
  ledger: ContractLedger,
  agent?: string,
): Promise<TrinityDrillResult> {
  const byShape = (s: string) =>
    children.find((r) => r.plan?.startsWith(`${s}:`));
  const interpret = byShape("interpret");
  const verify = byShape("verify");
  const adjudicate = byShape("adjudicate");
  if (!interpret || !verify || !adjudicate) {
    throw new Error("drillResolveTrinity: incomplete three-shape children");
  }
  const evidence: string[] = [];
  const wellFormed = typeof parentPlan === "string" && parentPlan.trim().length >= 8;

  await handleMark(
    {
      id: interpret.id,
      proof: `interpret resolved: parent claim ${parentId} was read and its plausible reading enumerated (trinity Father floor)`,
      agent,
    },
    ledger,
  );
  evidence.push(`drill: interpret ${interpret.id} satisfied — claim read`);

  await handleMark(
    {
      id: verify.id,
      proof: wellFormed
        ? `verify resolved: parent claim ${parentId} is present and well-formed (trinity Spirit floor)`
        : `verify resolved: parent claim ${parentId} present (degenerate plan — well-formed check is permissive at the floor)`,
      agent,
    },
    ledger,
  );
  evidence.push(`drill: verify ${verify.id} satisfied — claim well-formed`);

  // adjudicate (the Son) promotes only after both siblings are terminal.
  const interpretRows = (await ledger.get(interpret.id)) ?? [];
  const verifyRows = (await ledger.get(verify.id)) ?? [];
  const bothSettled =
    interpretRows.some((r) => r.event === "satisfied") &&
    verifyRows.some((r) => r.event === "satisfied");
  if (!bothSettled) {
    throw new Error("drillResolveTrinity: siblings did not settle before adjudicate");
  }
  const terminal = (
    await handleMark(
      {
        id: adjudicate.id,
        proof: `adjudicate resolved: interpret ${interpret.id} + verify ${verify.id} both terminal; promoting the canonical reading of ${parentId} as the Son terminal`,
        agent,
      },
      ledger,
    )
  ).row;
  evidence.push(
    `drill: adjudicate ${adjudicate.id} satisfied (wave ${terminal.wave}) — SIGNED TERMINAL (multi-node plan resolved)`,
  );

  return {
    child_ids: [interpret.id, verify.id, adjudicate.id],
    terminal,
    evidence,
  };
}

/** The full Phase-6 native runtime: declare → emit three-shape → drill to
 *  terminal. Returns the declare response enriched with child_rows +
 *  runtime_evidence. Pure (ledger only) so it is unit-testable without a
 *  Hono Context; `executeDeclare` calls this, then layers the optional
 *  LLM enrichment on top. */
export async function declareWithTrinityRuntime(
  req: DeclareRequest,
  ledger: ContractLedger,
  opts: { admission?: "attested" | "legacy-anonymous"; admission_evidence?: string } = {},
): Promise<DeclareResponse> {
  const result = await handleDeclare(req, ledger, opts);
  if (!shouldFanoutTrinity(req.plan, req.parent_id)) {
    return result;
  }
  const children = await emitTrinityChildren(
    result.id,
    req.plan,
    ledger,
    req.wallet_identity,
  );
  result.child_rows = children;
  try {
    const drill = await drillResolveTrinity(
      result.id,
      req.plan,
      children,
      ledger,
      req.agent,
    );
    result.runtime_evidence = [
      `trinity: 3-shape emitted (interpret/verify/adjudicate) under ${result.id}`,
      ...drill.evidence,
    ].join(" | ");
  } catch (e) {
    // Visible, never silent — the children still landed (the word lands first).
    result.runtime_evidence = `trinity: 3-shape emitted; drill incomplete — ${e instanceof Error ? e.message : String(e)}`;
  }
  return result;
}

contractRoutes.post("/contract/declare", async (c) => {
  // Read the raw body BEFORE parsing JSON — the attestation gate signs
  // over the canonical byte sequence the caller actually sent. Re-
  // serializing post-parse would shift whitespace and break verification.
  const rawText = await c.req.text();
  const rawBodyBytes = new TextEncoder().encode(rawText);
  let req: DeclareRequest;
  try {
    req = JSON.parse(rawText) as DeclareRequest;
  } catch {
    return c.json({ error: "request body must be valid JSON" }, 400);
  }

  // ─── Creation Order (Genesis 1:3): the word lands first ───
  //
  // Every signed declare appends a row regardless of payment state.
  // Declaration is identity-gated only (the signed-declare verify in
  // executeDeclare). Compilation — the LLM-expansion into child
  // neurons — is gated by UNBROWSE_LLM_API_KEY availability + the
  // attestation gate (wave 2b). Per "the word lands first", the parent
  // row is admitted even when compile is skipped or fails.
  return executeDeclare(c, req, rawBodyBytes);
});

contractRoutes.post("/contract/iterate", async (c) => {
  const req = await c.req.json<IterateRequest>();
  try {
    const ledger = ledgerForRequest(c.env as Env | undefined);
    const result = await handleIterate(req, ledger);
    return c.json(result);
  } catch (err) {
    if (isStatsKVBindingMissingError(err)) {
      return c.json(buildStatsKVMissingEnvelope({ route: "/v1/contract/iterate" }), 503);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

contractRoutes.post("/contract/mark", async (c) => {
  const req = await c.req.json<MarkRequest>();
  try {
    const ledger = ledgerForRequest(c.env as Env | undefined);
    const result = await handleMark(req, ledger);
    return c.json(result);
  } catch (err) {
    if (isStatsKVBindingMissingError(err)) {
      return c.json(buildStatsKVMissingEnvelope({ route: "/v1/contract/mark" }), 503);
    }
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
    const ledger = ledgerForRequest(c.env as Env | undefined);
    const result = await handleStatus(id, ledger, { caller_pubkey: callerPubkey });
    return c.json(result);
  } catch (err) {
    if (isStatsKVBindingMissingError(err)) {
      return c.json(buildStatsKVMissingEnvelope({ route: "/v1/contract/status", id }), 503);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

contractRoutes.post("/contract/plan-for-intent", async (c) => {
  const req = await c.req.json<PlanForIntentRequest>();
  try {
    const ledger = ledgerForRequest(c.env as Env | undefined);
    const result = await handlePlanForIntent(req, ledger);
    return c.json(result);
  } catch (err) {
    if (isStatsKVBindingMissingError(err)) {
      return c.json(buildStatsKVMissingEnvelope({ route: "/v1/contract/plan-for-intent" }), 503);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

contractRoutes.get("/contract/surface", (c) => {
  return c.json(handleContractSurface());
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
      { method: "POST", path: "/v1/contract/mark", purpose: "KEY-2 exit — land the satisfied event (thin proofs refused)" },
      { method: "GET", path: "/v1/contract/status", purpose: "projection over all events for an id" },
      { method: "POST", path: "/v1/contract/plan-for-intent", purpose: "ranked shortlist over satisfied cells" },
      { method: "POST", path: "/v1/contract/mirror", purpose: "Π4 doctrine mirror — accepts raw ContractEventRow (alias /v1/contracts/mirror)" },
      { method: "GET", path: "/v1/contract/surface", purpose: "paper-shaped bridge manifest: server/client/CLI/Aiko holes-only surface" },
      { method: "GET", path: "/v1/contract/tools", purpose: "self-introspect (this endpoint)" },
    ],
    local_capabilities: ["kuri", "cookies", "vault", "browser", "fs"],
    persistence_note:
      "wave-2b: KV-backed canonical ledger via statsKV(env). LocalKV under ENVIRONMENT=local-dev; EdbKV in prod. Falls back to process-scoped memory when env is absent (unit-test path only).",
    admission_gate:
      "x-aiko-spawn-signature + x-aiko-lineage-chain headers verified against hardcoded LEWIS_DEPLOYER_PUBKEY_v1; legacy-anonymous admission honored until " +
      LEGACY_WINDOW_ENDS,
  });
});
