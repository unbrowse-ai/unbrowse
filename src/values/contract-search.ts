/**
 * contract-search — emergent-graph search over the contract/resolution ledger
 * (crypto-was-all-you-needed Phase 5). "Find the next lever / the relevant prior contract"
 * by MEANING, not substring. The pipeline is pure over two injected backends so it runs the
 * same whether the vectors live in memory (offline, default) or in EmergentDB (durable scale):
 *
 *   Embedder           — text → dense vector (production: OpenAI text-embedding-3-small;
 *                         deterministic: hashEmbedder, no network, for the witness + offline).
 *   ContractVectorStore — upsert(id, vector) + search(vector, k) → ranked ids by similarity.
 *
 * indexContractRows embeds + upserts each row; searchContracts embeds the query + ranks.
 * The math (cosine) is real in both paths; only the embedding PROVIDER and the store swap.
 */

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface ScoredId {
  id: string;
  score: number;
}

export interface ContractVectorStore {
  upsert(id: string, vector: number[], payload?: Record<string, unknown>): Promise<void>;
  search(vector: number[], k: number): Promise<ScoredId[]>;
}

/** One indexable contract/resolution row: a stable id + the text to embed (intent + summary). */
export interface ContractRow {
  id: string;
  text: string;
}

/** Embed + upsert every row. Returns the count indexed. */
export async function indexContractRows(rows: ContractRow[], embed: Embedder, store: ContractVectorStore): Promise<number> {
  let n = 0;
  for (const row of rows) {
    const vector = await embed.embed(row.text);
    await store.upsert(row.id, vector, { text: row.text });
    n++;
  }
  return n;
}

/** Embed the query and return the k most semantically similar contract ids, best first. */
export async function searchContracts(query: string, embed: Embedder, store: ContractVectorStore, k = 5): Promise<ScoredId[]> {
  const qv = await embed.embed(query);
  return store.search(qv, k);
}

// ── cosine (the real similarity math both stores rank by) ───────────────────────────────
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * In-memory cosine store — a genuinely functional local semantic index (no external service).
 * This is the default backend: local contract search works offline with any embedder.
 */
export function memCosineStore(): ContractVectorStore & { size(): number } {
  const vecs = new Map<string, number[]>();
  return {
    size: () => vecs.size,
    async upsert(id, vector) { vecs.set(id, vector); },
    async search(vector, k) {
      return [...vecs.entries()]
        .map(([id, v]) => ({ id, score: cosine(vector, v) }))
        .sort((x, y) => y.score - x.score)
        .slice(0, k);
    },
  };
}

/**
 * Deterministic feature-hashing embedder — real bag-of-words → fixed-dim vector, no network.
 * Words hash to dimensions; shared vocabulary ⇒ high cosine. Used by the witness and as the
 * offline fallback when no embeddings provider is configured. Same-meaning text ranks together
 * because it shares tokens — recognition by shape, not an allowlist.
 */
export function hashEmbedder(dim = 256): Embedder {
  return {
    async embed(text: string) {
      const v = new Array<number>(dim).fill(0);
      for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
        v[(h >>> 0) % dim] += 1;
      }
      return v;
    },
  };
}

/**
 * Production embedder over OpenAI text-embedding-3-small (1536-dim, what EmergentDB expects).
 * Returns null when no key — callers fall back to hashEmbedder (offline) per the
 * presence-of-config rule. Live use needs a FUNDED key (a quota-exhausted key throws honestly).
 */
export function openAiEmbedder(env: Record<string, string | undefined> = process.env): Embedder | null {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  return {
    async embed(text: string) {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
        signal: AbortSignal.timeout(20_000),
      });
      const text2 = await res.text();
      if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${text2.slice(0, 200)}`);
      const data = JSON.parse(text2) as { data?: Array<{ embedding: number[] }> };
      const v = data.data?.[0]?.embedding;
      if (!v) throw new Error("openai embeddings: no embedding in response");
      return v;
    },
  };
}

/**
 * LOCAL embedder over Ollama (default nomic-embed-text) at the host's ollama daemon — a real
 * semantic model that runs on-device with no funded cloud account, no API key, no quota. This is
 * the substrate's "sing in your own land" path (use the local model, not a foreign vendor): it
 * delivers live semantic embeddings for the contract search the same way OpenAI would. Returns
 * null when no OLLAMA endpoint env / default daemon is reachable shape-wise (callers fall back).
 * The vector dim differs from OpenAI (768 vs 1536) — fine for the in-memory cosine store, which
 * is dim-agnostic; the EmergentDB vector store (1536-locked) stays an OpenAI/1536 path.
 */
export function ollamaEmbedder(env: Record<string, string | undefined> = process.env): Embedder {
  const base = (env.OLLAMA_HOST || env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
  return {
    async embed(text: string) {
      const res = await fetch(`${base}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`ollama embeddings ${res.status}: ${body.slice(0, 200)}`);
      const v = (JSON.parse(body) as { embedding?: number[] }).embedding;
      if (!v || v.length === 0) throw new Error("ollama embeddings: no embedding in response");
      return v;
    },
  };
}

/**
 * Resolve the best AVAILABLE real (semantic) embedder for the live path, no funded-cloud
 * dependency: try the funded OpenAI key first (1536-dim, EmergentDB-native) by actually
 * embedding a probe; on any failure (no key, exhausted quota) fall back to the LOCAL ollama
 * model — a working semantic embedder beats a blocked premium one. Returns null only when
 * neither a funded cloud key nor a local daemon answers (then the offline hashEmbedder bears
 * the load). Fallbacks are visible: the caller sees which provider answered.
 */
export async function resolveLiveEmbedder(
  env: Record<string, string | undefined> = process.env,
): Promise<{ embed: Embedder; provider: string } | null> {
  const oai = openAiEmbedder(env);
  if (oai) {
    try { await oai.embed("probe"); return { embed: oai, provider: "openai" }; } catch { /* unfunded/quota → fall through */ }
  }
  const ol = ollamaEmbedder(env);
  try { await ol.embed("probe"); return { embed: ol, provider: "ollama" }; } catch { /* no local daemon */ }
  return null;
}
