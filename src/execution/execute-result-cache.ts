/**
 * execute-result-cache — a small in-process TTL cache for the execute layer
 * (POST /v1/skills/:id/execute). "Indexed" must mean "the data is already here,
 * fast" — not merely "we know which endpoint to call." Without this, a warm
 * repeat of the SAME (skill, endpoint, args) re-pays the 5–13s endpoint round-trip
 * every call (U-8). The first call pays the cost; a later identical read inside the
 * TTL replays the stored result.
 *
 * Safety is a STRUCTURAL gate, not a per-site list: we only cache a result when it
 * is a read that is safe to replay byte-for-byte —
 *   - the executed endpoint is GET/HEAD (a write must always re-fire),
 *   - the call is not principal/session-scoped (auth_headers / session_id absent),
 *   - it is not a dry_run,
 *   - the execution succeeded (an error/empty/auth-required result honestly misses
 *     and retries next time).
 * Anything failing the gate is a pass-through (live execute every call).
 *
 * In-process only: the cache lives in the resident server / MCP process and dies
 * with it. It deliberately writes NO disk state, so a stateless CLI invocation
 * (a fresh process per call) never replays a stale cross-invocation result, and
 * UNBROWSE_STATELESS callers pay nothing. Disable entirely with TTL <= 0
 * (UNBROWSE_EXECUTE_CACHE_TTL_MS=0).
 */

export interface ExecuteCacheKeyInput {
  skillId: string;
  endpointId: string;
  /** Endpoint params actually sent to the executor (post fill/normalization). */
  params: Record<string, unknown>;
}

export interface ExecuteCacheGuard {
  /** HTTP method of the executed endpoint, if known. Only GET/HEAD are cacheable. */
  method?: string;
  /** True when the caller supplied auth headers — never cache a principal-scoped read. */
  hasAuth?: boolean;
  /** True when the call is session-scoped (yield store) — never cache. */
  hasSession?: boolean;
  /** True for a dry_run — never cache. */
  dryRun?: boolean;
  /** True when the execution trace reported success. Only successes are cacheable. */
  success: boolean;
}

interface CacheEntry<T> {
  value: T;
  expires: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

export function executeCacheTtlMs(): number {
  const raw = process.env.UNBROWSE_EXECUTE_CACHE_TTL_MS;
  if (raw === undefined) return 60_000; // 60s default
  const n = Number(raw);
  return Number.isFinite(n) ? n : 60_000;
}

/** Stable, order-independent key for (skill, endpoint, args). Volatile fields the
 *  caller already excludes (context_url, session_id, intent, endpoint_id) are not
 *  part of `params` here — `params` is the executor input. We sort keys so arg order
 *  cannot fork the key. */
export function executeCacheKey(input: ExecuteCacheKeyInput): string {
  const sortedParams = stableStringify(input.params ?? {});
  return `${input.skillId}${input.endpointId}${sortedParams}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** A result is cacheable only when it is a safe-to-replay read: GET/HEAD, no
 *  auth/session scope, not a dry_run, and it succeeded. Generalized structural
 *  gate — adds zero per-site entries. */
export function isExecuteResultCacheable(guard: ExecuteCacheGuard): boolean {
  if (executeCacheTtlMs() <= 0) return false;
  if (!guard.success) return false;
  if (guard.dryRun) return false;
  if (guard.hasAuth) return false;
  if (guard.hasSession) return false;
  const method = (guard.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  return true;
}

export function getCachedExecuteResult<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expires) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function setCachedExecuteResult<T>(key: string, value: T): void {
  const ttl = executeCacheTtlMs();
  if (ttl <= 0) return;
  cache.set(key, { value, expires: Date.now() + ttl });
}

/** Test-only: drop all entries so a cache-hit test starts cold. */
export function _clearExecuteResultCacheForTests(): void {
  cache.clear();
}
