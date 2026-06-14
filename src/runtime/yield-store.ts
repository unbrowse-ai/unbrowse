/**
 * src/runtime/yield-store.ts — the session yield store (the pipe between holes).
 *
 * A write yields a value (its `provides` binding, e.g. a created-resource id). The
 * next op in the same session has an unfilled `requires` hole of the same key. This
 * store is the pipe: capture the write's yield, fill the downstream hole.
 *
 * Boundary (Genesis 1:6-7 firmament): yields are the caller's OWN data flowing between
 * the caller's OWN ops. They persist to a per-session DISK file so a SEPARATE CLI
 * invocation sharing the same --session inherits them (the stateless binary gets state
 * via disk, like cookies). The firmament still holds: a SENSITIVE yield (a token/secret
 * a write returned) is written to disk as a sha256 COMMITMENT, never in clear, and a
 * committed yield cannot auto-fill — the caller re-supplies the secret. Ids/slugs persist
 * real so the pipe flows across processes; secrets never cross the disk firmament in clear.
 *
 * Aligned to the existing chain-walk types (SessionYield / SessionYieldCache) so the
 * captured cache plugs straight into executeEndpointWithChain's `options.session_yields`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OperationBinding, SessionYield, SessionYieldCache } from "../types/skill.js";
import { isSensitiveFieldName, commitValue } from "../proof/input-censor.js";

export type YieldStore = Map<string, SessionYieldCache>;

// Module-level default store. Tests inject a fresh Map via opts.store. Only the
// moduleStore is disk-backed; an injected store stays purely in-memory (hermetic tests).
const moduleStore: YieldStore = new Map();

// ── Disk persistence (cross-process session state) ────────────────────────────
function configDir(): string {
  return process.env.UNBROWSE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), ".unbrowse");
}
function yieldSessionDir(): string {
  return path.join(configDir(), "yield-sessions");
}
function isSafeSessionId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 200 && /^[A-Za-z0-9._@:-]+$/.test(id);
}
function sessionFile(sessionId: string): string {
  // base64url the id so any session string maps to one safe filename.
  const safe = Buffer.from(sessionId).toString("base64url").slice(0, 120);
  return path.join(yieldSessionDir(), `${safe}.json`);
}

/** Persist a session's cache to disk; sensitive yields are committed (hashed), not clear. */
function persistSession(sessionId: string, cache: SessionYieldCache): void {
  if (!isSafeSessionId(sessionId)) return;
  try {
    const dir = yieldSessionDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entries: Array<[string, SessionYield]> = [];
    for (const [k, y] of cache.entries()) {
      if (y.sensitive) {
        // commit the secret — the disk copy carries only the hash.
        entries.push([k, { value: commitValue(String(y.value)), observed_at: y.observed_at, committed: true, ...(y.ttl_ms ? { ttl_ms: y.ttl_ms } : {}), ...(y.single_use ? { single_use: true } : {}) }]);
      } else {
        entries.push([k, y]);
      }
    }
    writeFileSync(sessionFile(sessionId), JSON.stringify({ v: 1, entries }), "utf-8");
  } catch { /* best-effort — disk persistence never breaks the in-flight op */ }
}

/** Load a session's cache from disk (the cross-process inheritance). */
function loadSession(sessionId: string): SessionYieldCache | null {
  if (!isSafeSessionId(sessionId)) return null;
  try {
    const raw = readFileSync(sessionFile(sessionId), "utf-8");
    const parsed = JSON.parse(raw) as { v?: number; entries?: Array<[string, SessionYield]> };
    if (!Array.isArray(parsed.entries)) return null;
    return new Map(parsed.entries);
  } catch { return null; }
}

function cacheFor(sessionId: string, store: YieldStore): SessionYieldCache {
  let cache = store.get(sessionId);
  if (!cache) {
    // Cross-process inheritance: the disk-backed moduleStore loads a prior CLI
    // invocation's persisted yields. Injected (test) stores stay purely in-memory.
    cache = (store === moduleStore ? loadSession(sessionId) : null) ?? new Map();
    store.set(sessionId, cache);
  }
  return cache;
}

/**
 * The cache key. A bare binding key like `id` collides across resources (a write to
 * /posts and a write to /comments both yield `id`); the latest would mis-fill a
 * downstream hole with the wrong resource's id. SCOPE is the contract's "right
 * condition" (Lewis): when a producer/consumer declares its resource scope, the
 * yield is namespaced `scope::key`, so `posts::id` never fills a `comments::id` hole.
 * Unscoped keys stay bare (the single-producer golden path); a scoped yield never
 * fills an unscoped hole and vice-versa — the two waters do not mix.
 */
function scopedKey(key: string, scope?: string): string {
  // Length-prefix the scope so the delimiter cannot be injected: `${scope}::${key}`
  // would let scope="a",key="b::c" collide with scope="a::b",key="c" (both "a::b::c").
  // `${len}:${scope}:${key}` is unambiguous — the length pins where the scope ends.
  return scope ? `${scope.length}:${scope}:${key}` : key;
}

/** True when a yield is past its ttl_ms relative to `nowMs`. */
export function isYieldStale(y: SessionYield, nowMs: number): boolean {
  if (typeof y.ttl_ms !== "number") return false;
  const observed = Date.parse(y.observed_at);
  if (!Number.isFinite(observed)) return false;
  return nowMs - observed > y.ttl_ms;
}

/**
 * Capture a completed op's `provides` bindings into the session's yield cache.
 * Each binding's `example_value` is the yielded value (yieldsFromResponse fills it
 * from the response). Returns the count recorded.
 */
export function recordYields(
  sessionId: string,
  provides: OperationBinding[] | undefined,
  opts?: { store?: YieldStore; nowIso?: string; scope?: string },
): number {
  if (!sessionId || !Array.isArray(provides) || provides.length === 0) return 0;
  const store = opts?.store ?? moduleStore;
  const nowIso = opts?.nowIso ?? new Date().toISOString();
  const cache = cacheFor(sessionId, store);
  let n = 0;
  for (const b of provides) {
    if (!b?.key || b.example_value === undefined) continue;
    cache.set(scopedKey(b.key, opts?.scope), {
      value: b.example_value,
      observed_at: b.observed_at ?? nowIso,
      ...(typeof b.ttl_ms === "number" ? { ttl_ms: b.ttl_ms } : {}),
      ...(b.single_use ? { single_use: true } : {}),
      // mark sensitive-named yields so the disk copy commits (hashes) them, not clear.
      ...(isSensitiveFieldName(b.key) ? { sensitive: true } : {}),
    });
    n++;
  }
  if (store === moduleStore && n > 0) persistSession(sessionId, cache);
  return n;
}

/** The session's yield cache, to pass as executeEndpointWithChain options.session_yields. */
export function getYieldCache(
  sessionId: string,
  opts?: { store?: YieldStore },
): SessionYieldCache | undefined {
  const store = opts?.store ?? moduleStore;
  const inMem = store.get(sessionId);
  if (inMem) return inMem;
  // disk-backed inheritance for the moduleStore
  if (store === moduleStore) {
    const loaded = loadSession(sessionId);
    if (loaded) { store.set(sessionId, loaded); return loaded; }
  }
  return undefined;
}

/**
 * Fill a downstream op's unfilled `requires` holes from the session's yields.
 * A hole is a required binding whose key is absent from `params`. A fresh (non-stale)
 * yield of the same key fills it. `single_use` yields are consumed (deleted) on fill.
 * Returns the filled keys and the (mutated) params.
 */
export function fillHolesFromYields(
  sessionId: string,
  requires: OperationBinding[] | undefined,
  params: Record<string, unknown>,
  opts?: { store?: YieldStore; nowMs?: number; scope?: string },
): { filled: string[]; params: Record<string, unknown> } {
  const filled: string[] = [];
  if (!sessionId || !Array.isArray(requires) || requires.length === 0) return { filled, params };
  const store = opts?.store ?? moduleStore;
  const cache = store.get(sessionId) ?? (store === moduleStore ? loadSession(sessionId) ?? undefined : undefined);
  if (!cache) return { filled, params };
  if (store === moduleStore && !store.get(sessionId)) store.set(sessionId, cache);
  const nowMs = opts?.nowMs ?? Date.now();
  let consumed = false;
  for (const b of requires) {
    if (!b?.key) continue;
    if (params[b.key] !== undefined && params[b.key] !== null) continue; // hole already filled
    const ck = scopedKey(b.key, opts?.scope);
    const y = cache.get(ck);
    if (!y || isYieldStale(y, nowMs)) continue;
    // A committed yield carries only a hash (the producer was sensitive) — it cannot
    // supply the real secret, so it does not fill. The caller must pass the value.
    if (y.committed) continue;
    params[b.key] = y.value;
    filled.push(b.key);
    if (y.single_use) { cache.delete(ck); consumed = true; }
  }
  if (consumed && store === moduleStore) persistSession(sessionId, cache); // single-use consumption is durable
  return { filled, params };
}

/** Drop a session's yields (e.g. on session close) — in-memory and on disk. */
export function clearSessionYields(sessionId: string, opts?: { store?: YieldStore }): void {
  const store = opts?.store ?? moduleStore;
  store.delete(sessionId);
  if (store === moduleStore && isSafeSessionId(sessionId)) {
    try { if (existsSync(sessionFile(sessionId))) unlinkSync(sessionFile(sessionId)); } catch { /* best-effort */ }
  }
}
