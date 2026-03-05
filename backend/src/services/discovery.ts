import type { Env } from "../types.js";

const DIMS = 1536;
const EMERGENTDB_BASE = "https://api.emergentdb.com";
const SEARCH_CACHE_TTL = 300; // 5 minutes
const CACHE_READ_TIMEOUT = 2_000; // max ms to wait for cache before skipping

function domainNamespace(domain: string): string {
  return `unbrowse--${domain.replace(/^www\./, "").replace(/\./g, "-")}`;
}
const GLOBAL_NS = "unbrowse--global";

type SearchResult = Array<{ id: number; score: number; metadata: Record<string, unknown> }>;

// In-memory search cache — survives within a single Worker isolate lifetime.
// Avoids the 20s cold-start penalty of EdbKV._idxLoad() for TTL cache lookups.
const _memCache = new Map<string, { value: string; expires: number }>();

function searchCacheKey(intent: string, k: number, domain?: string): string {
  const base = `${intent.toLowerCase().trim()}:${k}`;
  return domain ? `${base}:${domain}` : base;
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
    // Warm the in-memory cache
    _memCache.set(fullKey, { value: data.value, expires: Date.now() + SEARCH_CACHE_TTL * 1000 });
    return data.value;
  } catch {
    return null; // timeout or network error — skip cache, proceed to live search
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

async function embedIntent(
  env: Env,
  text: string,
  task: "query" | "document" = "query"
): Promise<number[]> {
  const taskType = task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: DIMS,
      }),
    }
  );
  const data = (await res.json()) as {
    embedding?: { values?: number[] };
  };
  const raw = data.embedding?.values ?? [];
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? raw.map((v) => v / norm) : raw;
}

export async function indexSkill(
  env: Env,
  skillId: string,
  intentSignature: string,
  meta: Record<string, unknown>
): Promise<void> {
  const vector = await embedIntent(env, intentSignature, "document");
  const numericId = hashToInt(skillId);
  const ns = domainNamespace(String(meta.domain ?? "global"));
  const payload = {
    id: numericId,
    vector,
    metadata: {
      title: intentSignature,
      content: JSON.stringify({ ...meta, skill_id: skillId }),
      tags: [meta.domain, meta.subdomain].filter(Boolean),
      source_url: String(meta.domain ?? ""),
    },
  };
  await Promise.all([
    edbRequest(env, "POST", "/vectors/insert", { ...payload, namespace: ns }),
    edbRequest(env, "POST", "/vectors/insert", { ...payload, namespace: GLOBAL_NS }),
  ]);
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

  const vector = await embedIntent(env, intent, "query");
  const t2 = Date.now();
  console.log(`[perf:search-domain] embed: ${t2 - t1}ms`);

  const ns = domainNamespace(domain);
  let results: SearchResult;
  try {
    const data = (await edbRequest(env, "POST", "/vectors/search", {
      vector, k, include_metadata: true, namespace: ns,
    })) as { results?: SearchResult };
    results = (data.results ?? []).filter(r => r.metadata);
  } catch (err) {
    console.error(`[search] domain=${domain} ns=${ns} error:`, (err as Error).message);
    return [];
  }
  const t3 = Date.now();
  console.log(`[perf:search-domain] vector-search: ${t3 - t2}ms results=${results.length}`);
  console.log(`[perf:search-domain] TOTAL: ${t3 - t0}ms`);

  if (results.length > 0) {
    cachePut(env, ckey, JSON.stringify(results));
  }

  return results;
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

  const vector = await embedIntent(env, intent, "query");
  const t2 = Date.now();
  console.log(`[perf:search-global] embed: ${t2 - t1}ms`);

  let results: SearchResult;
  try {
    const data = (await edbRequest(env, "POST", "/vectors/search", {
      vector, k, include_metadata: true, namespace: GLOBAL_NS,
    })) as { results?: SearchResult };
    results = (data.results ?? []).filter(r => r.metadata);
  } catch (err) {
    console.error(`[search] global ns=${GLOBAL_NS} error:`, (err as Error).message);
    return [];
  }
  const t3 = Date.now();
  console.log(`[perf:search-global] vector-search: ${t3 - t2}ms results=${results.length}`);
  console.log(`[perf:search-global] TOTAL: ${t3 - t0}ms`);

  if (results.length > 0) {
    cachePut(env, ckey, JSON.stringify(results));
  }

  return results;
}

/** Re-index a single skill into both vector namespaces. */
export async function reindexSkill(
  env: Env,
  skill: { skill_id: string; intent_signature: string; domain: string; subdomain?: string; name: string; description: string; endpoints: Array<{ reliability_score: number; verification_status: string }>; updated_at: string }
): Promise<void> {
  const reliabilities = skill.endpoints.map((e) => e.reliability_score);
  const avgReliability = reliabilities.length > 0
    ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
    : 0.5;
  const verifiedCount = skill.endpoints.filter((e) => e.verification_status === "verified").length;
  const verifiedRatio = skill.endpoints.length > 0 ? verifiedCount / skill.endpoints.length : 0;

  await indexSkill(env, skill.skill_id, skill.intent_signature, {
    domain: skill.domain,
    subdomain: skill.subdomain,
    name: skill.name,
    description: skill.description,
    avg_reliability: avgReliability,
    verified_ratio: verifiedRatio,
    updated_at: skill.updated_at,
  });
}

export async function removeSkillFromIndex(env: Env, skillId: string, domain: string): Promise<void> {
  const numericId = hashToInt(skillId);
  const ns = domainNamespace(domain);
  await Promise.all([
    edbRequest(env, "POST", "/vectors/delete", { id: numericId, namespace: ns }),
    edbRequest(env, "POST", "/vectors/delete", { id: numericId, namespace: GLOBAL_NS }),
  ]);
}

function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
