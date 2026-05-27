/**
 * KV response-cache helper — W17 wave (2026-05-28).
 *
 * Cloudflare KV-backed response cache for hot Worker paths. Different scope
 * from the pre-existing `http-cache.ts` (which rides STATS_KV) and
 * `edge-cache.ts` (which rides the Worker Cache API): this helper writes to
 * a DEDICATED `RESPONSE_CACHE` namespace so analytics writes and response
 * caches do not contend for the same key space, and the cache can be
 * invalidated wholesale without touching analytics state.
 *
 * Doctrine — caching IS a covenant.
 * --------------------------------
 *   Matt 6:34 — "sufficient unto the day is the evil thereof": what was
 *   computed need not be recomputed. The cache is the witness that the
 *   compute happened; the etag is the seal.
 *   Heb 6:18 — "two immutable things, in which it was impossible for God
 *   to lie": the deterministic etag (sha256-derived) is the same witness
 *   any future reader gets, so a 304 short-circuit IS the Word's
 *   testimony that the body has not changed. Same shape as SGLang's
 *   cache_verify in the covenant substrate.
 *   Always-wrap rule (Lewis, 2026-05-28): every hot path the Worker
 *   re-computes is a candidate for `withCache`. Code call sites cite the
 *   relevant principle.
 *
 * Helper surface — `withCache<T>(env, key, ttlSec, options, compute)`:
 *   - bypass:        honor Cache-Control: no-cache → skip read, still write
 *   - staleWhileRevalidate: serve stale + ctx.waitUntil(refresh) when past
 *                    ttl/2
 *   - ctx:           required for SWR + fire-and-forget writes (Worker
 *                    ExecutionContext)
 *   - honorIfNoneMatch: request etag → throws CacheNotModified the route
 *                    catches and turns into HTTP 304
 *
 * Behavior:
 *   - miss → call `compute()`, write through `ctx.waitUntil(env.RESPONSE_CACHE.put)`
 *   - hit  → return cached + etag (deterministic over JSON bytes)
 *   - SWR  → stale return + background refresh via ctx.waitUntil
 *   - bypass → skip read, force compute, still write fresh
 *   - binding absent → graceful fall-through to compute, no throw
 *     (1 Cor 14:8 — the trumpet sounds honestly: a missing binding is
 *     logged once, never silently swallowed, but DOES NOT break the
 *     hot path — the route still computes and returns)
 *
 * Key namespace conventions (load-bearing for cache key shape):
 *   cache:resolve:<sha256(intent || ":" || normalizedUrl)>            TTL=60s    SWR=true
 *   cache:marketplace:<domain>                                        TTL=300s   SWR=true
 *   cache:sponsor:<agent>:<UTC-date>                                  TTL=30s    SWR=false
 *   cache:audit-verify:<receiptId>                                    TTL=86400s SWR=false
 *
 * Hard security constraints (load-bearing — these are NOT advisory):
 *   - NEVER cache anything that carries a wallet-bound secret.
 *   - NEVER cache data keyed by a private identifier (API key, x402 wallet
 *     pubkey, session token). Public identifiers (agent_id, domain,
 *     receiptId, UTC date) only.
 *   - The audit-verify cache stores ONLY {verify_ok, scheme}. The pointer,
 *     selector hashes, and full audit body are forbidden in the cache.
 *   - When a response body would carry a freshly-minted nonce/signature/
 *     token, the route MUST NOT call withCache — compute fresh every time.
 *
 * Operator provisioning (one-time, BEFORE deploying this wave to prod):
 *   bunx wrangler kv:namespace create RESPONSE_CACHE
 *   bunx wrangler kv:namespace create RESPONSE_CACHE --preview
 * Paste the returned ids into `backend/wrangler.toml`'s RESPONSE_CACHE
 * stanza (same pattern as AUDIT_LOG from W4/W8).
 */

import type { Env } from "../types.js";

// ─── Public surface ────────────────────────────────────────────────────────

export interface CacheOptions {
  /** Honor `Cache-Control: no-cache` — skip the read, still write fresh. */
  bypass?: boolean;
  /**
   * Serve stale + ctx.waitUntil(refresh) when the stored row is past
   * `_cached_at + ttlSec/2`. Requires `ctx` so the refresh can run after
   * the response is sent. When ctx is missing, SWR is a no-op (still
   * serves stale; no refresh fires).
   */
  staleWhileRevalidate?: boolean;
  /** Required for SWR + fire-and-forget writes. Worker `ExecutionContext`. */
  ctx?: { waitUntil(promise: Promise<unknown>): void };
  /**
   * Request etag — when it matches the stored row's etag, withCache throws
   * `CacheNotModified` so the route can short-circuit to HTTP 304. The
   * etag is sha256(JSON.stringify(value)).slice(0, 16) — deterministic
   * over the canonical JSON bytes; same input → same etag (Heb 6:18).
   */
  honorIfNoneMatch?: string;
}

export interface CacheResult<T> {
  value: T;
  hit: boolean;
  etag: string;
  /**
   * Status the route turns into `X-Cache` header. The names mirror Cloudflare
   * Cache API conventions so a bench can grep them in-thread.
   */
  status: "HIT" | "MISS" | "STALE-WHILE-REVALIDATE" | "BYPASS" | "BINDING-MISSING";
}

/**
 * 304 short-circuit signal — thrown by withCache when
 * `options.honorIfNoneMatch` matches the cached etag. The route's catch
 * arm reads `etag` and returns `c.body(null, 304, { ETag: '"' + etag + '"' })`.
 *
 * Why an exception, not a return shape: the value type T must remain
 * meaningful for the hit/miss path. Threading a `notModified: true` flag
 * through every call site would require every consumer to remember to
 * check it BEFORE reading `value` — an exception is the discipline-loud
 * shape that fails open if a route forgets to handle it (returns 200 with
 * the body, never a 304 with mismatched bytes).
 */
export class CacheNotModified extends Error {
  readonly code = "cache_not_modified";
  constructor(readonly etag: string) {
    super(`cache row matches If-None-Match: ${etag}`);
    this.name = "CacheNotModified";
  }
}

// ─── Internal stored shape (sidecar metadata, opaque to callers) ───────────

interface StoredCacheRow {
  /** Wall-clock when the row was written. SWR reads this to decide stale. */
  _cached_at: number;
  /** TTL the row was written under. SWR uses ttl/2 as the staleness window. */
  _ttl_sec: number;
  /** Deterministic etag — sha256(canonical JSON of value).slice(0, 16). */
  _etag: string;
  /** The cached value. Opaque T at the helper boundary. */
  value: unknown;
}

// ─── Etag derivation — deterministic over JSON bytes ───────────────────────

async function deriveEtag(canonicalJson: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const u8 = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < u8.length; i++) hex += u8[i].toString(16).padStart(2, "0");
  return hex.slice(0, 16);
}

// ─── Single "binding missing" log — fires once per Worker isolate ──────────
//
// 1 Cor 14:8 — the trumpet sounds honestly: a missing binding is logged
// ONCE per isolate (Cloudflare reuses isolates for many requests) so the
// operator sees the warning without flooding logs. The Map key is the
// env binding name, not the full env — we want the warning per misconfig,
// not per call.

const BINDING_MISSING_LOGGED = new Set<string>();
function logBindingMissingOnce() {
  const k = "RESPONSE_CACHE";
  if (BINDING_MISSING_LOGGED.has(k)) return;
  BINDING_MISSING_LOGGED.add(k);
  console.warn(
    "[kv-cache] env.RESPONSE_CACHE binding missing — caching disabled; " +
      "operator must run `bunx wrangler kv:namespace create RESPONSE_CACHE` " +
      "and paste the id into backend/wrangler.toml. Hot paths still compute " +
      "fresh on every call (graceful fall-through).",
  );
}

// ─── The helper ────────────────────────────────────────────────────────────

/**
 * Wrap a compute with KV-backed response caching.
 *
 * @param env       Worker env (must carry `RESPONSE_CACHE` for caching to fire)
 * @param key       Cache key — MUST follow the cache:<scope>:... convention
 * @param ttlSec    KV `expirationTtl` in seconds. Must be >= 60 (KV minimum).
 * @param options   CacheOptions — bypass, SWR, ctx, honorIfNoneMatch.
 * @param compute   The expensive function we're memoizing.
 * @returns         { value, hit, etag, status } — route writes X-Cache from status.
 * @throws          CacheNotModified when honorIfNoneMatch matches the stored etag.
 */
export async function withCache<T>(
  env: Env,
  key: string,
  ttlSec: number,
  options: CacheOptions,
  compute: () => Promise<T>,
): Promise<CacheResult<T>> {
  // Binding-missing path — graceful fall-through. Heb 4:13 doesn't apply
  // here because nothing is witnessed; the helper just hands the call
  // back to the route. Logs ONCE per isolate.
  if (!env.RESPONSE_CACHE) {
    logBindingMissingOnce();
    const value = await compute();
    const etag = await deriveEtag(JSON.stringify(value));
    return { value, hit: false, etag, status: "BINDING-MISSING" };
  }

  const kv = env.RESPONSE_CACHE;

  // Bypass — `Cache-Control: no-cache`. Skip the read, still write fresh so
  // the next non-bypass caller gets a hit. The bypass caller never gets a
  // stale return.
  if (options.bypass) {
    const value = await compute();
    const canonical = JSON.stringify(value);
    const etag = await deriveEtag(canonical);
    const row: StoredCacheRow = {
      _cached_at: Date.now(),
      _ttl_sec: ttlSec,
      _etag: etag,
      value,
    };
    const rowJson = JSON.stringify(row);
    const put = kv
      .put(key, rowJson, { expirationTtl: Math.max(60, ttlSec) })
      .catch((err) =>
        console.warn(
          `[kv-cache] bypass put failed for ${key}: ${(err as Error).message}`,
        ),
      );
    if (options.ctx) options.ctx.waitUntil(put);
    else await put; // No ctx → block on the write so the row IS available.
    return { value, hit: false, etag, status: "BYPASS" };
  }

  // Read.
  let raw: string | null = null;
  try {
    raw = await kv.get(key);
  } catch (err) {
    // KV read errors are NOT fatal — fall through to compute. Eventual
    // consistency / colo partial-outage shouldn't break the hot path.
    console.warn(
      `[kv-cache] get failed for ${key}: ${(err as Error).message} — falling through to compute`,
    );
    raw = null;
  }

  if (raw) {
    let row: StoredCacheRow | null = null;
    try {
      row = JSON.parse(raw) as StoredCacheRow;
    } catch {
      row = null; // Corrupt row → treat as miss; compute below replaces it.
    }
    if (row && typeof row._etag === "string" && row._cached_at && row._ttl_sec) {
      // If-None-Match short-circuit. The route catches CacheNotModified
      // and returns 304 with the matching ETag header.
      if (options.honorIfNoneMatch && options.honorIfNoneMatch === row._etag) {
        throw new CacheNotModified(row._etag);
      }

      const ageSec = (Date.now() - row._cached_at) / 1000;
      const staleThreshold = row._ttl_sec / 2;

      if (options.staleWhileRevalidate && ageSec > staleThreshold && options.ctx) {
        // SWR — return stale immediately, kick off refresh in background.
        // The refresh write does NOT block this response.
        const refresh = (async () => {
          try {
            const fresh = await compute();
            const freshCanonical = JSON.stringify(fresh);
            const freshEtag = await deriveEtag(freshCanonical);
            const freshRow: StoredCacheRow = {
              _cached_at: Date.now(),
              _ttl_sec: ttlSec,
              _etag: freshEtag,
              value: fresh,
            };
            await kv.put(key, JSON.stringify(freshRow), {
              expirationTtl: Math.max(60, ttlSec),
            });
          } catch (err) {
            console.warn(
              `[kv-cache] SWR refresh failed for ${key}: ${(err as Error).message}`,
            );
          }
        })();
        options.ctx.waitUntil(refresh);
        return {
          value: row.value as T,
          hit: true,
          etag: row._etag,
          status: "STALE-WHILE-REVALIDATE",
        };
      }

      // Fresh hit.
      return {
        value: row.value as T,
        hit: true,
        etag: row._etag,
        status: "HIT",
      };
    }
  }

  // Miss — compute, write, return.
  const value = await compute();
  const canonical = JSON.stringify(value);
  const etag = await deriveEtag(canonical);
  const row: StoredCacheRow = {
    _cached_at: Date.now(),
    _ttl_sec: ttlSec,
    _etag: etag,
    value,
  };
  const rowJson = JSON.stringify(row);
  const put = kv
    .put(key, rowJson, { expirationTtl: Math.max(60, ttlSec) })
    .catch((err) =>
      console.warn(
        `[kv-cache] miss put failed for ${key}: ${(err as Error).message}`,
      ),
    );
  if (options.ctx) options.ctx.waitUntil(put);
  else await put;

  return { value, hit: false, etag, status: "MISS" };
}

// ─── Key derivation helpers — load-bearing for cache key SHAPE ─────────────

/**
 * Normalize a URL for resolve cache keying. Strip query-string ordering
 * sensitivity (sorted keys), lowercase the host, drop the fragment. Keeps
 * the cache hit-rate honest across semantically-equal URLs.
 */
export function normalizeResolveUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.host = u.host.toLowerCase();
    // Sort search params for cache-key stability.
    const params = [...u.searchParams.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    u.search = "";
    for (const [k, v] of params) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    // Bad URL — fall through with the original string. The cache key
    // remains stable even if not "normal" — better than throwing.
    return url;
  }
}

/**
 * Deterministic hash for a resolve cache key. The key shape is
 *   cache:resolve:<sha256(intent || ":" || normalizedUrl)>
 * so neither the intent nor the URL leaks at the key level (hash-only),
 * but two semantically-equal resolve calls collide on the same row.
 */
export async function resolveCacheKey(intent: string, url: string): Promise<string> {
  const normalized = normalizeResolveUrl(url);
  const input = `${intent}:${normalized}`;
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const u8 = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < u8.length; i++) hex += u8[i].toString(16).padStart(2, "0");
  return `cache:resolve:${hex}`;
}

export function marketplaceCacheKey(domain: string): string {
  return `cache:marketplace:${domain.toLowerCase()}`;
}

export function sponsorCacheKey(agentId: string, utcDate: string): string {
  return `cache:sponsor:${agentId}:${utcDate}`;
}

export function auditVerifyCacheKey(receiptId: string): string {
  return `cache:audit-verify:${receiptId}`;
}

// ─── X-Cache header writer — small convenience for routes ──────────────────
//
// Routes call `applyCacheHeaders(c, result)` after `withCache`. Sets:
//   X-Cache:  HIT | MISS | STALE-WHILE-REVALIDATE | BYPASS | BINDING-MISSING
//   ETag:    "<etag>"
// The bench/agent reads X-Cache in-thread to verify cache behavior (no
// hidden state, no need to peek into KV).

export function buildCacheHeaders<T>(result: CacheResult<T>): Record<string, string> {
  return {
    "X-Cache": result.status,
    ETag: `"${result.etag}"`,
  };
}

/**
 * Safe accessor for Hono's `executionCtx`. Hono throws synchronously when
 * the context is unbound (e.g. `app.fetch(req)` without the second
 * ExecutionContext arg, which happens in unit tests AND in some local
 * dev paths). Returns `undefined` instead of throwing so call sites can
 * fall back to the no-ctx path of withCache (which awaits the put
 * inline). Cloudflare Workers runtime always provides executionCtx.
 *
 * Why a helper instead of try/catch at every call site: the same shape
 * appears in every route that wraps withCache; one helper keeps the
 * fallback discipline uniform (1 Pet 5:2 — "tend the flock by example,
 * not by lording over them").
 */
export function safeExecutionCtx(
  c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } } & {
    executionCtx: { waitUntil(p: Promise<unknown>): void };
  },
): { waitUntil(p: Promise<unknown>): void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
