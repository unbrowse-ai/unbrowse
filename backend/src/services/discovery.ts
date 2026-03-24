import type { EndpointDescriptor, Env, SkillManifest } from "../types.js";
import { skillsKV } from "./kv.js";
import { listCanonicalSkills } from "./skill-catalog.js";

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
type SearchOptions = {
  skipCache?: boolean;
};

// In-memory search cache — survives within a single Worker isolate lifetime.
const _memCache = new Map<string, { value: string; expires: number }>();

function searchCacheKey(intent: string, k: number, domain?: string): string {
  const base = `${intent.toLowerCase().trim()}:${k}`;
  return domain ? `${base}:${domain}` : base;
}

function searchResolveCacheKey(intent: string, domain: string | undefined, domainK: number, globalK: number): string {
  return `resolve:${intent.toLowerCase().trim()}:${domain ?? "global"}:${domainK}:${globalK}`;
}

export function shouldBypassSearchCache(env: Pick<Env, "ENVIRONMENT">, authHeader?: string | null): boolean {
  if (env.ENVIRONMENT !== "staging") return false;
  if (!authHeader?.startsWith("Bearer ")) return false;
  return authHeader.slice(7).trim() === "staging-eval";
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

export function extractEndpointId(metadata: Record<string, unknown>): string | null {
  const direct = metadata.endpoint_id;
  if (typeof direct === "string" && direct) return direct;
  const content = metadata.content;
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content) as { endpoint_id?: unknown };
    return typeof parsed.endpoint_id === "string" ? parsed.endpoint_id : null;
  } catch {
    return null;
  }
}

export function extractDomain(metadata: Record<string, unknown>): string | null {
  const direct = metadata.domain ?? metadata.source_url;
  if (typeof direct === "string" && direct) return normalizeHostish(direct);
  const content = metadata.content;
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content) as { domain?: unknown };
    return typeof parsed.domain === "string" ? normalizeHostish(parsed.domain) : null;
  } catch {
    return null;
  }
}

function normalizeHostish(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  const withoutProtocol = trimmed.replace(/^[a-z]+:\/\//, "");
  const host = withoutProtocol.split("/")[0]?.split("?")[0]?.split("#")[0] ?? "";
  return host.replace(/^www\./, "");
}

function getRegistrableDomain(hostname: string): string {
  const parts = normalizeHostish(hostname).split(".").filter(Boolean);
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join(".");
    if (new Set([
      "co.uk", "co.nz", "co.jp", "co.kr", "co.in",
      "com.br", "com.au", "com.cn", "com.mx", "com.ar", "com.tw",
      "org.uk", "gov.uk", "ac.uk", "net.au", "org.au",
    ]).has(lastTwo)) {
      return parts.slice(-3).join(".");
    }
  }
  return parts.slice(-2).join(".");
}

function hasSearchMetadata(results: SearchResult): boolean {
  if (results.length === 0) return true;
  return results.every((result) => {
    if (!result.metadata) return false;
    return Boolean(extractSkillId(result.metadata) && extractEndpointId(result.metadata));
  });
}

const STOP_WORDS = new Set([
  "a", "an", "and", "api", "by", "for", "from", "get", "how", "i", "in", "is", "my", "of", "on",
  "or", "the", "to", "with", "show",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function endpointSearchText(skill: SkillManifest, endpoint: EndpointDescriptor): string {
  return [
    skill.domain,
    skill.subdomain,
    skill.name,
    skill.description,
    ...(skill.intents ?? []),
    endpoint.endpoint_id,
    endpoint.method,
    endpoint.url_template,
    endpoint.description,
  ].filter(Boolean).join(" ");
}

function scoreSearchText(intent: string, haystack: string, domainBoost = 0): number {
  const queryTokens = tokenize(intent);
  if (queryTokens.length === 0) return 0;
  const text = haystack.toLowerCase();
  const textTokens = new Set(tokenize(haystack));

  let matches = 0;
  let strongMatches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      matches += 1;
      strongMatches += 1;
      continue;
    }
    if (text.includes(token)) {
      matches += 0.5;
    }
  }

  let score = matches / queryTokens.length;
  if (text.includes(intent.toLowerCase())) score += 0.25;
  if (strongMatches === queryTokens.length) score += 0.1;
  score += domainBoost;
  return Number(Math.min(0.99, score).toFixed(6));
}

export function buildLocalSearchResults(
  skills: SkillManifest[],
  intent: string,
  k: number,
  domain?: string,
): SearchResult {
  const requestedDomain = domain ? normalizeHostish(domain) : null;

  const ranked = skills.flatMap((skill) => {
    if (skill.lifecycle !== "active") return [];
    const skillDomain = normalizeHostish(skill.domain);
    if (requestedDomain && skillDomain !== requestedDomain) return [];

    return skill.endpoints
      .filter((endpoint) => Boolean(endpoint.description))
      .map((endpoint) => {
        const score = scoreSearchText(
          intent,
          endpointSearchText(skill, endpoint),
          requestedDomain && skillDomain === requestedDomain ? 0.15 : 0,
        );
        return {
          id: hashToInt(`${skill.skill_id}:${endpoint.endpoint_id}`),
          score,
          metadata: {
            skill_id: skill.skill_id,
            endpoint_id: endpoint.endpoint_id,
            domain: skill.domain,
            source_url: skill.domain,
            content: JSON.stringify({
              skill_id: skill.skill_id,
              endpoint_id: endpoint.endpoint_id,
              domain: skill.domain,
              name: skill.name,
              description: skill.description,
            }),
          },
        };
      })
      .filter((candidate) => candidate.score > 0);
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aSkill = extractSkillId(a.metadata) ?? "";
    const bSkill = extractSkillId(b.metadata) ?? "";
    return aSkill.localeCompare(bSkill);
  });
  return ranked.slice(0, k);
}

async function localSearch(env: Env, intent: string, k: number, domain?: string): Promise<SearchResult> {
  const skills = await listCanonicalSkills(env);
  return buildLocalSearchResults(skills, intent, k, domain);
}

async function graphSearchWithFallback(
  env: Env,
  domain: string,
  query: string,
  k: number,
): Promise<SearchResult> {
  const results = await graphSearch(env, domain, query, k);
  if (hasSearchMetadata(results)) return results;
  console.warn(`[search] graph metadata missing for domain=${domain}; falling back to local skill ranking`);
  return localSearch(env, query, k, domain === "global" ? undefined : domain);
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

  // Insert into both domain and global namespaces
  await Promise.all([
    edbRequest(env, "POST", "/graph/batch_insert", { domain, items }),
    edbRequest(env, "POST", "/graph/batch_insert", {
      domain: normalizeDomain(env, "global"),
      items,
    }),
  ]);
}

export async function searchIntentInDomain(
  env: Env,
  intent: string,
  domain: string,
  k = 5,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const skipCache = options.skipCache === true;
  const t0 = Date.now();
  const ckey = searchCacheKey(intent, k, domain);

  const hit = skipCache ? null : await cacheGet(env, ckey);
  const t1 = Date.now();
  console.log(`[perf:search-domain] cache-check: ${t1 - t0}ms hit=${!!hit}`);
  if (hit) {
    try {
      const cached = JSON.parse(hit) as SearchResult;
      if (hasSearchMetadata(cached)) return cached;
    } catch {
      /* fall through */
    }
  }

  let results: SearchResult;
  try {
    results = await graphSearchWithFallback(env, domain, intent, k);
  } catch (err) {
    console.error(`[search] domain=${domain} error:`, (err as Error).message);
    return [];
  }
  const t2 = Date.now();
  console.log(`[perf:search-domain] graph-search: ${t2 - t1}ms results=${results.length}`);
  console.log(`[perf:search-domain] TOTAL: ${t2 - t0}ms`);

  if (!skipCache && results.length > 0) {
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
  options: SearchOptions = {},
): Promise<ResolvedSearchResult> {
  const skipCache = options.skipCache === true;
  const t0 = Date.now();
  const ckey = searchResolveCacheKey(intent, domain, domainK, globalK);
  const hit = skipCache ? null : await cacheGet(env, ckey);
  const t1 = Date.now();
  console.log(`[perf:search-resolve] cache-check: ${t1 - t0}ms hit=${!!hit}`);
  if (hit) {
    try {
      const cached = JSON.parse(hit) as ResolvedSearchResult;
      if (hasSearchMetadata(cached.domain_results) && hasSearchMetadata(cached.global_results)) {
        return cached;
      }
    } catch {
      /* fall through */
    }
  }

  if (!domain) {
    const global_results = await graphSearchWithFallback(env, "global", intent, globalK).catch((err) => {
      console.error(`[search-resolve] global error:`, (err as Error).message);
      return [] as SearchResult;
    });
    const t2 = Date.now();
    const resolved = { domain_results: [] as SearchResult, global_results, skipped_global: false };
    console.log(`[perf:search-resolve] global-only: ${t2 - t1}ms results=${global_results.length}`);
    console.log(`[perf:search-resolve] TOTAL: ${t2 - t0}ms`);
    if (!skipCache && global_results.length > 0) cachePut(env, ckey, JSON.stringify(resolved));
    return resolved;
  }

  const globalPromise = graphSearchWithFallback(env, "global", intent, globalK).catch((err) => {
    console.error(`[search-resolve] global error:`, (err as Error).message);
    return [] as SearchResult;
  });
  const domain_results = await graphSearchWithFallback(env, domain, intent, domainK).catch((err) => {
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
  if (!skipCache && (domain_results.length > 0 || global_results.length > 0)) {
    cachePut(env, ckey, JSON.stringify(resolved));
  }
  return resolved;
}

export async function searchIntent(
  env: Env,
  intent: string,
  k = 5,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const skipCache = options.skipCache === true;
  const t0 = Date.now();
  const ckey = searchCacheKey(intent, k);

  const hit = skipCache ? null : await cacheGet(env, ckey);
  const t1 = Date.now();
  console.log(`[perf:search-global] cache-check: ${t1 - t0}ms hit=${!!hit}`);
  if (hit) {
    try {
      const cached = JSON.parse(hit) as SearchResult;
      if (hasSearchMetadata(cached)) return cached;
    } catch {
      /* fall through */
    }
  }

  let results: SearchResult;
  try {
    results = await graphSearchWithFallback(env, "global", intent, k);
  } catch (err) {
    console.error(`[search] global error:`, (err as Error).message);
    return [];
  }
  const t2 = Date.now();
  console.log(`[perf:search-global] graph-search: ${t2 - t1}ms results=${results.length}`);
  console.log(`[perf:search-global] TOTAL: ${t2 - t0}ms`);

  if (!skipCache && results.length > 0) {
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

export function normalizeEmbedding(embedding: number[], dimensions: number): number[] {
  if (embedding.length === dimensions) return embedding;
  if (embedding.length > dimensions) return embedding.slice(0, dimensions);
  return [...embedding, ...Array.from({ length: dimensions - embedding.length }, () => 0)];
}
