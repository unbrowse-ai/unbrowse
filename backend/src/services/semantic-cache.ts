/**
 * semantic-cache — a similarity cache for the slow/paid Exa web-search path.
 *
 * The Exa web search (`exaSearch`, /v1/search/web) costs a network round-trip
 * (~0.7–5s) and real money per call. Many queries repeat with reworded phrasing
 * ("CEO of OpenAI" vs "who leads OpenAI as chief executive"). A plain key-value
 * cache misses those — the strings differ. This cache keys on MEANING instead:
 *
 *   embed(query)  -> EmergentDB vector nearest-neighbour -> content-addressed id
 *                 -> qdkv[veccache:id] holds the cached result payload.
 *
 * EmergentDB assigns vector ids by content (the same embedding always maps to the
 * same id), and search returns the nearest existing vector's id + cosine score.
 * So a paraphrase embeds to a *different* vector but its nearest neighbour is the
 * original query's vector — same id — and we read the payload from qdkv under that
 * id. (Verified live: a reworded BrowseComp question retrieved the original's
 * cached answer at cosine 0.895; an exact repeat at 1.000.)
 *
 * The embedder is Nebius Qwen3-Embedding-8B at 1536 dims — the same model that
 * populated the existing index (backend/backfill-embeddings.mjs).
 *
 * Fail-open by contract: ANY cache error (embed down, EmergentDB hiccup, parse
 * failure) falls through to the live compute. The cache can only make search
 * faster/cheaper, never break it.
 */

const EDB_BASE = "https://api.emergentdb.com";
const NEBIUS_EMBED_URL = "https://api.tokenfactory.nebius.com/v1/embeddings";
const EMBED_MODEL = "Qwen/Qwen3-Embedding-8B";
const EMBED_DIMS = 1536;

/**
 * Cosine threshold for a hit. Measured (Qwen3-Embedding-8B): same-meaning
 * paraphrases score 0.88–0.90; different questions — even same-domain ("how many
 * Switch games sold") — score ≤0.67. 0.80 sits in that gap: it catches rewordings
 * (casing, word order, synonyms) while rejecting related-but-distinct queries.
 * Tunable via SEMANTIC_CACHE_THRESHOLD.
 */
const DEFAULT_THRESHOLD = 0.80;

interface CacheEnv {
  EMERGENTDB_API_KEY?: string;
  NEBIUS_API_KEY?: string;
  SEMANTIC_CACHE_THRESHOLD?: string;
  SEMANTIC_CACHE_NAMESPACE?: string;
}

async function embed(query: string, nebiusKey: string): Promise<number[] | null> {
  const res = await fetch(NEBIUS_EMBED_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${nebiusKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: query, dimensions: EMBED_DIMS }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: { embedding?: number[] }[] };
  const v = data.data?.[0]?.embedding;
  return Array.isArray(v) && v.length === EMBED_DIMS ? v : null;
}

async function vectorNearest(
  vector: number[],
  edbKey: string,
  namespace: string,
): Promise<{ id: number; score: number } | null> {
  const res = await fetch(`${EDB_BASE}/vectors/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${edbKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ vector, k: 1, namespace }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: { id: number; score: number }[] };
  const top = data.results?.[0];
  return top && typeof top.id === "number" ? { id: top.id, score: top.score } : null;
}

async function vectorInsert(vector: number[], edbKey: string, namespace: string): Promise<void> {
  // id is content-addressed by EmergentDB (the value we send is ignored); we
  // re-read the assigned id via a follow-up search.
  await fetch(`${EDB_BASE}/vectors/insert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${edbKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, vector, namespace }),
  });
}

async function qdkvGet(key: string, edbKey: string): Promise<string | null> {
  const res = await fetch(`${EDB_BASE}/qdkv/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${edbKey}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { value?: string | null; found?: boolean };
  return data.found && data.value != null ? data.value : null;
}

async function qdkvSet(key: string, value: string, edbKey: string): Promise<void> {
  await fetch(`${EDB_BASE}/qdkv/set`, {
    method: "POST",
    headers: { Authorization: `Bearer ${edbKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

function threshold(env: CacheEnv): number {
  const raw = env.SEMANTIC_CACHE_THRESHOLD;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  }
  return DEFAULT_THRESHOLD;
}

function namespaceFor(env: CacheEnv, kind: string): string {
  return `${env.SEMANTIC_CACHE_NAMESPACE ?? "unbrowse-semcache"}:${kind}`;
}

/**
 * Look up a semantically-equivalent prior result; on miss, run `compute`, cache
 * its result, and return it. `kind` namespaces independent caches (e.g. one per
 * result-shape). Fail-open: cache trouble never blocks `compute`.
 */
export async function getOrComputeSemantic<T>(
  env: CacheEnv,
  kind: string,
  query: string,
  compute: () => Promise<T>,
): Promise<{ value: T; cached: boolean }> {
  const edbKey = env.EMERGENTDB_API_KEY;
  const nebiusKey = env.NEBIUS_API_KEY;
  if (!edbKey || !nebiusKey) return { value: await compute(), cached: false };

  const ns = namespaceFor(env, kind);
  let vector: number[] | null = null;
  try {
    vector = await embed(query, nebiusKey);
    if (vector) {
      const hit = await vectorNearest(vector, edbKey, ns);
      if (hit && hit.score >= threshold(env)) {
        const raw = await qdkvGet(`veccache:${ns}:${hit.id}`, edbKey);
        if (raw) {
          try {
            return { value: JSON.parse(raw) as T, cached: true };
          } catch { /* corrupt entry — fall through to recompute */ }
        }
      }
    }
  } catch { /* any lookup error → compute live */ }

  const value = await compute();

  // Best-effort write-through; never block the response on it.
  if (vector) {
    try {
      await vectorInsert(vector, edbKey, ns);
      const assigned = await vectorNearest(vector, edbKey, ns);
      if (assigned) await qdkvSet(`veccache:${ns}:${assigned.id}`, JSON.stringify(value), edbKey);
    } catch { /* cache write failure is non-fatal */ }
  }
  return { value, cached: false };
}
