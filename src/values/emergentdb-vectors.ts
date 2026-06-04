/**
 * EmergentDB vector + KV client — the semantic-recall and content-addressed-cache
 * tier of the resolution ledger. EmergentDB wraps the IQ on-chain platform; this
 * module is the thin, typed surface unbrowse uses.
 *
 * Discovered API (verified live 2026-06-04 against api.emergentdb.com):
 *   POST /vectors/search   { query: number[1536], k }  -> { results:[{id,score}], count, namespace }
 *   POST /qdkv/mget        { keys: string[] }           -> { values: { key: string|null } }
 *   POST /qdkv/set         { key, value }               -> { ok: true }
 *   GET  /qdkv/get/<key>                                -> { found, value }
 * Auth: `Authorization: Bearer <EMERGENTDB_API_KEY>`. Tenant is derived from the
 * key server-side — endpoints are NOT tenant-prefixed (a `/<tenant>/vectors/...`
 * path with a non-matching tenant returns 403 "tenant mismatch"). Embeddings are
 * 1536-dim (OpenAI text-embedding-3-small); a wrong dim returns 400.
 */

export const EMERGENTDB_BASE = "https://api.emergentdb.com";
export const EMERGENTDB_VECTOR_DIM = 1536;

export interface VectorHit {
  id: number | string;
  score: number;
}

export interface VectorSearchResponse {
  results: VectorHit[];
  count: number;
  namespace: string;
}

function apiKey(): string {
  const k = (typeof process !== "undefined" ? process.env?.EMERGENTDB_API_KEY : undefined)?.trim();
  if (!k) throw new Error("EMERGENTDB_API_KEY not set");
  return k;
}

function timeoutMs(): number {
  const n = Number(typeof process !== "undefined" ? process.env?.EMERGENTDB_TIMEOUT_MS : undefined);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/**
 * k-NN semantic search over the EmergentDB vector store. `query` MUST be a
 * 1536-dim embedding (text-embedding-3-small); returns ranked {id, score}.
 * Throws EmergentDBVectorError on non-2xx so callers fail honestly (never a
 * silent empty list that masks a dim mismatch or tenant error).
 */
export async function searchVectors(query: number[], k = 10, namespace?: string): Promise<VectorSearchResponse> {
  if (query.length !== EMERGENTDB_VECTOR_DIM) {
    throw new EmergentDBVectorError(`query vector must be ${EMERGENTDB_VECTOR_DIM}-dim, got ${query.length}`);
  }
  const body: Record<string, unknown> = { query, k };
  if (namespace) body.namespace = namespace;
  const res = await fetch(`${EMERGENTDB_BASE}/vectors/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs()),
  });
  const text = await res.text();
  if (!res.ok) throw new EmergentDBVectorError(`vectors/search ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as VectorSearchResponse;
  return { results: parsed.results ?? [], count: parsed.count ?? 0, namespace: parsed.namespace ?? "default" };
}

/** Batch KV read over qdkv. Returns fullKey -> value|null. Mirrors backend/kv.ts. */
export async function kvMget(keys: string[]): Promise<Record<string, string | null>> {
  if (keys.length === 0) return {};
  const res = await fetch(`${EMERGENTDB_BASE}/qdkv/mget`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ keys }),
    signal: AbortSignal.timeout(timeoutMs()),
  });
  if (!res.ok) return {};
  const data = (await res.json()) as { values?: Record<string, string | null> };
  return data.values ?? {};
}

export class EmergentDBVectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmergentDBVectorError";
  }
}
