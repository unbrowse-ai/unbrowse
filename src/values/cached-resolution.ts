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
import { principalScope } from "../runtime/principal-scope.js";

export function defaultResolutionCacheDir(): string {
  return join(homedir(), ".unbrowse", "resolution-cache");
}

/** Partition a resolution signature by the verified auth principal. Unbound callers
 *  (principal === undefined) keep the bare key (legacy/public). A bound caller's key is
 *  prefixed with its non-reversible principal scope, so the content-addressed pointer
 *  differs per principal and an authed resolution is never replayed cross-principal.
 *  A U+001F unit separator (cannot occur in an intent) divides scope from key, so the
 *  prefix can never collide with a key that happens to start with the scope text. */
export function scopeResolutionKey(key: string, principal?: string): string {
  return principal === undefined ? key : `${principalScope(principal)}${key}`;
}

/** Fold the value pointers a resolution DEPENDS ON into its signature, so a change to ANY
 *  dependency re-keys this entry (its cached value is orphaned → recompute next time). This is
 *  the values-ledger pointer→pointer cascade: result B folds A's content pointer; A changes →
 *  A's pointer changes → B's key changes → B cascade-invalidates. Order-independent (sorted).
 *  The U+001F unit separator divides key from fold (cannot occur in an intent), AND the deps array
 *  is JSON-encoded — injective for arbitrary string deps: a dep literally "p1,p2" no longer collides
 *  with two deps ["p1","p2"] (a bare comma-join did; pointers are hex today, but the contract must
 *  hold for any future caller that folds non-hash value keys). Witnessed: dependency-cascade test. */
export function keyWithDeps(key: string, dependsOn?: readonly string[]): string {
  if (!dependsOn || dependsOn.length === 0) return key;
  return `${key}deps:${JSON.stringify([...dependsOn].sort())}`;
}

export interface CachedResolution<T> {
  value: T;
  cached: boolean;
  /** The content pointer of this resolution's result — surfaced so a DEPENDENT resolution can
   *  fold it via `dependsOn` (the pointer→pointer edge). null when not stored (uncacheable / ttl<=0). */
  pointer?: string | null;
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
  /** The VERIFIED auth credential this resolution belongs to. When set, the pointer key
   *  is partitioned per principal so an authed value is never replayed cross-principal.
   *  Omit (or pass "") for genuinely public/unauthenticated resolutions (shared "anon"). */
  principal?: string;
  /** Content pointers of the values this resolution CONSUMED (e.g. a prerequisite's result
   *  pointer). Folded into the key so a change to any dependency cascade-invalidates this
   *  entry — the values-ledger pointer→pointer edge. Omit for a leaf resolution. */
  dependsOn?: readonly string[];
}): Promise<CachedResolution<T>> {
  if (!(opts.ttlMs > 0)) return { value: await opts.recompute(), cached: false };

  const now = opts.now ?? Date.now();
  const dir = opts.dir ?? defaultResolutionCacheDir();
  let store, ledger, ptrKey: string;
  try {
    store = fsBlobStore(join(dir, "blobs"));
    ledger = fsLedger(join(dir, "resolutions.jsonl"));
    ptrKey = intentPointer(scopeResolutionKey(keyWithDeps(opts.key, opts.dependsOn), opts.principal));
    const hit = ledger.find(ptrKey);
    if (hit && hit.ts != null && now - hit.ts <= opts.ttlMs) {
      const cached = resolvePointer(hit.result, store);
      if (cached !== null) return { value: JSON.parse(cached) as T, cached: true, pointer: hit.result };
    }
  } catch {
    // cache read failed — fall through to a live recompute, no cache write
    return { value: await opts.recompute(), cached: false };
  }

  const value = await opts.recompute(); // errors propagate to the caller, never cached
  let pointer: string | null = null;
  try {
    if (opts.cacheable(value)) {
      pointer = putBlob(JSON.stringify(value), store);
      ledger.append(ptrKey, pointer, now);
    }
  } catch {
    /* cache write best-effort — the value is still returned */
  }
  return { value, cached: false, pointer };
}

/**
 * Read-only cache peek — returns the cached value for `key` if a FRESH entry exists,
 * else null. Pure fs, no recompute and no network: it never boots anything, so a hit
 * can short-circuit a command before any expensive setup. Disabled (null) when
 * ttlMs <= 0. Never throws. Pass `principal` to read only the per-principal partition.
 */
export function peekResolution<T>(key: string, ttlMs: number, dir?: string, now?: number, principal?: string): T | null {
  if (!(ttlMs > 0)) return null;
  try {
    const root = dir ?? defaultResolutionCacheDir();
    const ledger = fsLedger(join(root, "resolutions.jsonl"));
    const hit = ledger.find(intentPointer(scopeResolutionKey(key, principal)));
    if (!hit || hit.ts == null || (now ?? Date.now()) - hit.ts > ttlMs) return null;
    const cached = resolvePointer(hit.result, fsBlobStore(join(root, "blobs")));
    return cached === null ? null : (JSON.parse(cached) as T);
  } catch {
    return null;
  }
}

/** Write a value into the resolution cache under `key` (content-addressed pointer +
 *  ledger row). Best-effort: a write failure never throws. Pass `principal` to write
 *  into the per-principal partition (so it is only read back by the same principal). */
export function storeResolution<T>(key: string, value: T, ttlMs: number, dir?: string, now?: number, principal?: string): void {
  if (!(ttlMs > 0)) return;
  try {
    const root = dir ?? defaultResolutionCacheDir();
    const store = fsBlobStore(join(root, "blobs"));
    const ledger = fsLedger(join(root, "resolutions.jsonl"));
    const ptr = putBlob(JSON.stringify(value), store);
    ledger.append(intentPointer(scopeResolutionKey(key, principal)), ptr, now ?? Date.now());
  } catch {
    /* best-effort */
  }
}
