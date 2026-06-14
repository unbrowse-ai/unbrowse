/**
 * src/runtime/yield-store.ts — the session yield store (the pipe between holes).
 *
 * A write yields a value (its `provides` binding, e.g. a created-resource id). The
 * next op in the same session has an unfilled `requires` hole of the same key. This
 * store is the pipe: capture the write's yield, fill the downstream hole.
 *
 * Boundary (Genesis 1:6-7 firmament): this is session-scoped, in-memory, ephemeral —
 * the ONLY place a yielded value lives in clear, and only in-process. It never crosses
 * to disk (writeSkillCache → commitments) or publish (sanitize → placeholders). Yields
 * are the caller's OWN data flowing between the caller's OWN sequential ops.
 *
 * Aligned to the existing chain-walk types (SessionYield / SessionYieldCache) so the
 * captured cache plugs straight into executeEndpointWithChain's `options.session_yields`.
 */
import type { OperationBinding, SessionYield, SessionYieldCache } from "../types/skill.js";

export type YieldStore = Map<string, SessionYieldCache>;

// Module-level default store. Tests inject a fresh Map via opts.store.
const moduleStore: YieldStore = new Map();

function cacheFor(sessionId: string, store: YieldStore): SessionYieldCache {
  let cache = store.get(sessionId);
  if (!cache) {
    cache = new Map();
    store.set(sessionId, cache);
  }
  return cache;
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
  opts?: { store?: YieldStore; nowIso?: string },
): number {
  if (!sessionId || !Array.isArray(provides) || provides.length === 0) return 0;
  const store = opts?.store ?? moduleStore;
  const nowIso = opts?.nowIso ?? new Date().toISOString();
  const cache = cacheFor(sessionId, store);
  let n = 0;
  for (const b of provides) {
    if (!b?.key || b.example_value === undefined) continue;
    cache.set(b.key, {
      value: b.example_value,
      observed_at: b.observed_at ?? nowIso,
      ...(typeof b.ttl_ms === "number" ? { ttl_ms: b.ttl_ms } : {}),
      ...(b.single_use ? { single_use: true } : {}),
    });
    n++;
  }
  return n;
}

/** The session's yield cache, to pass as executeEndpointWithChain options.session_yields. */
export function getYieldCache(
  sessionId: string,
  opts?: { store?: YieldStore },
): SessionYieldCache | undefined {
  return (opts?.store ?? moduleStore).get(sessionId);
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
  opts?: { store?: YieldStore; nowMs?: number },
): { filled: string[]; params: Record<string, unknown> } {
  const filled: string[] = [];
  if (!sessionId || !Array.isArray(requires) || requires.length === 0) return { filled, params };
  const cache = (opts?.store ?? moduleStore).get(sessionId);
  if (!cache) return { filled, params };
  const nowMs = opts?.nowMs ?? Date.now();
  for (const b of requires) {
    if (!b?.key) continue;
    if (params[b.key] !== undefined && params[b.key] !== null) continue; // hole already filled
    const y = cache.get(b.key);
    if (!y || isYieldStale(y, nowMs)) continue;
    params[b.key] = y.value;
    filled.push(b.key);
    if (y.single_use) cache.delete(b.key);
  }
  return { filled, params };
}

/** Drop a session's yields (e.g. on session close). */
export function clearSessionYields(sessionId: string, opts?: { store?: YieldStore }): void {
  (opts?.store ?? moduleStore).delete(sessionId);
}
