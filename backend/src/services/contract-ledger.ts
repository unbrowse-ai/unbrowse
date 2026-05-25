/**
 * Cloud-side append-only contract event ledger (foundation).
 *
 * This is stage 2 of organ b9c8a64d ("unbrowse runtime is isomorphic to a
 * /contract organism"). Per the local/cloud split refinement (1db6f5e3,
 * gated by contract:50d0419e pointers-over-payload): the LEDGER lives in
 * the cloud Worker — never local. The local CLI/MCP holds only pointers
 * to capabilities (browser, cookies, vault, kuri binary, per-session
 * state) and STREAMS events to this ledger; this module is the cloud-
 * side recipient.
 *
 * Foundation only — schema vocabulary + interface stubs. The
 * append-to-EmergentDB / append-to-KV wiring is a downstream stage
 * (carried by a future child of b9c8a64d, not stage 2 itself). Same
 * pattern as stage 1 (d00ac17d): the type lands first; the consumer
 * lands later.
 *
 * Row schema mirrors ~/.claude/skills/contract/scripts/lib/contract_core.py
 * one-to-one. Any drift between this file and contract_core.py is a
 * substrate-isomorphism break — flag it as a contract.
 */

import type { ContractRef } from "../types";

/**
 * Discrete event types that may be appended to the ledger. Matches the
 * shapes contract_core.py emits — `declared`, `iterated`, `satisfied`,
 * `merged`, `spawned`, `corroborated`, `learned`, `crystallized`,
 * `promoted`. Any new event type added to the python core must land
 * here too (the substrate's append-only invariant means events are
 * additive, not mutative — so this union grows but never shrinks).
 */
export type ContractEventType =
  | "declared"
  | "iterated"
  | "satisfied"
  | "merged"
  | "spawned"
  | "corroborated"
  | "learned"
  | "crystallized"
  | "promoted";

/**
 * Pointer types — categorizes how the action resolves. `cli` runs a
 * local shell command, `api` is an HTTP endpoint, `contract-ref` is
 * `contract:<id>` resolving to another contract's status. Composition
 * shapes (`funnel`, `sequence`, `quorum:N`, `funnel-first`,
 * `loop-until:<body>`, `harness:<path>`, `tool-guard:<glob>`,
 * `agent-judges`) sit alongside these and are stored in the action
 * field directly.
 */
export type ContractPointerType = "cli" | "api" | "contract-ref" | "sequence" | "funnel" | "funnel-first" | "quorum" | "loop" | "harness" | "tool-guard" | "agent-judges";

/**
 * One event row. The same shape every event uses — discriminated by
 * `event`. Fields not relevant to a given event are simply absent
 * (TypeScript's optional-property semantics match the JSONL row's
 * "key not present" honestly, unlike `key: null`).
 */
export interface ContractEventRow {
  /** Discrete event type — discriminator. */
  event: ContractEventType;
  /** The contract this event is about. */
  id: string;
  /** ISO-8601 UTC timestamp. */
  ts: string;
  /** Author identity (Σ1 attribution default — env CONTRACT_AGENT or git user.email). */
  agent?: string;

  // declared-event fields
  /** Truth claim — the plan text. Present on `declared`, `spawned`, `learned`. */
  plan?: string;
  /** Action pointer — shell command, contract:<id>, composition shape, etc. */
  action?: string;
  /** Pointer category — see ContractPointerType. */
  pointer_type?: ContractPointerType;
  /** Parent organ id (for children). */
  parent_id?: string;
  /** Declare-time cwd — actions run from here. */
  cwd?: string;
  /** Optional learning attached at declare time (auto-crystallize on satisfy). */
  learning?: string;
  /** Optional budget — wave cap signal for sequence stages. */
  budget?: number;

  /**
   * Visibility class — controls who can READ this row via /v1/contract/status.
   *
   *   "lineage"    (default) — only callers carrying a wallet_identity whose
   *                pubkey appears in this row's parent_signature lineage chain
   *                can read. Outside the chain, /v1/contract/status returns
   *                a synthetic empty {rows: []} (security-through-obscurity).
   *   "public"     — anyone can read. Use for clearly-public truth claims
   *                (audit probes, shared infrastructure, posted demos).
   *   "marketplace" — listed in /v1/contract/plan-for-intent, callable from
   *                any agent, but only after replication payment per
   *                replicated_from_contract_id / replication_payment_scheme.
   *
   * Reality parallel: synaptic specificity. A neuron's content is not
   * broadcast; only synaptic partners (typed edges) can receive. Outside the
   * graph, the neuron's state is genuinely invisible — not encrypted, just
   * not broadcast.
   */
  visibility?: "lineage" | "public" | "marketplace";

  /**
   * Ed25519 pubkey of the wallet that signed this declare. When set,
   * subsequent /v1/contract/status reads from a caller carrying the same
   * pubkey (or a descendant pubkey via parent_signature chain) succeed.
   * Empty = anonymous declare (auto-coerced to visibility="public").
   */
  wallet_identity?: string;

  /** Ed25519 signature over the canonical declare body, signed by wallet_identity. */
  declare_signature?: string;

  // iterated-event fields
  /** Monotonic wave counter — increments per iterate. */
  wave?: number;
  /** Exit code from the action (cli pointers). */
  action_exit?: number;
  /** Coarse result label — "pass" | "fail" | "agent-judges" | "error". */
  action_result?: string;
  /** Agent's in-thread KEY 2 verdict — "genuine" | "fake-green" | null. */
  agent_verdict?: string | null;
  /** Child IDs spawned during this iterate. */
  children_spawned?: string[];

  // merged-event fields
  /** Winner id this row's contract was superseded into. */
  merged_into?: string;
  /** Human-readable reason for the supersession. */
  reason?: string;

  // corroborate-event fields
  /** The synapse partner — bidirectional contract reference. */
  corroborate_with?: ContractRef;

  // crystallized-event fields
  /** Path to the memory file the learning was crystallized into. */
  memory_path?: string;
  /** URL of the Outline document the learning was crystallized into. */
  outline_url?: string;
}

/**
 * Append-only writer interface. Returns the row that was written
 * (with `ts` populated if the caller omitted it). Idempotency is the
 * caller's job — pass the same row twice and the ledger grows by one
 * extra row. The substrate's truth invariant is APPEND-ONLY, not
 * exactly-once. The ledger IS the query history; duplicates are
 * recoverable by reading and re-applying status priority.
 *
 * @returns the row as persisted (with server-stamped ts if missing).
 * @throws if the row would violate the schema (missing required field
 *         for the event type, malformed pointer_type, etc).
 */
export interface ContractLedgerAppender {
  append(row: ContractEventRow): Promise<ContractEventRow>;
}

/**
 * Read-side. Mirrors contract_core.py's `get(id)` + `list_all()` +
 * `get_tree(id)`. Status is the projection over all events for the
 * id, with priority `merged > satisfied > active > pending`.
 */
export interface ContractLedgerReader {
  get(id: string): Promise<ContractEventRow[] | null>;
  listAll(opts?: { showMerged?: boolean }): Promise<ContractEventRow[]>;
  /** Children of a parent organ — derived from `parent_id` edges. */
  listChildren(parentId: string): Promise<ContractEventRow[]>;
}

/**
 * Convenience combined interface. Concrete implementations land in a
 * downstream stage of organ b9c8a64d — one backed by EmergentDB
 * (rows in a typed table + index by id and parent_id), one backed by
 * KV (id-keyed for hot reads). Foundation file ships the SHAPE only.
 */
export interface ContractLedger extends ContractLedgerAppender, ContractLedgerReader {}

/**
 * Compute the projected status of a contract by reading every event
 * row for its id and applying the documented priority. Pure function
 * — no I/O. Mirrors contract_core.py's get() status derivation at
 * line 305-330. Exported for tests and for downstream consumers that
 * receive raw event arrays.
 */
/**
 * Lineage visibility check — given the declared row of a contract and the
 * caller's wallet pubkey, can the caller READ this row?
 *
 *   - visibility="public"     → always yes
 *   - visibility="marketplace" → yes (read is free; replication is paid separately)
 *   - visibility="lineage" (default) → yes iff caller_pubkey appears on the
 *     row's wallet_identity OR on any ancestor's wallet_identity reachable
 *     via parent_id walk. Self-declared (wallet_identity unset / empty) rows
 *     are treated as anonymous-public to preserve pre-visibility-field
 *     backwards compat.
 *
 * Reality parallel: a neuron's content is visible to its presynaptic +
 * postsynaptic partners; outside the synapse graph, the neuron is dark.
 */
export function isCallerInLineage(
  declaredRow: ContractEventRow,
  callerPubkey: string | null | undefined,
  walkParent: (parentId: string) => ContractEventRow | null,
): boolean {
  const visibility = declaredRow.visibility ?? "lineage";
  if (visibility === "public" || visibility === "marketplace") return true;
  // Lineage mode. Pre-visibility rows with no wallet_identity are anonymous
  // — treat as public to preserve back-compat. New rows carrying a wallet
  // require the caller to match the chain.
  const rowOwner = declaredRow.wallet_identity;
  if (!rowOwner) return true;
  if (!callerPubkey) return false;
  if (rowOwner === callerPubkey) return true;
  // Walk parent_id chain, checking each ancestor's wallet_identity.
  let cursor: string | undefined = declaredRow.parent_id;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = walkParent(cursor);
    if (!parent) break;
    if (parent.wallet_identity === callerPubkey) return true;
    cursor = parent.parent_id;
  }
  return false;
}

export function projectStatus(rows: ContractEventRow[]): "pending" | "active" | "satisfied" | "merged" {
  const hasMerged = rows.some((r) => r.event === "merged");
  if (hasMerged) return "merged";
  const hasSatisfied = rows.some((r) => r.event === "satisfied");
  if (hasSatisfied) return "satisfied";
  const hasIterated = rows.some((r) => r.event === "iterated");
  if (hasIterated) return "active";
  return "pending";
}

/**
 * Minimal projection of a SkillOperationGraph onto contract organism
 * shape — stage 4 of organ b9c8a64d.
 *
 * Maps:
 *   SkillOperationGraph  →  one parent organ row (action: 'sequence' if
 *                           entry_operation_ids is ordered + non-empty,
 *                           else 'funnel' / 'children-satisfy')
 *   each SkillOperationNode  →  one child cell row whose `parent_id` is
 *                               the parent organ's id
 *   each SkillOperationEdge  →  contract-ref between two child rows
 *                               (via the action='contract:<id>' form
 *                               carried on the consumer side)
 *
 * Pure function — no I/O, no clock. The caller stamps `ts` if a real
 * ledger event needs writing; for projection-only callers (preview,
 * documentation, tests) the rows ship without ts.
 *
 * Foundation only — the appender wire that ACTUALLY writes these rows
 * to the ledger on cachePublishedSkill is a downstream stage. Today
 * this function is the proof that the mapping exists; consumers in
 * later stages call it.
 *
 * @param parentOrganId — the id under which the projected graph lives.
 *                       Callers pass `skill_id` typically.
 * @param graph — the SkillOperationGraph to project. Minimal shape
 *                only; consumers may pass the wider type since this
 *                function only reads the named fields.
 */
export interface SkillGraphProjectionShape {
  entry_operation_ids: string[];
  operations: Array<{ operation_id: string; title?: string }>;
  edges: Array<{ from: string; to: string }>;
}

export function projectSkillGraphToOrgan(
  parentOrganId: string,
  graph: SkillGraphProjectionShape,
): ContractEventRow[] {
  const rows: ContractEventRow[] = [];
  const ordered = graph.entry_operation_ids?.length === graph.operations.length;
  const parentAction = ordered ? "sequence" : "funnel";
  const parentPointerType: ContractPointerType = ordered ? "sequence" : "funnel";

  rows.push({
    event: "declared",
    id: parentOrganId,
    ts: "", // caller stamps
    plan: `skill operation graph — ${graph.operations.length} operations, ${graph.edges.length} edges`,
    action: parentAction,
    pointer_type: parentPointerType,
  });

  for (const op of graph.operations) {
    rows.push({
      event: "declared",
      id: op.operation_id,
      ts: "",
      plan: op.title ?? `operation ${op.operation_id}`,
      action: "agent-judges", // foundation: every operation is a judgment cell
      pointer_type: "agent-judges",
      parent_id: parentOrganId,
    });
  }

  // Edges become contract-ref-shaped actions on the CONSUMER side.
  // Stage 4 foundation only declares the projection; stage 4.5 wires
  // the consumer cells to actually carry contract:<from> actions.
  // The edge rows are emitted as `spawned`-event rows here so the
  // projection round-trips losslessly (the consumer of these rows can
  // reconstruct the full DAG from the row array alone).
  for (const edge of graph.edges) {
    rows.push({
      event: "spawned", // schema-compat event for an edge-derived child link
      id: edge.to,
      ts: "",
      parent_id: edge.from, // semantically: 'to depends on from'
      action: `contract:${edge.from}`,
      pointer_type: "contract-ref",
    });
  }

  return rows;
}

/**
 * Stage 5 of organ b9c8a64d — resolve-as-search projection.
 *
 * The truth claim: `unbrowse resolve --intent X` is structurally the
 * same operation as `contract search --context X --filter
 * status=satisfied,shape=cell`. Both consume an intent string and a
 * corpus of declared truth claims; both emit a ranked shortlist with
 * evidence; both leave the picker to the calling LLM. Stage 5 makes
 * the projection explicit so any consumer can confirm the
 * isomorphism by reading evidence-shape only — never by re-running
 * either side's heuristic.
 *
 * Foundation only: the function below DEFINES the shortlist shape and
 * the per-row evidence carrier. The BM25 / embed scoring lands in a
 * downstream stage that wires this to contract-habit-detect.py's
 * actual scorer (or the unbrowse resolve ranker — they should
 * eventually share one implementation). Today this returns the
 * IDs in input order with score=1.0, proving the API surface.
 */
export interface SatisfiedCellMatch {
  /** The cell contract id. */
  id: string;
  /** Its plan text — the truth claim being matched against intent. */
  plan: string;
  /** Hybrid BM25+embed score in [0,1]. Foundation stage returns 1.0. */
  score: number;
  /** Why the cell was surfaced — evidence the calling LLM reads. */
  why: string;
}

export function searchSatisfiedCells(
  intent: string,
  satisfiedCells: Array<{ id: string; plan: string }>,
  _opts?: { limit?: number },
): SatisfiedCellMatch[] {
  // Foundation: identity projection with placeholder score. The real
  // BM25+embed hybrid (mirroring contract-habit-detect.py) lands when
  // the consumer wire is built.
  const intentTrim = intent.trim();
  return satisfiedCells.map((cell) => ({
    id: cell.id,
    plan: cell.plan,
    score: 1.0,
    why: intentTrim
      ? `foundation projection — intent="${intentTrim}" matched against cell.plan`
      : "foundation projection — no intent supplied",
  }));
}

/**
 * Stage 6 of organ b9c8a64d — execute-as-iterate projection.
 *
 * Mapping: `unbrowse execute <endpoint-id>` ≡ `contract iterate
 * <endpoint-cell-id>`. KEY 1 is the HTTP status (2xx → pass, else
 * fail). KEY 2 is the calling agent's in-thread judgment of
 * "response satisfies intent" (carried as agent_verdict on the
 * appended row). The substrate's two-key exit IS the existing
 * "two tool calls is the contract" invariant in unbrowse.
 */
export interface ExecuteAsIterateInput {
  cellId: string;
  wave: number;
  httpStatus: number;
  /** Optional agent judgment supplied alongside execute (KEY 2). */
  agentVerdict?: "genuine" | "fake-green" | null;
}

export function executeAsIterateRow(
  input: ExecuteAsIterateInput,
): ContractEventRow {
  const passed = input.httpStatus >= 200 && input.httpStatus < 300;
  return {
    event: "iterated",
    id: input.cellId,
    ts: "", // caller stamps
    wave: input.wave,
    action_exit: passed ? 0 : 1,
    action_result: passed ? "pass" : "fail",
    agent_verdict: input.agentVerdict ?? null,
  };
}

/**
 * Stage 7 of organ b9c8a64d — MCP-as-tool-guard projection.
 *
 * Mapping: every marketplace endpoint cell registers an MCP tool;
 * the tool is "open" iff the cell's status is satisfied (or merged
 * — fossils are equally-resolved per substrate-bug fix c9e9a127).
 * Session-scoped tools (unbrowse_snap/click/etc.) are tool-guards
 * bound to a browse-session parent organ; closing the session marks
 * the parent satisfied and lifts the guards' open state to closed.
 * That's why those 15 tools "disconnect after close" — it IS the
 * substrate's lifecycle, made mechanical.
 */
export interface McpToolGuardDescriptor {
  /** The MCP tool name. */
  toolName: string;
  /** The cell contract whose status gates this tool. */
  guardingCellId: string;
  /** Whether the tool is currently open (the substrate's projection,
   *  not a re-check — caller asked at row-read time). */
  open: boolean;
}

export function mcpToolGuardForCell(
  toolName: string,
  cellId: string,
  cellStatus: ReturnType<typeof projectStatus>,
): McpToolGuardDescriptor {
  // A guard is OPEN when its cell is satisfied OR merged (fossil
  // truth is carried by the winner; the guard should lift either way).
  // This is the same {satisfied, merged} acceptance set the sequence
  // walker now honors (c9e9a127). One substrate, one resolved-set.
  const open = cellStatus === "satisfied" || cellStatus === "merged";
  return { toolName, guardingCellId: cellId, open };
}
