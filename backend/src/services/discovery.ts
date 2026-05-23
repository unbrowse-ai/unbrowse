import type { Env } from "../types.js";
import { computeCompositeSearchScore, computeDomainAffinityBoost } from "./scoring.js";
import { EMERGENTDB_BASE, emergentDBRequest } from "./emergentdb.js";
import { isMarketplaceDomainSuppressed } from "./domain-suppression.js";
import { exaSearch, type ExaWebResult } from "./exa.js";

const SEARCH_CACHE_TTL = 300; // 5 minutes
const CACHE_READ_TIMEOUT = 2_000; // max ms to wait for cache before skipping
const CACHE_WRITE_TIMEOUT = 2_000;

/** Normalize domain: strip www., use stg- prefix for staging. */
function normalizeDomain(env: Env, domain: string): string {
  const clean = domain.replace(/^www\./, "");
  // v2: fresh graph namespace — old stale embeddings remain in unprefixed collections
  return env.ENVIRONMENT === "staging" ? `stg2-${clean}` : `v2-${clean}`;
}

type SearchResult = Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
export interface ResolvedSearchResult {
  domain_results: SearchResult;
  global_results: SearchResult;
  skipped_global: boolean;
  exa_results?: ExaWebResult[];
}

function resultDomain(result: { metadata: Record<string, unknown> }): string | null {
  // Defensive: when EmergentDB returns metadata-less results, result.metadata
  // is undefined. Guard so the suppression filter doesn't crash and zero out
  // the entire result set. Contract 8b2f65ea.
  const meta: Record<string, unknown> = (result.metadata && typeof result.metadata === "object") ? result.metadata : {};
  const direct = meta.source_url;
  if (typeof direct === "string" && direct) return direct;
  const content = meta.content;
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content) as { domain?: unknown };
    return typeof parsed.domain === "string" ? parsed.domain : null;
  } catch {
    return null;
  }
}

function filterSuppressedSearchResults(env: Env, results: SearchResult): SearchResult {
  return results.filter((result) => !isMarketplaceDomainSuppressed(env, resultDomain(result)));
}

function filterSuppressedResolvedSearchResults(env: Env, results: ResolvedSearchResult): ResolvedSearchResult {
  return {
    ...results,
    domain_results: filterSuppressedSearchResults(env, results.domain_results),
    global_results: filterSuppressedSearchResults(env, results.global_results),
  };
}

// In-memory search cache — survives within a single Worker isolate lifetime.
const _memCache = new Map<string, { value: string; expires: number }>();

function searchCacheKey(intent: string, k: number, domain?: string): string {
  const base = `${intent.toLowerCase().trim()}:${k}`;
  return domain ? `${base}:${domain}` : base;
}

function searchResolveCacheKey(intent: string, domain: string | undefined, domainK: number, globalK: number): string {
  return `resolve:${intent.toLowerCase().trim()}:${domain ?? "global"}:${domainK}:${globalK}`;
}

export function extractSkillId(metadata: Record<string, unknown>): string | null {
  const direct = metadata.skill_id;
  if (typeof direct === "string" && direct) return direct;
  const content = metadata.content;
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content) as { skill_id?: unknown };
    return typeof parsed.skill_id === "string" ? parsed.skill_id : null;
  } catch {
    return null;
  }
}

function uniqueSkillCount(results: SearchResult): number {
  return new Set(results.map((result) => result.metadata ? extractSkillId(result.metadata) : null).filter((value): value is string => !!value)).size;
}

export function shouldSkipGlobalSearch(domainResults: SearchResult, requestedDomain?: string | null): boolean {
  if (!requestedDomain || domainResults.length === 0) return false;
  const topScore = domainResults[0]?.score ?? 0;
  const skillCount = uniqueSkillCount(domainResults);
  return skillCount >= 2 || topScore >= 0.84;
}

/** Direct qdkv/get with timeout — bypasses the heavy EdbKV index load. */
async function cacheGet(env: Env, key: string): Promise<string | null> {
  const fullKey = `search-cache:${key}`;

  // Check in-memory first (free, no HTTP)
  const mem = _memCache.get(fullKey);
  if (mem && Date.now() < mem.expires) return mem.value;
  if (mem) _memCache.delete(fullKey);

  // Direct qdkv/get with a hard timeout — never block search for cache
  try {
    const res = await Promise.race([
      fetch(`${EMERGENTDB_BASE}/qdkv/get/${encodeURIComponent(fullKey)}`, {
        headers: { Authorization: `Bearer ${env.EMERGENTDB_API_KEY}`, "Content-Type": "application/json" },
      }),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("cache timeout")), CACHE_READ_TIMEOUT)),
    ]);
    if (!res.ok) return null;
    const data = await res.json() as { value?: string | null; found?: boolean };
    if (!data.found || !data.value) return null;
    _memCache.set(fullKey, { value: data.value, expires: Date.now() + SEARCH_CACHE_TTL * 1000 });
    return data.value;
  } catch {
    return null;
  }
}

/** Fire-and-forget cache write — never blocks the response. */
function cachePut(env: Env, key: string, value: string): void {
  const fullKey = `search-cache:${key}`;
  _memCache.set(fullKey, { value, expires: Date.now() + SEARCH_CACHE_TTL * 1000 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CACHE_WRITE_TIMEOUT);
  fetch(`${EMERGENTDB_BASE}/qdkv/set`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.EMERGENTDB_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key: fullKey, value, ttlMs: SEARCH_CACHE_TTL * 1000 }),
    signal: controller.signal,
  }).catch(() => {}).finally(() => clearTimeout(timer));
}

async function edbRequest(
  env: Env,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  return emergentDBRequest(env, method, path, body);
}

/** Graph API search — auto-embeds the query server-side. */
async function graphSearch(
  env: Env,
  domain: string,
  query: string,
  k: number,
): Promise<SearchResult> {
  const data = (await edbRequest(env, "POST", "/graph/search", {
    domain: normalizeDomain(env, domain),
    query,
    k,
    include_metadata: true,
  })) as { results?: SearchResult };
  return data.results ?? [];
}

/** Index endpoints via Graph API batch_insert — auto-embeds server-side. */
export async function indexEndpoints(
  env: Env,
  skillId: string,
  endpoints: Array<{ endpoint_id: string; description?: string; method: string; url_template: string }>,
  meta: Record<string, unknown>
): Promise<void> {
  const domain = normalizeDomain(env, String(meta.domain ?? "global"));
  const toIndex = endpoints.filter((ep) => ep.description);
  if (toIndex.length === 0) return;

  const items = toIndex.map((ep) => {
    let path: string;
    try { path = new URL(ep.url_template).pathname; } catch { path = ep.url_template.slice(0, 60); }
    return {
      id: `${skillId}:${ep.endpoint_id}`,
      text: `${ep.description} [${ep.method} ${path}]`,
      metadata: {
        title: ep.description ?? "",
        content: JSON.stringify({ ...meta, skill_id: skillId, endpoint_id: ep.endpoint_id }),
        tags: [meta.domain, meta.subdomain].filter(Boolean),
        source_url: String(meta.domain ?? ""),
      },
    };
  });

  // Store BM25 docs in KV for lexical search (fire-and-forget)
  const bm25Docs = items.map((item) => ({ id: item.id, text: item.text, metadata: item.metadata }));
  env.STATS_KV.put(`bm25-idx:${domain}`, JSON.stringify(bm25Docs)).catch(() => {});

  // Insert into both domain and global namespaces
  await Promise.all([
    edbRequest(env, "POST", "/graph/batch_insert", { domain, items }),
    edbRequest(env, "POST", "/graph/batch_insert", {
      domain: normalizeDomain(env, "global"),
      items,
    }),
  ]);
}


const RRF_K = 60;

export type Bm25Doc = { id: string; text: string; metadata: Record<string, unknown> };

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\w+/g) ?? [];
}

/** In-process BM25 search over docs loaded from KV. k1=1.5, b=0.75. */
/** In-process BM25 search over docs loaded from KV. k1=1.5, b=0.75. */
export function bm25Score(docs: Bm25Doc[], query: string, k: number): SearchResult {
  if (docs.length === 0) return [];
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return [];

  const k1 = 1.5, b = 0.75;
  const N = docs.length;

  // Tokenize all docs once
  const tokenized = docs.map((d) => tokenize(d.text));
  const avgdl = tokenized.reduce((s, t) => s + t.length, 0) / N;

  // IDF per query term
  const idf = new Map<string, number>();
  for (const term of qTerms) {
    if (idf.has(term)) continue;
    const df = tokenized.filter((t) => t.includes(term)).length;
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  const scored = docs.map((doc, i) => {
    const terms = tokenized[i];
    const dl = terms.length;
    let score = 0;
    for (const term of qTerms) {
      const tf = terms.filter((t) => t === term).length;
      const idfVal = idf.get(term) ?? 0;
      score += idfVal * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
    }
    return { id: doc.id as unknown as number, score, metadata: doc.metadata };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Load BM25 index from KV and score against query. Returns [] if no index. */
async function bm25Search(env: Env, domain: string, query: string, k: number): Promise<SearchResult> {
  try {
    const raw = await env.STATS_KV.get(`bm25-idx:${domain}`);
    if (!raw) return [];
    const docs = JSON.parse(raw) as Bm25Doc[];
    return bm25Score(docs, query, k);
  } catch {
    return [];
  }
}

/** Reciprocal Rank Fusion over two result lists. */
/** Reciprocal Rank Fusion over two result lists. */
export function rrfFuse(listA: SearchResult, listB: SearchResult, k: number): SearchResult {
  const scores = new Map<string, { score: number; metadata: Record<string, unknown> }>();
  const addList = (list: SearchResult) => {
    list.forEach((item, rank) => {
      const key = String(item.id);
      const prev = scores.get(key);
      const add = 1 / (RRF_K + rank + 1);
      scores.set(key, { score: (prev?.score ?? 0) + add, metadata: item.metadata });
    });
  };
  addList(listA);
  addList(listB);
  return Array.from(scores.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, k)
    .map(([id, { score, metadata }]) => ({ id: id as unknown as number, score, metadata }));
}

/** Extract metadata fields from a search result's `content` JSON. */
function extractMeta(metadata: Record<string, unknown>): {
  avg_reliability: number;
  verified_ratio: number;
  updated_at: string;
} {
  const defaults = { avg_reliability: 0.5, verified_ratio: 0, updated_at: new Date().toISOString() };
  const content = metadata.content;
  if (typeof content !== "string") return defaults;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      avg_reliability: typeof parsed.avg_reliability === "number" ? parsed.avg_reliability : defaults.avg_reliability,
      verified_ratio: typeof parsed.verified_ratio === "number" ? parsed.verified_ratio : defaults.verified_ratio,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : defaults.updated_at,
    };
  } catch {
    return defaults;
  }
}

/**
 * Rescore search results using the composite formula from Section 3.3:
 * 40% embedding similarity, 30% reliability, 15% freshness, 15% verification.
 *
 * Accepts the raw vector-similarity results and returns them re-sorted by
 * composite score.  Results without parseable metadata fall back to
 * conservative defaults (reliability=0.5, verified=0, freshness=now).
 */
export function rescoreWithComposite(
  results: Array<{ id: number; score: number; metadata: Record<string, unknown> }>,
  requestDomain?: string | null,
): Array<{ id: number; score: number; metadata: Record<string, unknown> }> {
  if (results.length === 0) return results;
  return results
    .map((r) => {
      // Defensive: EmergentDB /graph/search returns metadata-less results
      // ({id, score} only). Without this normalization, extractMeta and
      // metadata.source_url crash with `Cannot read properties of undefined`,
      // the route's try/catch swallows it, and /v1/search returns [].
      // Contract 8b2f65ea — empty-search-after-reindex root cause.
      const safeMeta: Record<string, unknown> = (r.metadata && typeof r.metadata === "object") ? r.metadata : {};
      const meta = extractMeta(safeMeta);
      const composite = computeCompositeSearchScore(
        r.score,
        meta.avg_reliability,
        meta.updated_at,
        meta.verified_ratio,
      );
      const domainBoost = requestDomain
        ? computeDomainAffinityBoost(
            typeof safeMeta.source_url === "string" ? safeMeta.source_url : "",
            requestDomain,
          )
        : 0;
      return { ...r, metadata: safeMeta, score: Math.min(1, composite + domainBoost) };
    })
    .sort((a, b) => b.score - a.score);
}

export async function searchIntentInDomain(
  env: Env,
  intent: string,
  domain: string,
  k = 5
): Promise<SearchResult> {
  const t0 = Date.now();
  const ckey = searchCacheKey(intent, k, domain);

  const hit = await cacheGet(env, ckey);
  const t1 = Date.now();
  console.log(`[perf:search-domain] cache-check: ${t1 - t0}ms hit=${!!hit}`);
  if (hit) try { return filterSuppressedSearchResults(env, JSON.parse(hit)); } catch { /* fall through */ }

  if (isMarketplaceDomainSuppressed(env, domain)) return [];

  const normDomain = normalizeDomain(env, domain);
  let results: SearchResult;
  try {
    const [graphSettled, bm25Settled] = await Promise.allSettled([
      graphSearch(env, domain, intent, k),
      bm25Search(env, normDomain, intent, k),
    ]);
    const graphResults = graphSettled.status === "fulfilled" ? graphSettled.value : [];
    const bm25Results = bm25Settled.status === "fulfilled" ? bm25Settled.value : [];
    if (graphSettled.status === "rejected") console.warn(`[search] graph search failed: ${graphSettled.reason}`);
    if (bm25Settled.status === "rejected") console.warn(`[search] bm25 search failed: ${bm25Settled.reason}`);
    const t2 = Date.now();
    console.log(`[perf:search-domain] graph-search: ${t2 - t1}ms graph=${graphResults.length} bm25=${bm25Results.length}`);

    if (bm25Results.length > 0) {
      results = rrfFuse(graphResults, bm25Results, k);
      console.log(`[perf:search-domain] rrf-fused: ${results.length} results`);
    } else {
      results = graphResults;
    }
    // Rescore with composite formula (Section 3.3) before caching
    results = rescoreWithComposite(results, domain);
    console.log(`[perf:search-domain] TOTAL: ${t2 - t0}ms`);
  } catch (err) {
    console.error(`[search] domain=${domain} error:`, (err as Error).message);
    return [];
  }

  if (results.length > 0) {
    cachePut(env, ckey, JSON.stringify(results));
  }

  return results;
}

export async function searchIntentResolve(
  env: Env,
  intent: string,
  domain?: string,
  domainK = 5,
  globalK = 10,
): Promise<ResolvedSearchResult> {
  const t0 = Date.now();
  const ckey = searchResolveCacheKey(intent, domain, domainK, globalK);
  const hit = await cacheGet(env, ckey);
  const t1 = Date.now();
  console.log(`[perf:search-resolve] cache-check: ${t1 - t0}ms hit=${!!hit}`);
  if (hit) try { return filterSuppressedResolvedSearchResults(env, JSON.parse(hit) as ResolvedSearchResult); } catch { /* fall through */ }

  // Exa fires in parallel with graph searches — it's a best-effort enrichment,
  // never on the critical path. Skip when key not configured.
  const exaPromise: Promise<ExaWebResult[]> = env.EXA_API_KEY
    ? exaSearch(env.EXA_API_KEY, intent).catch((err) => {
        console.error("[search-resolve] exa error:", (err as Error).message);
        return [] as ExaWebResult[];
      })
    : Promise.resolve([] as ExaWebResult[]);

  if (!domain) {
    let global_results = await graphSearch(env, "global", intent, globalK).catch((err) => {
      console.error(`[search-resolve] global error:`, (err as Error).message);
      return [] as SearchResult;
    });
    global_results = filterSuppressedSearchResults(env, rescoreWithComposite(global_results));
    const exa_results = await exaPromise;
    const t2 = Date.now();
    const resolved: ResolvedSearchResult = {
      domain_results: [] as SearchResult,
      global_results,
      skipped_global: false,
      ...(exa_results.length > 0 && { exa_results }),
    };
    console.log(`[perf:search-resolve] global-only: ${t2 - t1}ms results=${global_results.length} exa=${exa_results.length}`);
    console.log(`[perf:search-resolve] TOTAL: ${t2 - t0}ms`);
    if (global_results.length > 0) cachePut(env, ckey, JSON.stringify(resolved));
    return resolved;
  }

  if (isMarketplaceDomainSuppressed(env, domain)) {
    const resolved: ResolvedSearchResult = { domain_results: [] as SearchResult, global_results: [] as SearchResult, skipped_global: true };
    cachePut(env, ckey, JSON.stringify(resolved));
    return resolved;
  }

  const globalPromise = graphSearch(env, "global", intent, globalK).catch((err) => {
    console.error(`[search-resolve] global error:`, (err as Error).message);
    return [] as SearchResult;
  });
  let domain_results = await graphSearch(env, domain, intent, domainK).catch((err) => {
    console.error(`[search-resolve] domain=${domain} error:`, (err as Error).message);
    return [] as SearchResult;
  });
  domain_results = filterSuppressedSearchResults(env, rescoreWithComposite(domain_results, domain));
  const t2 = Date.now();
  console.log(`[perf:search-resolve] domain-search: ${t2 - t1}ms results=${domain_results.length}`);

  const skipped_global = shouldSkipGlobalSearch(domain_results, domain);
  let global_results = skipped_global ? [] : await globalPromise;
  if (!skipped_global) global_results = filterSuppressedSearchResults(env, rescoreWithComposite(global_results));
  const exa_results = await exaPromise;
  const t3 = Date.now();
  console.log(
    `[perf:search-resolve] global-search: ${skipped_global ? "skipped" : `${t3 - t2}ms results=${global_results.length}`}`,
  );
  console.log(`[perf:search-resolve] exa=${exa_results.length} TOTAL: ${t3 - t0}ms`);

  const resolved: ResolvedSearchResult = {
    domain_results,
    global_results,
    skipped_global,
    ...(exa_results.length > 0 && { exa_results }),
  };
  if (domain_results.length > 0 || global_results.length > 0 || exa_results.length > 0) {
    cachePut(env, ckey, JSON.stringify(resolved));
  }
  return resolved;
}

export async function searchIntent(
  env: Env,
  intent: string,
  k = 5
): Promise<SearchResult> {
  const t0 = Date.now();
  const ckey = searchCacheKey(intent, k);

  const hit = await cacheGet(env, ckey);
  const t1 = Date.now();
  console.log(`[perf:search-global] cache-check: ${t1 - t0}ms hit=${!!hit}`);
  if (hit) try { return filterSuppressedSearchResults(env, JSON.parse(hit)); } catch { /* fall through */ }

  // Global search now mirrors searchIntentInDomain: parallel graph + BM25.
  // EmergentDB /graph/search returns metadata-less {id, score} only; the BM25
  // path (docs in STATS_KV `bm25-idx:<domain>`) carries the metadata we wrote
  // at index time, so RRF-fusing the two gives us identifiable, rescorable
  // results even when graph metadata is unavailable. Contract 8b2f65ea.
  const normGlobal = normalizeDomain(env, "global");
  let results: SearchResult;
  try {
    const [graphSettled, bm25Settled] = await Promise.allSettled([
      graphSearch(env, "global", intent, k),
      bm25Search(env, normGlobal, intent, k),
    ]);
    const graphResults = graphSettled.status === "fulfilled" ? graphSettled.value : [];
    const bm25Results = bm25Settled.status === "fulfilled" ? bm25Settled.value : [];
    if (graphSettled.status === "rejected") console.warn(`[search] global graph failed: ${graphSettled.reason}`);
    if (bm25Settled.status === "rejected") console.warn(`[search] global bm25 failed: ${bm25Settled.reason}`);
    const t2 = Date.now();
    console.log(`[perf:search-global] graph-search: ${t2 - t1}ms graph=${graphResults.length} bm25=${bm25Results.length}`);
    if (bm25Results.length > 0) {
      results = rrfFuse(graphResults, bm25Results, k);
    } else {
      results = graphResults;
    }
  } catch (err) {
    console.error(`[search] global error:`, (err as Error).message);
    return [];
  }
  // Rescore with composite formula (Section 3.3) before caching
  results = filterSuppressedSearchResults(env, rescoreWithComposite(results));
  const t3 = Date.now();
  console.log(`[perf:search-global] TOTAL: ${t3 - t0}ms results=${results.length}`);

  if (results.length > 0) {
    cachePut(env, ckey, JSON.stringify(results));
  }

  return results;
}


/**
 * Flat endpoint-shaped search.
 *
 * Returns one row per matching endpoint with the structured fields the
 * graph index ALREADY carries (skill_id + endpoint_id are baked into
 * every indexed row's metadata.content). The existing /v1/search returns
 * SearchResult = {id, score, metadata} where metadata.content is a
 * JSON-stringified blob; callers had to JSON.parse to get skill_id /
 * endpoint_id / domain. This helper does the unwrap server-side so the
 * SDK / MCP consumer gets a structured EndpointSearchHit row directly.
 *
 * Substrate-faithful: no new index, no new embedding, no new heuristic.
 * It re-uses graphSearch + the canonical content schema from
 * indexEndpoints (above).
 */
export interface EndpointSearchHit {
  endpoint_id: string;
  skill_id: string;
  domain: string;
  subdomain?: string;
  description: string;
  score: number;
  tags: string[];
  // Optional fields surfaced when the graph index carries them; older
  // rows may omit. Callers MUST handle absence.
  name?: string;
  avg_reliability?: number;
  verified_ratio?: number;
  updated_at?: string;
}

export async function searchEndpoints(
  env: Env,
  intent: string,
  k = 10,
  domain?: string,
): Promise<EndpointSearchHit[]> {
  const rawResults: SearchResult = domain
    ? await graphSearch(env, domain, intent, k).catch(() => [])
    : await graphSearch(env, "global", intent, k).catch(() => []);

  const hits: EndpointSearchHit[] = [];
  for (const row of rawResults) {
    const meta = row.metadata ?? {};
    const tagsRaw = meta.tags;
    const tags = Array.isArray(tagsRaw)
      ? tagsRaw.filter((t): t is string => typeof t === "string")
      : [];

    let parsed: Record<string, unknown> = {};
    if (typeof meta.content === "string") {
      try { parsed = JSON.parse(meta.content) as Record<string, unknown>; } catch { /* skip */ }
    }

    const endpointId = typeof parsed.endpoint_id === "string" ? parsed.endpoint_id : undefined;
    const skillId = typeof parsed.skill_id === "string" ? parsed.skill_id : undefined;
    if (!endpointId || !skillId) continue;

    hits.push({
      endpoint_id: endpointId,
      skill_id: skillId,
      domain: typeof parsed.domain === "string" ? parsed.domain : "",
      subdomain: typeof parsed.subdomain === "string" ? parsed.subdomain : undefined,
      description: typeof meta.title === "string" ? meta.title : "",
      score: typeof row.score === "number" ? row.score : 0,
      tags,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      avg_reliability: typeof parsed.avg_reliability === "number" ? parsed.avg_reliability : undefined,
      verified_ratio: typeof parsed.verified_ratio === "number" ? parsed.verified_ratio : undefined,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
    });
  }
  return hits;
}

/** Re-index a single skill — indexes per-endpoint via Graph API. */
export async function reindexSkill(
  env: Env,
  skill: { skill_id: string; intent_signature: string; domain: string; subdomain?: string; name: string; description: string; endpoints: Array<{ endpoint_id: string; description?: string; method: string; url_template: string; reliability_score: number; verification_status: string }>; updated_at: string }
): Promise<void> {
  const reliabilities = skill.endpoints.map((e) => e.reliability_score);
  const avgReliability = reliabilities.length > 0
    ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
    : 0.5;
  const verifiedCount = skill.endpoints.filter((e) => e.verification_status === "verified").length;
  const verifiedRatio = skill.endpoints.length > 0 ? verifiedCount / skill.endpoints.length : 0;

  await indexEndpoints(env, skill.skill_id, skill.endpoints, {
    domain: skill.domain,
    subdomain: skill.subdomain,
    name: skill.name,
    description: skill.description,
    avg_reliability: avgReliability,
    verified_ratio: verifiedRatio,
    updated_at: skill.updated_at,
  });
}

/** Remove a skill's vectors from the graph index. */
export async function removeSkillFromIndex(env: Env, skillId: string, domain: string): Promise<void> {
  const d = normalizeDomain(env, domain);
  const g = normalizeDomain(env, "global");
  await Promise.all([
    edbRequest(env, "POST", "/graph/delete", { domain: d, id: skillId }),
    edbRequest(env, "POST", "/graph/delete", { domain: g, id: skillId }),
  ]);
}

/** Remove specific endpoint vectors from the graph index. */
export async function removeEndpointsFromIndex(
  env: Env,
  skillId: string,
  endpointIds: string[],
  domain: string
): Promise<void> {
  const d = normalizeDomain(env, domain);
  const g = normalizeDomain(env, "global");
  const deletes = endpointIds.flatMap((epId) => {
    const id = `${skillId}:${epId}`;
    return [
      edbRequest(env, "POST", "/graph/delete", { domain: d, id }),
      edbRequest(env, "POST", "/graph/delete", { domain: g, id }),
    ];
  });
  await Promise.all(deletes);
}

/** Purge all endpoint vectors for a skill from both domain and global indexes. */
export async function purgeSkillVectors(
  env: Env,
  skillId: string,
  endpointIds: string[],
  domain: string
): Promise<{ deleted: number }> {
  const d = normalizeDomain(env, domain);
  const g = normalizeDomain(env, "global");
  const deletes: Promise<unknown>[] = [];

  // Delete each endpoint vector by its composite ID
  for (const epId of endpointIds) {
    const id = `${skillId}:${epId}`;
    deletes.push(
      edbRequest(env, "POST", "/graph/delete", { domain: d, id }).catch(() => {}),
      edbRequest(env, "POST", "/graph/delete", { domain: g, id }).catch(() => {}),
    );
  }

  // Also delete the bare skill ID in case old-style vectors exist
  deletes.push(
    edbRequest(env, "POST", "/graph/delete", { domain: d, id: skillId }).catch(() => {}),
    edbRequest(env, "POST", "/graph/delete", { domain: g, id: skillId }).catch(() => {}),
  );

  await Promise.all(deletes);
  return { deleted: endpointIds.length };
}

export function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
