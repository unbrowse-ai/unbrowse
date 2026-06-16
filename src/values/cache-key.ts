/**
 * cache-key — the content-addressing key for a resolve/execute request, and the idempotency gate
 * that decides whether a request is safe to cache+replay at all.
 *
 * THE BUG this fixes: the old resolve cache key was JSON of {intent,url,domain,autoExecute,params}
 * — it OMITTED the HTTP method and the request BODY. So two POSTs to the same url+intent with
 * different bodies (e.g. two different GraphQL queries, or two JSON-RPC calls) produced the SAME key
 * → query B was served query A's cached result (a correctness leak), and a write mutation could be
 * cached and replayed. The key MUST include method + body; and only IDEMPOTENT requests may cache.
 *
 * Pure + dependency-free so it is unit-witnessable; the downstream content pointer hashes the string.
 */

export interface RequestKeyParts {
  intent: string;
  url?: string;
  domain?: string;
  autoExecute?: boolean;
  params?: Record<string, unknown>;
  method?: string;
  /** the raw request body (for POST/GraphQL/JSON-RPC) — folded into the key so different bodies
   *  never collide. */
  body?: string;
}

/** The cache key: includes method + body so distinct requests get distinct keys (no collision). */
export function requestCacheKey(parts: RequestKeyParts): string {
  const method = (parts.method ?? "GET").toUpperCase();
  return `intent-resolve ${JSON.stringify({
    intent: parts.intent,
    url: parts.url ?? "",
    domain: parts.domain ?? "",
    autoExecute: parts.autoExecute !== false,
    params: parts.params ?? {},
    method,
    body: parts.body ?? "",
  })}`;
}

/**
 * True when a request is safe to CACHE + REPLAY (idempotent read):
 *   - GET / HEAD — the safe HTTP methods, always cacheable.
 *   - POST that is a GraphQL QUERY (a `query` operation with NO `mutation`/`subscription`) — the
 *     common read-over-POST case the user wants KV-cached.
 * NOT cacheable (replaying would be unsafe):
 *   - a generic POST (unknown intent → assume a write),
 *   - PUT / DELETE / PATCH (writes),
 *   - any GraphQL body containing `mutation` or `subscription`.
 * Conservative: any doubt → not cacheable (an honest miss + live recompute beats a wrong replay).
 */
export function isIdempotentRequest(method?: string, body?: string): boolean {
  const m = (method ?? "GET").toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  if (m !== "POST") return false; // PUT / DELETE / PATCH → write
  const b = body ?? "";
  if (/\bmutation\b|\bsubscription\b/i.test(b)) return false; // an explicit GraphQL write
  // A GraphQL read: a "query" field (JSON envelope) or a top-level `query {`/`query Name` operation.
  const looksGraphqlQuery = /["']query["']\s*:/.test(b) || /\bquery\b\s*[{(\w]/i.test(b);
  return looksGraphqlQuery; // a GraphQL query → idempotent read; any other POST → not cacheable
}
