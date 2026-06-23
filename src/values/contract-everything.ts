/**
 * contract-everything — the unification seam for the crypto-was-all-you-needed stack.
 *
 * One truth-claim ("a /contract") travels through every tier of the stack via this
 * single surface, so each runtime layer routes through ONE place instead of
 * re-implementing the wiring:
 *
 *   persist(row)  →  IQ on-chain signed ledger   (durable, wallet-signed history)
 *                 →  emergent KV cache            (content-addressed O(1) recall)
 *                 →  emergent vector index        (RAG-searchable by meaning)
 *   recall(id)    →  emergent KV  →  IQ fallback  (fast tier first, durable behind)
 *   search(query) →  emergent vector RAG          (semantic discovery across contracts)
 *
 * The pieces already existed but were orphaned: iq-ledger.ts (IQ), emergentdb-vectors.ts
 * (live KV+vector client), contract-search.ts (the RAG abstraction + embedders). This
 * module bridges contract-search's abstract ContractVectorStore to the LIVE emergent
 * vector API and composes all three tiers. Live deps (IQ signer/RPC, EMERGENTDB_API_KEY,
 * an embedder) are resolved from env; absence is surfaced, never silently swallowed.
 */

import { createHash } from "node:crypto";
import { resolutionLedgerFromEnv } from "./iq-ledger.js";
import {
  EMERGENTDB_BASE,
  EMERGENTDB_VECTOR_DIM,
  kvGet,
  kvSet,
} from "./emergentdb-vectors.js";
import {
  type ContractRow,
  type ContractVectorStore,
  type Embedder,
  type ScoredId,
  hashEmbedder,
  indexContractRows,
  resolveLiveEmbedder,
  searchContracts,
} from "./contract-search.js";

const DEFAULT_NAMESPACE = "ubz-contracts";

/**
 * The embedder the indexing/search seam ALWAYS gets — never null. Prefers a live SEMANTIC
 * embedder (contract-native llama.cpp :8090 / OpenAI / Nebius), and when none answer it falls
 * to the substrate's OWN embedded feature-hash embedder at 1536 dim (no model, no server, no
 * key — runs identically in the CLI, the Worker backend, and the frontend). This fulfils
 * resolveLiveEmbedder's documented promise ("then the offline hashEmbedder bears the load")
 * so the searchable passive-index tier degrades to lexical recall instead of silently skipping.
 * The provider is surfaced, never silent — "embedded-hash-1536" means this row was indexed
 * lexically (a hash query against a hash-indexed store is internally consistent).
 */
export async function embedderForIndexing(
  env: Record<string, string | undefined> = process.env,
): Promise<{ embed: Embedder; provider: string }> {
  const live = await resolveLiveEmbedder(env);
  if (live) return live;
  return { embed: hashEmbedder(1536), provider: "embedded-hash-1536" };
}

function emergentKey(): string {
  const k = (typeof process !== "undefined" ? process.env?.EMERGENTDB_API_KEY : undefined)?.trim();
  if (!k) throw new Error("EMERGENTDB_API_KEY not set");
  return k;
}

function emergentTimeoutMs(): number {
  const n = Number(typeof process !== "undefined" ? process.env?.EMERGENTDB_TIMEOUT_MS : undefined);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/** KV key under which a contract's value payload is cached. */
export function contractCacheKey(id: string, namespace = DEFAULT_NAMESPACE): string {
  return `${namespace}:contract:${id}`;
}

/** KV key mapping our self-computed numeric vector id back to our contract id. The CALLER owns
 *  the id (emergent's VectorEntry.id is a caller-supplied positive int — emergentdb-js SDK), so
 *  the reverse map is keyed on the deterministic id we derived from the contract id. */
function vecMapKey(assignedId: number | string, namespace = DEFAULT_NAMESPACE): string {
  return `${namespace}:vecmap:${assignedId}`;
}

/**
 * Stable positive-integer vector id for a contract id — sha256(id) folded into a safe positive
 * int (< 2^48, well under Number.MAX_SAFE_INTEGER). EmergentDB's VectorEntry.id is a CALLER-supplied
 * positive int (the SDK + arch-clarification doc: hash skill_id:endpoint_id → positive int), so the
 * same contract id always maps to the same vector id — inserts are idempotent UPSERTS, not duplicates,
 * and search results map back to the contract id with no extra round-trip.
 */
export function stableVectorId(id: string): number {
  const h = createHash("sha256").update(id).digest();
  // first 6 bytes → unsigned 48-bit int (safe, positive, < 2^53)
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + h[i];
  return n + 1; // +1 guarantees strictly positive (VectorEntry.id is .positive())
}

/**
 * ContractVectorStore backed by the LIVE emergent vector API (/vectors/insert + /vectors/search).
 * Per the emergentdb-js SDK: the caller supplies a positive-int id (we derive it deterministically
 * via stableVectorId), insert returns that id, and search returns {id, score} — so NO self-search
 * round-trip is needed and identical content upserts in place instead of colliding on a fixed id.
 */
export function emergentVectorStore(namespace = DEFAULT_NAMESPACE): ContractVectorStore {
  const headers = () => ({
    Authorization: `Bearer ${emergentKey()}`,
    "Content-Type": "application/json",
    "User-Agent": "emergentdb-js/0.0.11", // canonical SDK UA — a generic UA trips Cloudflare 1010 at the edge
  });
  return {
    async upsert(id: string, vector: number[]): Promise<void> {
      if (vector.length !== EMERGENTDB_VECTOR_DIM) {
        throw new Error(`emergent vector must be ${EMERGENTDB_VECTOR_DIM}-dim, got ${vector.length}`);
      }
      const numId = stableVectorId(id);
      const ins = await fetch(`${EMERGENTDB_BASE}/vectors/insert`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ id: numId, vector, namespace }),
        signal: AbortSignal.timeout(emergentTimeoutMs()),
      });
      if (!ins.ok) throw new Error(`vectors/insert ${ins.status}: ${(await ins.text()).slice(0, 200)}`);
      // We own the id (no emergent-assigned id, no self-search) — persist the reverse map directly.
      await kvSet(vecMapKey(numId, namespace), id);
    },
    async search(vector: number[], k: number): Promise<ScoredId[]> {
      const sr = await fetch(`${EMERGENTDB_BASE}/vectors/search`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ vector, k, include_metadata: false, namespace }),
        signal: AbortSignal.timeout(emergentTimeoutMs()),
      });
      if (!sr.ok) throw new Error(`vectors/search ${sr.status}: ${(await sr.text()).slice(0, 200)}`);
      const hits = ((await sr.json()) as { results?: Array<{ id: number | string; score: number }> }).results ?? [];
      const out: ScoredId[] = [];
      for (const h of hits) {
        const contractId = await kvGet(vecMapKey(h.id, namespace));
        if (contractId) out.push({ id: contractId, score: h.score });
      }
      return out;
    },
  };
}

/** A contract to persist across the whole stack: stable id, embeddable text, and the value payload. */
export interface ContractEverything {
  id: string;
  /** Intent/summary text the RAG layer embeds. */
  text: string;
  /** The resolved value (any JSON) cached in emergent KV + recorded on IQ. */
  value: unknown;
}

export interface PersistOutcome {
  iq: boolean;
  kv: boolean;
  rag: boolean;
  embedder?: string;
  /** Per-tier failure reasons, surfaced never-silent. */
  notes: string[];
}

/**
 * Persist one contract across IQ + emergent KV + emergent RAG. Best-effort per tier:
 * a tier that is unconfigured/unavailable is recorded in `notes` (visible, never silent),
 * the others still land. Returns which tiers succeeded so callers/gates can assert.
 */
/** The emitted three-shape verdict shape (mirror of contract-shape.ts ContractVerdict — kept
 *  structural to avoid dragging the CLI output module into this value layer). */
export interface VerdictShape {
  terminal: boolean;
  settled: string[];
  frontier: string | null;
  engine: string;
}

/** Content-addressed id for a verdict: same (intent, settled-shape) → same on-chain row. */
export function verdictContractId(intent: string, verdict: VerdictShape): string {
  return (
    "verdict-" +
    createHash("sha256")
      .update(`${intent}\x00${verdict.settled.join(">")}\x00${verdict.terminal}`)
      .digest("hex")
      .slice(0, 16)
  );
}

/**
 * persistVerdictOnChain — the seam that makes an emitted /contract verdict ACTUALLY on-chain.
 *
 * "Make it actually /contract so it's on chain with a web2 wrapper for 402": the emitted
 * interpret→verify→adjudicate verdict is mapped into the unified ContractEverything row and routed
 * through persistContract, whose Tier-1 is the IQ signed on-chain ledger (ledger.append — a real
 * wallet-signed chain write). The "web2 wrapper for 402" is the substrate's existing wallet path:
 * the on-chain write is satisfied by the wallet derived from the operator's keypair, and any priced
 * cloud seam returns the canonical 402 envelope which the x402 layer (src/payments/x402-fetch.ts)
 * settles — the caller never sees a payment header. Fail-open + honest-skip: when the IQ env
 * (RPC/signer/db ids) is absent, the on-chain tier is skipped with a note, never a fabricated write.
 */
export async function persistVerdictOnChain(
  verdict: VerdictShape,
  intent: string,
  opts: { namespace?: string; embedder?: Embedder } = {},
): Promise<PersistOutcome> {
  return persistContract(
    { id: verdictContractId(intent, verdict), text: intent, value: verdict },
    opts,
  );
}

export async function persistContract(
  c: ContractEverything,
  opts: { namespace?: string; embedder?: Embedder } = {},
): Promise<PersistOutcome> {
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  const out: PersistOutcome = { iq: false, kv: false, rag: false, notes: [] };

  // Tier 1 — IQ on-chain signed ledger.
  try {
    const ledger = await resolutionLedgerFromEnv(process.env);
    if (!ledger) {
      out.notes.push("iq: not configured (RPC/signer/db ids absent) — skipped");
    } else {
      await ledger.append(c.id, JSON.stringify(c.value));
      out.iq = true;
    }
  } catch (e) {
    out.notes.push(`iq: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Tier 2 — emergent KV content-addressed cache.
  try {
    await kvSet(contractCacheKey(c.id, namespace), JSON.stringify(c.value));
    out.kv = true;
  } catch (e) {
    out.notes.push(`kv: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Tier 3 — emergent vector RAG index (needs a 1536-dim embedder).
  try {
    let embed = opts.embedder;
    if (!embed) {
      const chosen = await embedderForIndexing(process.env);
      embed = chosen.embed;
      out.embedder = chosen.provider;
    }
    const row: ContractRow = { id: c.id, text: c.text };
    await indexContractRows([row], embed, emergentVectorStore(namespace));
    out.rag = true;
  } catch (e) {
    out.notes.push(`rag: ${e instanceof Error ? e.message : String(e)}`);
  }

  return out;
}

/**
 * Emergent-only mirror for the resolution boundary, where IQ is already written by
 * mirrorResolutionToChain. Caches the value in emergent KV and indexes it for RAG.
 * Fail-open + fire-and-forget friendly: a no-op (with a returned note) when the
 * emergent key / embedder is absent, never throws into the resolve hot path.
 */
export async function mirrorToEmergent(
  id: string,
  text: string,
  value: unknown,
  opts: { namespace?: string; embedder?: Embedder } = {},
): Promise<{ kv: boolean; rag: boolean; notes: string[] }> {
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  const r = { kv: false, rag: false, notes: [] as string[] };
  // Cheap no-op when the emergent tier is unconfigured (the IQ-tier `chainLedger`
  // short-circuit equivalent): skip BEFORE any embedder probe / network call so a
  // normal CLI with no EMERGENTDB key never fires background work on the hot path.
  const hasEmergent = (typeof process !== "undefined" ? process.env?.EMERGENTDB_API_KEY : undefined)?.trim();
  if (!hasEmergent) {
    r.notes.push("emergent: EMERGENTDB_API_KEY absent — skipped");
    return r;
  }
  try {
    await kvSet(contractCacheKey(id, namespace), JSON.stringify(value));
    r.kv = true;
  } catch (e) {
    r.notes.push(`kv: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    let embed = opts.embedder;
    if (!embed) embed = (await embedderForIndexing(process.env)).embed;
    await indexContractRows([{ id, text }], embed, emergentVectorStore(namespace));
    r.rag = true;
  } catch (e) {
    r.notes.push(`rag: ${e instanceof Error ? e.message : String(e)}`);
  }
  return r;
}

/** Which tier served (or failed) a recall — the web2-cache-wraps-web3-ledger path, made OBSERVABLE.
 * `kv-hit` = the emergent KV cache (web2) served; `iq-fallback` = the IQ ledger (web3) served on a
 * KV miss; `miss` = neither had it; `kv-error`/`iq-error` = a tier threw (surfaced, not swallowed). */
export type RecallTier = "kv-hit" | "iq-fallback" | "miss" | "kv-error" | "iq-error";

/** PURE recall core — the web2-cache-wraps-web3-ledger decision, with the two lookups INJECTED so it
 * is testable COLD (no network). `onTier` makes the wrap OBSERVABLE: a `kv-hit` means the emergent KV
 * cache (web2) served; `iq-fallback` means the IQ ledger (web3) served on a KV miss; `miss` means
 * neither; `kv-error`/`iq-error` surface a thrown tier (fallbacks visible, never silent — the old
 * `catch {}` swallowed these). */
export async function recallContractVia(
  id: string,
  deps: {
    kvGet: (key: string) => Promise<string | null>;
    findInLedger: (id: string) => Promise<{ result: string } | null>;
    namespace?: string;
    onTier?: (tier: RecallTier, detail?: unknown) => void;
  },
): Promise<unknown | null> {
  const namespace = deps.namespace ?? DEFAULT_NAMESPACE;
  const note = deps.onTier ?? (() => {});
  try {
    const cached = await deps.kvGet(contractCacheKey(id, namespace));
    if (cached != null) { note("kv-hit"); return JSON.parse(cached); }
  } catch (e) { note("kv-error", e); /* fall through to IQ */ }
  try {
    const hit = await deps.findInLedger(id);
    if (hit) { note("iq-fallback"); return JSON.parse(hit.result); }
  } catch (e) { note("iq-error", e); /* not configured */ }
  note("miss");
  return null;
}

/** Recall a contract's cached value: emergent KV fast tier first, IQ durable tier behind. Wires the
 * live lookups into the pure `recallContractVia` core; `opts.onTier` observes which tier served.
 * The observer is optional + side-effect-free by default, so existing callers are unchanged. */
export async function recallContract(
  id: string,
  opts: { namespace?: string; onTier?: (tier: RecallTier, detail?: unknown) => void } = {},
): Promise<unknown | null> {
  return recallContractVia(id, {
    kvGet,
    findInLedger: async (i) => {
      const ledger = await resolutionLedgerFromEnv(process.env);
      return ledger ? await ledger.find(i) : null;
    },
    namespace: opts.namespace,
    onTier: opts.onTier,
  });
}

/** Semantic search across persisted contracts via emergent RAG. Returns contract ids best-first. */
export async function searchContractsEverywhere(
  query: string,
  opts: { namespace?: string; k?: number; embedder?: Embedder } = {},
): Promise<ScoredId[]> {
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  let embed = opts.embedder;
  if (!embed) embed = (await embedderForIndexing(process.env)).embed;
  return searchContracts(query, embed, emergentVectorStore(namespace), opts.k ?? 5);
}
