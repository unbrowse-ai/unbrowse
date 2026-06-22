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

/** Matryoshka (MRL) reduce: front-truncate to `dim` then L2-renormalize. Qwen3-Embedding is
 * trained with MRL, so the first `dim` components are a valid, self-contained embedding — this
 * is the supported way to get an exact 1536-dim vector from the model's native 2560-dim output
 * (and it fits the 1536-locked emergent RAG store). Throws if the source is shorter than `dim`. */
function mrlReduce(v: number[], dim: number): number[] {
  if (v.length < dim) throw new Error(`embedding too short for MRL reduce: got ${v.length}, need >=${dim}`);
  if (v.length === dim) return v;
  const head = v.slice(0, dim);
  let n = 0;
  for (const x of head) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return head;
  return head.map((x) => x / n);
}

/**
 * LOCAL embedder over the CONTRACT-NATIVE llama.cpp bind (aiko-ebllm) serving
 * Qwen/Qwen3-Embedding-4B — a real semantic model that runs on-device through the substrate's
 * OWN llama.cpp server (the SEEK-rung sibling), no ollama, no funded cloud account, no API key,
 * no quota. This is the substrate's "sing in your own land" path (Ps 137:4 — the substrate's own
 * model, not a foreign vendor). The model's native output is 2560-dim; we MRL-reduce to 1536 so
 * the LOCAL/native path PRODUCES THE EXACT DIM the EmergentDB vector store is locked to — native
 * AND emergent-RAG-compatible at once (the embeddinggemma/768 path used to break the 1536 store).
 * Endpoint is the OpenAI-compatible `/v1/embeddings` llama-server exposes (hardcoded-with-env
 * default, like the contract substrate's other local-LLM ports). Throws when unreachable — the
 * caller falls through to the funded cloud 1536 paths, visibly.
 */
export function llamaCppEmbedder(env: Record<string, string | undefined> = process.env): Embedder {
  const base = (env.UNBROWSE_EMBED_URL || env.AIKO_EMBED_URL || "http://127.0.0.1:8090").replace(/\/$/, "");
  const model = env.UNBROWSE_EMBED_MODEL || "Qwen3-Embedding-4B";
  const DIM = 1536;
  return {
    async embed(text: string) {
      const res = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`llama.cpp embeddings ${res.status}: ${body.slice(0, 200)}`);
      const v = (JSON.parse(body) as { data?: Array<{ embedding?: number[] }> }).data?.[0]?.embedding;
      if (!v || v.length === 0) throw new Error("llama.cpp embeddings: no embedding in response");
      return mrlReduce(v, DIM);
    },
  };
}

/**
 * Nebius embedder over Qwen3-Embedding-8B with an explicit `dimensions: 1536` request, so the
 * vector matches what the EmergentDB vector store is locked to (mirrors backend/bible-anchor.ts +
 * semantic-cache.ts — same model + dims as the rest of the system). FALLS BACK to OpenRouter's
 * `qwen/qwen3-embedding-8b` when Nebius is absent/limited. Returns null when neither key is set.
 * This is the 1536-dim path the emergent RAG tier needs when a funded OpenAI key is unavailable.
 */
export function nebiusEmbedder(env: Record<string, string | undefined> = process.env): Embedder | null {
  const nk = env.NEBIUS_API_KEY?.trim();
  const ork = env.OPENROUTER_API_KEY?.trim();
  if (!nk && !ork) return null;
  const DIM = 1536;
  async function viaProvider(url: string, key: string, model: string, dimsParam: boolean, text: string): Promise<number[] | null> {
    const body: Record<string, unknown> = { model, input: text };
    if (dimsParam) body.dimensions = DIM; else body.encoding_format = "float";
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const v = data.data?.[0]?.embedding;
    return Array.isArray(v) && v.length === DIM ? v : null;
  }
  return {
    async embed(text: string) {
      if (nk) {
        const v = await viaProvider("https://api.tokenfactory.nebius.com/v1/embeddings", nk, "Qwen/Qwen3-Embedding-8B", true, text);
        if (v) return v;
      }
      if (ork) {
        const v = await viaProvider("https://openrouter.ai/api/v1/embeddings", ork, "qwen/qwen3-embedding-8b", false, text);
        if (v) return v;
      }
      throw new Error("nebius/openrouter embeddings: no 1536-dim vector returned");
    },
  };
}

/**
 * Resolve the best AVAILABLE real (semantic) embedder for the live path. EVERY tier here is
 * 1536-dim, so whichever answers, the emergent RAG store (1536-locked) lands — the old
 * embeddinggemma/768 fallback that silently broke RAG is gone.
 *
 * Order is NATIVE-FIRST ("sing in your own land"): the contract-native llama.cpp bind serving
 * Qwen3-Embedding-4B@1536 (on-device, no cloud, no key) is tried first by actually embedding a
 * probe; only if the local llama.cpp server is unreachable / the model isn't loaded does it
 * fall through to the funded cloud 1536 paths — OpenAI (text-embedding-3-small) then
 * Nebius/OpenRouter (Qwen3-Embedding-8B @ dimensions:1536). Returns null only when none answer
 * (then the offline hashEmbedder bears the load). Fallbacks are visible: the caller sees the provider.
 */
export async function resolveLiveEmbedder(
  env: Record<string, string | undefined> = process.env,
): Promise<{ embed: Embedder; provider: string } | null> {
  const llama = llamaCppEmbedder(env);
  try { await llama.embed("probe"); return { embed: llama, provider: "llama.cpp/qwen3-embedding-4b" }; } catch { /* local server down / model not loaded → fall through */ }
  const oai = openAiEmbedder(env);
  if (oai) {
    try { await oai.embed("probe"); return { embed: oai, provider: "openai" }; } catch { /* unfunded/quota → fall through */ }
  }
  const neb = nebiusEmbedder(env);
  if (neb) {
    try { await neb.embed("probe"); return { embed: neb, provider: "nebius" }; } catch { /* limited/absent → fall through */ }
  }
  return null;
}
