import type { Env } from "../types.js";

const DIMS = 1536;
const EMERGENTDB_BASE = "https://api.emergentdb.com";
const SEARCH_CACHE_TTL = 300; // 5 minutes
const CACHE_READ_TIMEOUT = 2_000; // max ms to wait for cache before skipping

// Namespace version — old "unbrowse--" namespaces remain as backup.
// Staging uses a separate prefix so migrations can be tested without touching prod vectors.
function nsPrefix(env: Env): string {
  return env.ENVIRONMENT === "staging" ? "unbrowse-stg4--" : "unbrowse-v2--";
}

function domainNamespace(env: Env, domain: string): string {
  return `${nsPrefix(env)}${domain.replace(/^www\./, "").replace(/\./g, "-")}`;
}
function globalNs(env: Env): string {
  return `${nsPrefix(env)}global`;
}

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
  _task: "query" | "document" = "query"
): Promise<number[]> {
  const res = await fetch(
    "https://api.tokenfactory.nebius.com/v1/embeddings",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.NEBIUS_API_KEY}`,
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-Embedding-8B",
        input: text,
        dimensions: DIMS,
      }),
    }
  );
  const data = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const raw = data.data?.[0]?.embedding ?? [];
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? raw.map((v) => v / norm) : raw;
}

/** @deprecated Use indexEndpoints() for per-endpoint vector indexing */
export async function indexSkill(
  env: Env,
  skillId: string,
  intentSignature: string,
  meta: Record<string, unknown>
): Promise<void> {
  const vector = await embedIntent(env, intentSignature, "document");
  const numericId = hashToInt(skillId);
  const ns = domainNamespace(env, String(meta.domain ?? "global"));
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
    edbRequest(env, "POST", "/vectors/insert", { ...payload, namespace: globalNs(env) }),
  ]);
}

/** Index each endpoint as a separate vector using its description. */
export async function indexEndpoints(
  env: Env,
  skillId: string,
  endpoints: Array<{ endpoint_id: string; description?: string; method: string; url_template: string }>,
  meta: Record<string, unknown>
): Promise<void> {
  const ns = domainNamespace(env, String(meta.domain ?? "global"));
  const toIndex = endpoints.filter((ep) => ep.description);
  if (toIndex.length === 0) return;

  // Batch embed all descriptions in one API call
  const texts = toIndex.map((ep) => {
    let path: string;
    try { path = new URL(ep.url_template).pathname; } catch { path = ep.url_template.slice(0, 60); }
    return `${ep.description} [${ep.method} ${path}]`;
  });

  const embedRes = await fetch("https://api.tokenfactory.nebius.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.NEBIUS_API_KEY}`,
    },
    body: JSON.stringify({ model: "Qwen/Qwen3-Embedding-8B", input: texts, dimensions: DIMS }),
  });
  const embedData = (await embedRes.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embeddings = (embedData.data ?? []).map((d) => {
    const raw = d.embedding ?? [];
    const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? raw.map((v) => v / norm) : raw;
  });

  // Insert all endpoint vectors in parallel
  const inserts = toIndex.flatMap((ep, i) => {
    const vector = embeddings[i];
    if (!vector || vector.length === 0) return [];
    const numericId = hashToInt(skillId + ":" + ep.endpoint_id);
    const payload = {
      id: numericId,
      vector,
      metadata: {
        title: ep.description ?? "",
        content: JSON.stringify({
          ...meta,
          skill_id: skillId,
          endpoint_id: ep.endpoint_id,
        }),
        tags: [meta.domain, meta.subdomain].filter(Boolean),
        source_url: String(meta.domain ?? ""),
      },
    };
    return [
      edbRequest(env, "POST", "/vectors/insert", { ...payload, namespace: ns }),
      edbRequest(env, "POST", "/vectors/insert", { ...payload, namespace: globalNs(env) }),
    ];
  });

  await Promise.all(inserts);
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

  const ns = domainNamespace(env, domain);
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

  const gns = globalNs(env);
  let results: SearchResult;
  try {
    const data = (await edbRequest(env, "POST", "/vectors/search", {
      vector, k, include_metadata: true, namespace: gns,
    })) as { results?: SearchResult };
    results = (data.results ?? []).filter(r => r.metadata);
  } catch (err) {
    console.error(`[search] global ns=${gns} error:`, (err as Error).message);
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

/** Re-index a single skill — removes old skill-level vector and indexes per-endpoint. */
export async function reindexSkill(
  env: Env,
  skill: { skill_id: string; intent_signature: string; domain: string; subdomain?: string; name: string; description: string; endpoints: Array<{ endpoint_id: string; description?: string; method: string; url_template: string; reliability_score: number; verification_status: string }>; updated_at: string }
): Promise<void> {
  // Remove legacy skill-level vector
  await removeSkillFromIndex(env, skill.skill_id, skill.domain).catch(() => {});

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

/** @deprecated Use removeEndpointsFromIndex() */
export async function removeSkillFromIndex(env: Env, skillId: string, domain: string): Promise<void> {
  const numericId = hashToInt(skillId);
  const ns = domainNamespace(env, domain);
  await Promise.all([
    edbRequest(env, "POST", "/vectors/delete", { id: numericId, namespace: ns }),
    edbRequest(env, "POST", "/vectors/delete", { id: numericId, namespace: globalNs(env) }),
  ]);
}

/** Remove specific endpoint vectors from both namespaces. */
export async function removeEndpointsFromIndex(
  env: Env,
  skillId: string,
  endpointIds: string[],
  domain: string
): Promise<void> {
  const ns = domainNamespace(env, domain);
  const deletes = endpointIds.flatMap((epId) => {
    const numericId = hashToInt(skillId + ":" + epId);
    return [
      edbRequest(env, "POST", "/vectors/delete", { id: numericId, namespace: ns }),
      edbRequest(env, "POST", "/vectors/delete", { id: numericId, namespace: globalNs(env) }),
    ];
  });
  await Promise.all(deletes);
}

function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
