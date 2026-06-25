// chrome.storage.* — stateless shape, backed by KvChain (no real Chrome).
//
// Implements chrome.storage.local + chrome.storage.sync. Same shape as
// https://developer.chrome.com/docs/extensions/reference/storage/ — get/set/
// remove/clear/getBytesInUse + onChanged event. The two areas differ only
// in quota semantics (sync is rate-limited + bounded; local is "large").
// Stateless impl: quota is enforced via in-memory byte counters only.
//
// Keys are stored under `storage:<area>:<key>` in the KvChain; an index
// `storage:<area>:_index` tracks the set of keys per area for enumeration.

import { KvChain } from "./kv-chain.js";

export type StorageArea = "local" | "sync";

/** chrome.storage.StorageArea — get/set/remove/clear/getBytesInUse + onChanged. */
export interface StorageAreaApi {
  area: StorageArea;
  chain: KvChain;
  /** get(keys?) — return a map of the requested keys (or all when null/[]).
   *  chrome semantics: pass null, undefined, [], ["k1","k2"], or "k". */
  get(keys?: string | string[] | null | Record<string, unknown>): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
  getBytesInUse(keys?: string | string[]): Promise<number>;
}

/** chrome.storage.local — large quota (10 MB by default; chrome allows unlimited). */
export const MAX_LOCAL_BYTES = 10 * 1024 * 1024;
/** chrome.storage.sync — bounded (QUOTA_BYTES = 102,400; QUOTA_BYTES_PER_ITEM = 8,192). */
export const MAX_SYNC_BYTES = 102_400;
export const MAX_SYNC_BYTES_PER_ITEM = 8_192;
export const MAX_SYNC_ITEMS = 512;
export const MAX_SYNC_WRITE_OPERATIONS_PER_HOUR = 1_800;
export const MAX_SYNC_WRITE_OPERATIONS_PER_MINUTE = 120;

/** Build a StorageArea API bound to a KvChain. */
export function openArea(chain: KvChain, area: StorageArea): StorageAreaApi {
  return new KvStorageArea(chain, area);
}

class KvStorageArea implements StorageAreaApi {
  constructor(public chain: KvChain, public area: StorageArea) {}

  private key(k: string): string {
    return `storage:${this.area}:${k}`;
  }
  private indexKey(): string {
    return `storage:${this.area}:_index`;
  }

  async get(keys?: string | string[] | null | Record<string, unknown>): Promise<Record<string, unknown>> {
    const ks = this.normalizeKeys(keys);
    if (ks === null) {
      // get all keys in the area
      const all = (await this.chain.open<string[]>(this.indexKey())) ?? [];
      const out: Record<string, unknown> = {};
      for (const k of all) {
        const v = await this.chain.open(this.key(k));
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const k of ks) {
      const v = await this.chain.open(this.key(k));
      out[k] = v ?? (typeof keys === "object" && keys !== null && !Array.isArray(keys) ? (keys as Record<string, unknown>)[k] : undefined);
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.area === "sync") this.assertSyncQuota(items);
    const index = (await this.chain.open<string[]>(this.indexKey())) ?? [];
    const set = new Set(index);
    for (const [k, v] of Object.entries(items)) {
      await this.chain.put(this.key(k), v);
      set.add(k);
    }
    await this.chain.put(this.indexKey(), [...set]);
  }

  async remove(keys: string | string[]): Promise<void> {
    const ks = Array.isArray(keys) ? keys : [keys];
    const index = (await this.chain.open<string[]>(this.indexKey())) ?? [];
    const set = new Set(index);
    for (const k of ks) {
      await this.chain.del(this.key(k));
      set.delete(k);
    }
    await this.chain.put(this.indexKey(), [...set]);
  }

  async clear(): Promise<void> {
    const index = (await this.chain.open<string[]>(this.indexKey())) ?? [];
    for (const k of index) await this.chain.del(this.key(k));
    await this.chain.del(this.indexKey());
  }

  async getBytesInUse(keys?: string | string[]): Promise<number> {
    const ks = keys === undefined ? null : this.normalizeKeys(keys);
    const all = ks === null
      ? (await this.chain.open<string[]>(this.indexKey())) ?? []
      : ks;
    let total = 0;
    for (const k of all) {
      const v = await this.chain.open(this.key(k));
      if (v !== undefined) total += byteSize(v) + k.length;
    }
    return total;
  }

  private normalizeKeys(keys: string | string[] | null | undefined | Record<string, unknown>): string[] | null {
    if (keys === null || keys === undefined) return null;
    if (typeof keys === "string") return [keys];
    if (Array.isArray(keys)) return keys;
    if (typeof keys === "object") return Object.keys(keys);
    return null;
  }

  private assertSyncQuota(items: Record<string, unknown>): void {
    if (Object.keys(items).length > MAX_SYNC_ITEMS - 1) {
      throw new Error(`chrome.storage.sync: too many items at once (${Object.keys(items).length} > ${MAX_SYNC_ITEMS - 1})`);
    }
    for (const [k, v] of Object.entries(items)) {
      const size = byteSize(v) + k.length;
      if (size > MAX_SYNC_BYTES_PER_ITEM) {
        throw new Error(`chrome.storage.sync: item "${k}" exceeds per-item quota (${size} > ${MAX_SYNC_BYTES_PER_ITEM} bytes)`);
      }
    }
  }
}

/** chrome.storage.onChanged — event stub. Stateless impl has no events;
 *  callers poll get() or replay the ledger. Returns a no-op unsub. */
export function onChanged(_area: StorageAreaApi, _cb: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: StorageArea) => void): () => void {
  return () => { /* no-op */ };
}

/** Estimate the byte size of a value (JSON-serialized). */
function byteSize(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
  } catch {
    return 0;
  }
}
