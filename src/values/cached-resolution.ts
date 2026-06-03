/**
 * cached-resolution — the reusable wrapper that turns the resolution-ledger
 * primitive (signature → pointer → resolve-or-recompute → ledger of resolutions)
 * into a one-call cache for any expensive truth resolution (search, intent-resolve).
 *
 * "Capture once, replay everywhere" for a resolution: the first call pays the cost
 * and records a content-addressed pointer in the on-disk ledger; every later call
 * within the TTL replays the pointer instead of recomputing. Only results the caller
 * deems cacheable are stored, so an error / empty / auth-required result honestly
 * misses and retries next time.
 *
 * Disabled (pass-through) when ttlMs <= 0 — set UNBROWSE_STATELESS=1 callers to 0 so
 * the stateless binary writes no local state. Cache I/O never breaks the call: any
 * store/ledger error falls through to a live recompute (recompute errors propagate).
 */
import { join } from "node:path";
import { homedir } from "node:os";
import {
  intentPointer, putBlob, resolvePointer, fsBlobStore, fsLedger,
} from "./resolution-ledger.js";

export function defaultResolutionCacheDir(): string {
  return join(homedir(), ".unbrowse", "resolution-cache");
}

export interface CachedResolution<T> {
  value: T;
  cached: boolean;
}

export async function cachedResolution<T>(opts: {
  /** a stable signature for the inputs (intent + params); hashed to the pointer key. */
  key: string;
  ttlMs: number;
  recompute: () => Promise<T>;
  /** only store results that pass this (e.g. non-empty, no error/auth_required). */
  cacheable: (v: T) => boolean;
  dir?: string;
  now?: number;
}): Promise<CachedResolution<T>> {
  if (!(opts.ttlMs > 0)) return { value: await opts.recompute(), cached: false };

  const now = opts.now ?? Date.now();
  const dir = opts.dir ?? defaultResolutionCacheDir();
  let store, ledger, ptrKey: string;
  try {
    store = fsBlobStore(join(dir, "blobs"));
    ledger = fsLedger(join(dir, "resolutions.jsonl"));
    ptrKey = intentPointer(opts.key);
    const hit = ledger.find(ptrKey);
    if (hit && hit.ts != null && now - hit.ts <= opts.ttlMs) {
      const cached = resolvePointer(hit.result, store);
      if (cached !== null) return { value: JSON.parse(cached) as T, cached: true };
    }
  } catch {
    // cache read failed — fall through to a live recompute, no cache write
    return { value: await opts.recompute(), cached: false };
  }

  const value = await opts.recompute(); // errors propagate to the caller, never cached
  try {
    if (opts.cacheable(value)) {
      const ptr = putBlob(JSON.stringify(value), store);
      ledger.append(ptrKey, ptr, now);
    }
  } catch {
    /* cache write best-effort — the value is still returned */
  }
  return { value, cached: false };
}
