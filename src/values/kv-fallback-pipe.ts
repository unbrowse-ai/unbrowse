/**
 * kv-fallback-pipe — "everything is a fallback to another that is kv cached to a pipe."
 *
 * The whitepaper's end-to-end argument (§2) gives the descent its order: a function
 * lives at the HIGHEST layer that can do it completely and correctly, and lower
 * layers are fallback, not first resort — a cached signed plan beats a CLI call beats
 * a browser action beats moving a mouse across pixels. This primitive realises that
 * as a resolver:
 *
 *   - Walk the layers highest-capable-first (screen → browser → cli → os → kernel →
 *     packet). The first layer that can act (non-null) wins; lower layers are never
 *     reached. Each layer is a fallback to the one below it.
 *   - Every resolved result is memoised under a CONTENT-ADDRESSED key (the intent's
 *     hash). A cache hit SHORT-CIRCUITS the entire descent — no layer is walked, the
 *     fastest possible path. This is the "kv cached to a pipe" the north star names.
 *
 * Pure over its inputs (cache + layer resolvers are injected), so the descent +
 * caching behaviour is fully testable without any live layer.
 */
import { contentHash } from "./wallet-seal.js";
import { LAYERS } from "./signed-descent.js";

/** A layer can act on the intent (returns a value) or pass (returns null/undefined,
 *  i.e. "I can't do this — fall through to the layer below me"). */
export type LayerResolver<T> = (intent: string) => Promise<T | null | undefined> | (T | null | undefined);

export interface PipeLayer<T> {
  layer: string;
  resolve: LayerResolver<T>;
}

export interface PipeResult<T> {
  value: T;
  /** which layer produced it — a descent layer name, or "cache" on a hit. */
  layer: string;
  cached: boolean;
  /** the layers walked before a hit, in descent order (empty on a cache hit). */
  attempted: string[];
}

/** The minimal KV the pipe needs — a content-addressed store. */
export interface KvCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

/** An in-process content-addressed cache (the L0 tier). */
export function memCache<T>(): KvCache<T> {
  const m = new Map<string, T>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
}

const KEY_NS = "kv-fallback-pipe-v1:";

/** Content-addressed cache key for an intent — same intent, same key, on any host. */
export function cacheKey(intent: string): string {
  return KEY_NS + contentHash(new TextEncoder().encode(intent));
}

/** The descent order, top (closest to the human) → bottom (closest to the wire). */
export const PIPE_LAYERS = LAYERS;

/**
 * Resolve an intent through the fallback pipe. A content-addressed cache hit
 * short-circuits the whole descent. Otherwise walk the layers highest-capable-first;
 * the first that resolves wins, its result is cached, and lower layers are never
 * reached. Returns null only when no layer can act on the intent.
 */
export async function resolveThroughPipe<T>(
  intent: string,
  layers: readonly PipeLayer<T>[],
  cache: KvCache<T> = memCache<T>(),
): Promise<PipeResult<T> | null> {
  const key = cacheKey(intent);
  const hit = cache.get(key);
  if (hit !== undefined) return { value: hit, layer: "cache", cached: true, attempted: [] };

  const attempted: string[] = [];
  for (const { layer, resolve } of layers) {
    attempted.push(layer);
    const v = await resolve(intent);
    if (v !== null && v !== undefined) {
      cache.set(key, v);
      return { value: v, layer, cached: false, attempted };
    }
  }
  return null;
}
