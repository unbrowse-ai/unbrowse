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
  indexContractRows,
  resolveLiveEmbedder,
  searchContracts,
} from "./contract-search.js";

const DEFAULT_NAMESPACE = "ubz-contracts";

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

/** KV key mapping an emergent-assigned vector id back to our contract id (emergent assigns
 *  its own content-addressed numeric id on insert, so the reverse map lives in KV). */
function vecMapKey(assignedId: number | string, namespace = DEFAULT_NAMESPACE): string {
  return `${namespace}:vecmap:${assignedId}`;
}

/**
 * ContractVectorStore backed by the LIVE emergent vector API (/vectors/insert + /vectors/search).
 * Emergent assigns its own id on insert (the input id is ignored), so upsert self-searches to
 * learn the assigned id and writes a KV reverse-map; search resolves assigned ids back to our
 * contract ids via that map. Mirrors backend/services/semantic-cache.ts's proven pattern.
 */
export function emergentVectorStore(namespace = DEFAULT_NAMESPACE): ContractVectorStore {
  const headers = () => ({ Authorization: `Bearer ${emergentKey()}`, "Content-Type": "application/json" });
  return {
    async upsert(id: string, vector: number[]): Promise<void> {
      if (vector.length !== EMERGENTDB_VECTOR_DIM) {
        throw new Error(`emergent vector must be ${EMERGENTDB_VECTOR_DIM}-dim, got ${vector.length}`);
      }
      const ins = await fetch(`${EMERGENTDB_BASE}/vectors/insert`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ id: 1, vector, namespace }),
        signal: AbortSignal.timeout(emergentTimeoutMs()),
      });
      if (!ins.ok) throw new Error(`vectors/insert ${ins.status}: ${(await ins.text()).slice(0, 200)}`);
      // Learn the emergent-assigned id via a self-search, then persist the reverse map.
      const sr = await fetch(`${EMERGENTDB_BASE}/vectors/search`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ vector, k: 1, namespace }),
        signal: AbortSignal.timeout(emergentTimeoutMs()),
      });
      if (!sr.ok) throw new Error(`vectors/search(self) ${sr.status}: ${(await sr.text()).slice(0, 200)}`);
      const assigned = ((await sr.json()) as { results?: Array<{ id: number | string }> }).results?.[0]?.id;
      if (assigned !== undefined) await kvSet(vecMapKey(assigned, namespace), id);
    },
    async search(vector: number[], k: number): Promise<ScoredId[]> {
      const sr = await fetch(`${EMERGENTDB_BASE}/vectors/search`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ vector, k, namespace }),
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
      const live = await resolveLiveEmbedder(process.env);
      if (live) { embed = live.embed; out.embedder = live.provider; }
    }
    if (!embed) {
      out.notes.push("rag: no embedder available (OPENAI_API_KEY / ollama) — skipped");
    } else {
      const row: ContractRow = { id: c.id, text: c.text };
      await indexContractRows([row], embed, emergentVectorStore(namespace));
      out.rag = true;
    }
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
    if (!embed) {
      const live = await resolveLiveEmbedder(process.env);
      if (live) embed = live.embed;
    }
    if (!embed) {
      r.notes.push("rag: no embedder available — skipped");
    } else {
      await indexContractRows([{ id, text }], embed, emergentVectorStore(namespace));
      r.rag = true;
    }
  } catch (e) {
    r.notes.push(`rag: ${e instanceof Error ? e.message : String(e)}`);
  }
  return r;
}

/** Recall a contract's cached value: emergent KV fast tier first, IQ durable tier behind. */
export async function recallContract(
  id: string,
  opts: { namespace?: string } = {},
): Promise<unknown | null> {
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  try {
    const cached = await kvGet(contractCacheKey(id, namespace));
    if (cached != null) return JSON.parse(cached);
  } catch { /* fall through to IQ */ }
  try {
    const ledger = await resolutionLedgerFromEnv(process.env);
    if (ledger) {
      const hit = await ledger.find(id);
      if (hit) return JSON.parse(hit.result);
    }
  } catch { /* not configured */ }
  return null;
}

/** Semantic search across persisted contracts via emergent RAG. Returns contract ids best-first. */
export async function searchContractsEverywhere(
  query: string,
  opts: { namespace?: string; k?: number; embedder?: Embedder } = {},
): Promise<ScoredId[]> {
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  let embed = opts.embedder;
  if (!embed) {
    const live = await resolveLiveEmbedder(process.env);
    if (!live) throw new Error("searchContractsEverywhere: no embedder available");
    embed = live.embed;
  }
  return searchContracts(query, embed, emergentVectorStore(namespace), opts.k ?? 5);
}
