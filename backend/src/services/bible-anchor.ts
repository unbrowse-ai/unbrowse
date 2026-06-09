/**
 * bible-anchor.ts — internal canonical-ordering organ.
 *
 * PRIVATE / internal. Mirrors lewis-brain's `bible_route.py` on unbrowse's
 * substrate: embed an item, find its nearest canonical chapter anchor in the
 * EmergentDB Graph domain `bible-chapters` (seeded by scripts/seed-bible-chapters.ts,
 * same server embedding model as skill endpoints), and order a set of items by
 * the anchor's fixed canonical index (Genesis=0 … Revelation=1188).
 *
 * This is NON-DESTRUCTIVE and NEVER exposed on a public surface: the relevance
 * ranker (discovery.ts + rank.ts) still SELECTS the candidate set; this only
 * SEQUENCES an already-relevant set, and only when the anchoring is confident
 * (apophenia gate). On any miss / low confidence it returns the input order
 * unchanged — fail-closed, like lewis-brain's keyword-router fallback.
 */

import type { Env } from "../types.js";
import { emergentDBRequest } from "./emergentdb.js";
import { statsKV } from "./kv.js";

/** Fixed Graph domain the chapter vectors live in. Seed + anchor MUST agree. */
export const BIBLE_CHAPTERS_DOMAIN = "bible-chapters";
/** Vectors-fallback namespace (raw /vectors/* when Graph API is unavailable). */
export const BIBLE_VECTORS_NAMESPACE = "bible-chapters";
/** Nebius embedding (client-side; IQ /vectors does NOT auto-embed). Mirrors
 *  semantic-cache.ts so the model + dims match the rest of the system. */
const NEBIUS_EMBED_URL = "https://api.tokenfactory.nebius.com/v1/embeddings";
export const EMBED_MODEL = "Qwen/Qwen3-Embedding-8B";
export const EMBED_DIMS = 1536;
/** KV sidecar key: the content-addressed vector id -> {idx, ref}. Needed because
 *  IQ /vectors carries no metadata and assigns its own id (the input id is
 *  ignored — confirmed empirically). Written at seed time, read here. */
export function vecMetaKey(id: number | string): string {
  return `bible-vec:${id}`;
}
/** Per-chapter text cap at embed time (matches lewis-brain's 2000-char cap). */
export const MAX_CHAPTER_TEXT = 2000;
/** Total canonical chapters (Genesis 1 … Revelation 22). */
export const CANONICAL_CHAPTER_COUNT = 1189;

/** Stable item id for a chapter by its canonical index. */
export function chapterItemId(idx: number): string {
  return `ch-${String(idx).padStart(4, "0")}`;
}

/** Parse the canonical idx back out of a chapter item id (fallback when
 *  metadata is absent on a search result). */
export function idxFromItemId(id: string): number | null {
  const m = /^ch-(\d{1,4})$/.exec(id);
  return m ? Number(m[1]) : null;
}

// Apophenia gate — identical thresholds to lewis-brain's bible_route: only
// trust the ordering when the best anchor is strong AND clearly separated from
// the pack. Below this, the anchoring is noise and we leave order untouched.
export const APOPHENIA_MIN_TOP = 0.6;
export const APOPHENIA_MIN_GAP = 0.15;

export type BibleAnchor = { idx: number; ref: string | null; sim: number };

type GraphSearchResult = {
  results?: Array<{ id: string; score?: number; metadata?: Record<string, unknown> }>;
};
type VectorSearchResult = { results?: Array<{ id: number; score?: number }> };

type EmbedEnv = { NEBIUS_API_KEY?: string };

/** Embed text via Nebius (client-side; IQ /vectors does not auto-embed). Used
 *  by the vectors fallback here and by the seed script. Null on any failure. */
export async function embedText(env: EmbedEnv, text: string): Promise<number[] | null> {
  const key = env.NEBIUS_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch(NEBIUS_EMBED_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, MAX_CHAPTER_TEXT), dimensions: EMBED_DIMS }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { embedding?: number[] }[] };
    const v = data.data?.[0]?.embedding;
    return Array.isArray(v) && v.length === EMBED_DIMS ? v : null;
  } catch {
    return null;
  }
}

/** Primary anchor path — Graph API (shares the skill embedding model, carries
 *  metadata). Returns null when graph is unavailable (403/502) or on miss. */
async function bibleAnchorGraph(env: Env, text: string): Promise<BibleAnchor | null> {
  let data: GraphSearchResult;
  try {
    data = await emergentDBRequest<GraphSearchResult>(env, "POST", "/graph/search", {
      domain: BIBLE_CHAPTERS_DOMAIN, query: text, k: 1, include_metadata: true,
    });
  } catch {
    return null;
  }
  const top = data.results?.[0];
  if (!top) return null;
  const metaIdx = typeof top.metadata?.idx === "number" ? (top.metadata.idx as number) : idxFromItemId(top.id);
  if (metaIdx == null || !Number.isFinite(metaIdx)) return null;
  const ref = typeof top.metadata?.ref === "string" ? (top.metadata.ref as string) : null;
  return { idx: metaIdx, ref, sim: typeof top.score === "number" ? top.score : 0 };
}

/** Fallback anchor path — raw vector search. Nebius-embed the text, search the
 *  bible-chapters vector namespace, and resolve the content-addressed result id
 *  to {idx, ref} through the KV sidecar (vectors carry no metadata). */
async function bibleAnchorVectors(env: Env, text: string): Promise<BibleAnchor | null> {
  const vector = await embedText(env, text);
  if (!vector) return null;
  let data: VectorSearchResult;
  try {
    data = await emergentDBRequest<VectorSearchResult>(env, "POST", "/vectors/search", {
      vector, k: 1, namespace: BIBLE_VECTORS_NAMESPACE,
    });
  } catch {
    return null;
  }
  const top = data.results?.[0];
  if (!top || typeof top.id !== "number") return null;
  const raw = (await statsKV(env).get(vecMetaKey(top.id))) as string | null;
  if (!raw) return null;
  let meta: { idx?: number; ref?: string };
  try { meta = JSON.parse(raw); } catch { return null; }
  if (typeof meta.idx !== "number") return null;
  return { idx: meta.idx, ref: meta.ref ?? null, sim: typeof top.score === "number" ? top.score : 0 };
}

/**
 * Anchor one item's text to its nearest canonical chapter. Tries the Graph API
 * first (same embedding model as skills, metadata inline); falls back to raw
 * vector search (Nebius embed + KV sidecar) when the account has no graph
 * instance. Returns null when BOTH paths miss/error — fail-closed, callers must
 * treat null as "no anchor", never a default position.
 */
export async function bibleAnchor(env: Env, text: string): Promise<BibleAnchor | null> {
  if (!text?.trim()) return null;
  return (await bibleAnchorGraph(env, text)) ?? (await bibleAnchorVectors(env, text));
}

/** Apophenia confidence over a set of anchor sims (lewis-brain's gate). */
export function anchorConfidenceHigh(sims: number[]): boolean {
  if (sims.length < 2) return false;
  const sorted = [...sims].sort((a, b) => a - b);
  const top = sorted[sorted.length - 1];
  const mid = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return top >= APOPHENIA_MIN_TOP && top - mid >= APOPHENIA_MIN_GAP;
}

export type SequenceResult<T> = {
  items: T[];
  applied: boolean;
  confidence: "high" | "low";
  anchored: number;
};

/**
 * Non-destructive canonical sequencing. Anchors each item, and ONLY when the
 * anchoring is confident re-sorts the set by canonical idx (stable — items
 * that fail to anchor keep their relevance position at the end). The input
 * SET is never changed, only its order; on low confidence the input order is
 * returned verbatim.
 */
export async function sequenceByBibleAnchor<T>(
  env: Env,
  items: T[],
  getText: (item: T) => string,
): Promise<SequenceResult<T>> {
  if (items.length < 2) return { items, applied: false, confidence: "low", anchored: items.length };

  const anchors = await Promise.all(items.map((it) => bibleAnchor(env, getText(it)).catch(() => null)));
  const sims = anchors.filter((a): a is BibleAnchor => a != null).map((a) => a.sim);
  const anchored = sims.length;

  if (!anchorConfidenceHigh(sims)) {
    return { items, applied: false, confidence: "low", anchored };
  }

  // Stable sort by canonical idx; un-anchored items sink to the end keeping
  // their original relative (relevance) order.
  const decorated = items.map((it, i) => ({ it, i, anchor: anchors[i] }));
  decorated.sort((a, b) => {
    if (a.anchor && b.anchor) return a.anchor.idx - b.anchor.idx || a.i - b.i;
    if (a.anchor) return -1;
    if (b.anchor) return 1;
    return a.i - b.i;
  });
  return { items: decorated.map((d) => d.it), applied: true, confidence: "high", anchored };
}

// Loose shape matching discovery.ts SearchResult items (id is typed number
// there though runtime ids are "skill:endpoint" strings — accept both).
type ScoredResult = { id: string | number; metadata?: Record<string, unknown> };

/** Text to anchor a resolve result on — the endpoint description if present,
 *  else the id. */
function resultText(r: ScoredResult): string {
  const t = r.metadata?.title;
  return typeof t === "string" && t.trim() ? t : String(r.id);
}

/**
 * Presentation-time, NON-DESTRUCTIVE canonical ordering for a resolved search
 * result. Sequences domain_results and global_results each by their nearest
 * canonical anchor, gated by confidence. The relevance cache upstream stays
 * relevance-ordered; this only re-orders what's handed to the caller, and only
 * when the caller has opted in (see the BIBLE_ANCHOR_ORDER flag at the route).
 * Fail-closed: any error leaves the lists untouched.
 */
export async function orderResolvedResults<
  T extends { domain_results?: ScoredResult[]; global_results?: ScoredResult[] },
>(env: Env, resolved: T): Promise<T> {
  try {
    const [d, g] = await Promise.all([
      resolved.domain_results?.length
        ? sequenceByBibleAnchor(env, resolved.domain_results, resultText)
        : Promise.resolve(null),
      resolved.global_results?.length
        ? sequenceByBibleAnchor(env, resolved.global_results, resultText)
        : Promise.resolve(null),
    ]);
    return {
      ...resolved,
      ...(d ? { domain_results: d.items } : {}),
      ...(g ? { global_results: g.items } : {}),
    };
  } catch {
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Server-side seeding (so the prod EmergentDB account can be seeded without its
// key ever leaving the worker). Mirrors scripts/seed-bible-chapters.ts' vectors
// path: Nebius-embed each chapter, /vectors/insert, research the content-
// addressed id, write the KV sidecar bible-vec:<id> -> {idx, ref}.
// ---------------------------------------------------------------------------

export type ChapterSeed = { idx: number; ref: string; text: string };
export type SeedResult = { seeded: number; failed: number; total: number };

/** Seed one batch of chapters into the bible-chapters vector namespace + KV
 *  sidecar. Idempotent per content; per-chapter failures are counted, never
 *  thrown — a partial batch still records what it could. */
export async function seedBibleChaptersBatch(env: Env, chapters: ChapterSeed[]): Promise<SeedResult> {
  const kv = statsKV(env);
  let seeded = 0, failed = 0;
  for (const c of chapters) {
    try {
      const vector = await embedText(env, c.text);
      if (!vector) { failed++; continue; }
      await emergentDBRequest(env, "POST", "/vectors/insert", {
        id: c.idx, vector, namespace: BIBLE_VECTORS_NAMESPACE,
      });
      // IQ assigns its own content-addressed id; self-search to learn it.
      const sr = await emergentDBRequest<VectorSearchResult>(env, "POST", "/vectors/search", {
        vector, k: 1, namespace: BIBLE_VECTORS_NAMESPACE,
      });
      const id = sr.results?.[0]?.id;
      if (typeof id !== "number") { failed++; continue; }
      await kv.put(vecMetaKey(id), JSON.stringify({ idx: c.idx, ref: c.ref }));
      seeded++;
    } catch {
      failed++;
    }
  }
  return { seeded, failed, total: chapters.length };
}
