import type { Env } from "../types.js";

const EMERGENTDB_BASE = "https://api.emergentdb.com";
const SEARCH_CACHE_TTL = 300; // 5 minutes
const CACHE_READ_TIMEOUT = 2_000; // max ms to wait for cache before skipping

/** Normalize domain: strip www., use stg- prefix for staging. */
function normalizeDomain(env: Env, domain: string): string {
  const clean = domain.replace(/^www\./, "");
  return env.ENVIRONMENT === "staging" ? `stg-${clean}` : clean;
}

type SearchResult = Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
export interface ResolvedSearchResult {
  domain_results: SearchResult;
  global_results: SearchResult;
  skipped_global: boolean;
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
  fetch(`${EMERGENTDB_BASE}/qdkv/set`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.EMERGENTDB_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key: fullKey, value, ttlMs: SEARCH_CACHE_TTL * 1000 }),
  }).catch(() => {});
}

async function edbRequest(
  env: Env,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetch(`${EMERGENTDB_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.EMERGENTDB_API_KEY}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
      "User-Agent": "unbrowse/0.1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `EmergentDB HTTP ${res.status}`);
  return data;
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
  if (hit) try { return JSON.parse(hit); } catch { /* fall through */ }

  const normDomain = normalizeDomain(env, domain);
  let results: SearchResult;
  try {
    const [graphResults, bm25Results] = await Promise.all([
      graphSearch(env, domain, intent, k),
      bm25Search(env, normDomain, intent, k),
    ]);
    const t2 = Date.now();
    console.log(`[perf:search-domain] graph-search: ${t2 - t1}ms graph=${graphResults.length} bm25=${bm25Results.length}`);

    if (bm25Results.length > 0) {
      results = rrfFuse(graphResults, bm25Results, k);
      console.log(`[perf:search-domain] rrf-fused: ${results.length} results`);
    } else {
      results = graphResults;
    }
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
  if (hit) try { return JSON.parse(hit) as ResolvedSearchResult; } catch { /* fall through */ }

  if (!domain) {
    const global_results = await graphSearch(env, "global", intent, globalK).catch((err) => {
      console.error(`[search-resolve] global error:`, (err as Error).message);
      return [] as SearchResult;
    });
    const t2 = Date.now();
    const resolved = { domain_results: [] as SearchResult, global_results, skipped_global: false };
    console.log(`[perf:search-resolve] global-only: ${t2 - t1}ms results=${global_results.length}`);
    console.log(`[perf:search-resolve] TOTAL: ${t2 - t0}ms`);
    if (global_results.length > 0) cachePut(env, ckey, JSON.stringify(resolved));
    return resolved;
  }

  const globalPromise = graphSearch(env, "global", intent, globalK).catch((err) => {
    console.error(`[search-resolve] global error:`, (err as Error).message);
    return [] as SearchResult;
  });
  const domain_results = await graphSearch(env, domain, intent, domainK).catch((err) => {
    console.error(`[search-resolve] domain=${domain} error:`, (err as Error).message);
    return [] as SearchResult;
  });
  const t2 = Date.now();
  console.log(`[perf:search-resolve] domain-search: ${t2 - t1}ms results=${domain_results.length}`);

  const skipped_global = shouldSkipGlobalSearch(domain_results, domain);
  const global_results = skipped_global ? [] : await globalPromise;
  const t3 = Date.now();
  console.log(
    `[perf:search-resolve] global-search: ${skipped_global ? "skipped" : `${t3 - t2}ms results=${global_results.length}`}`,
  );
  console.log(`[perf:search-resolve] TOTAL: ${t3 - t0}ms`);

  const resolved = { domain_results, global_results, skipped_global };
  if (domain_results.length > 0 || global_results.length > 0) {
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
  if (hit) try { return JSON.parse(hit); } catch { /* fall through */ }

  let results: SearchResult;
  try {
    results = await graphSearch(env, "global", intent, k);
  } catch (err) {
    console.error(`[search] global error:`, (err as Error).message);
    return [];
  }
  const t2 = Date.now();
  console.log(`[perf:search-global] graph-search: ${t2 - t1}ms results=${results.length}`);
  console.log(`[perf:search-global] TOTAL: ${t2 - t0}ms`);

  if (results.length > 0) {
    cachePut(env, ckey, JSON.stringify(results));
  }

  return results;
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

export function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
