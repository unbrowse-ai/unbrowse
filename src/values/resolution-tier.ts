/**
 * resolution-tier — pick where a resolution is cached: the durable/shared REMOTE tier
 * (Cloudflare R2 blob + IQLabs on-chain signed ledger) when its credentials are present,
 * else the LOCAL fs tier. One selector so every cache call routes the same way and the
 * remote tier lights up by configuration alone — no code change at the call sites.
 *
 *   creds present  -> remote (R2 + IQ) : shared across hosts, signed history of values
 *   creds absent   -> local fs cache   : the default, zero-config
 *
 * The remote constructors already fail closed to null without creds (r2ConfigFromEnv /
 * iqClientFromEnv), so selection is just "did both come back". Injectable for tests.
 */
import type { CachedResolution } from "./cached-resolution.js";
import { cachedResolution } from "./cached-resolution.js";
import {
  intentKey, putBlobAsync, resolvePointerAsync,
  type AsyncBlobStore, type AsyncResolutionLedger,
} from "./async-resolution.js";

export type Tier = "remote" | "local";

export interface RemoteTier {
  store: AsyncBlobStore;
  ledger: AsyncResolutionLedger;
}

/** True iff the remote tier is fully configured (both an R2 store and an IQ ledger). */
export function remoteTierConfigured(remote: RemoteTier | null): remote is RemoteTier {
  return remote !== null && typeof remote.store?.get === "function" && typeof remote.ledger?.find === "function";
}

export function selectTier(remote: RemoteTier | null): Tier {
  return remoteTierConfigured(remote) ? "remote" : "local";
}

/**
 * Resolve an intent through whichever tier is configured. Remote: content-addressed in
 * R2, recorded on the IQ signed ledger (shared + history). Local: the fs cache. Same
 * caller contract either way; only successful results (per cacheable) are persisted, so
 * errors/empties never pollute the ledger. ttlMs<=0 disables caching (pass-through).
 */
export async function resolveCached<T>(opts: {
  key: string;
  ttlMs: number;
  recompute: () => Promise<T>;
  cacheable: (v: T) => boolean;
  remote?: RemoteTier | null;
  now?: number;
  /** local fs cache dir (defaults to ~/.unbrowse/resolution-cache); for tests. */
  dir?: string;
}): Promise<CachedResolution<T> & { tier: Tier }> {
  const tier = selectTier(opts.remote ?? null);
  if (tier === "remote" && remoteTierConfigured(opts.remote ?? null)) {
    const { store, ledger } = opts.remote as RemoteTier;
    const now = opts.now ?? Date.now();
    const key = intentKey(opts.key);
    if (opts.ttlMs > 0) {
      const hit = await ledger.find(key);
      if (hit && hit.ts != null && now - hit.ts <= opts.ttlMs) {
        const blob = await resolvePointerAsync(hit.result, store);
        if (blob !== null) return { value: JSON.parse(blob) as T, cached: true, tier };
      }
    }
    const value = await opts.recompute(); // errors propagate, never cached
    if (opts.ttlMs > 0 && opts.cacheable(value)) {
      const ptr = await putBlobAsync(JSON.stringify(value), store);
      await ledger.append(key, ptr, now); // signed, content-addressed, on the IQ ledger
    }
    return { value, cached: false, tier };
  }
  const local = await cachedResolution<T>({
    key: opts.key, ttlMs: opts.ttlMs, recompute: opts.recompute, cacheable: opts.cacheable, now: opts.now, dir: opts.dir,
  });
  return { ...local, tier };
}
