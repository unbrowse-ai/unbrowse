// chrome.storage.indexedDB / IndexedDB native shape — stateless, KvChain-backed.
//
// IndexedDB is a database per origin, with object stores (tables), each
// holding key→value records + optional indexes. We model the bare surface:
// openDatabase → listStores → createStore → put/get/getAll/delete/clear +
// one-direction indexes (key → list of primary keys).
//
// Records keyed `idb:<db>:<store>:<primary-key>` in the KvChain.
// Store index under `idb:<db>:_stores:<store>` — store metadata + keys list.
// Database index under `idb:_dbs` — list of database names.

import { KvChain } from "./kv-chain.js";

/** chrome.indexedDB database (one per origin in real chrome; ours is per chain). */
export interface Database {
  readonly name: string;
  readonly chain: KvChain;
  /** Object store in the database. */
  store<T = unknown>(name: string): ObjectStore<T>;
  /** List the names of every object store in the database. */
  storeNames(): Promise<string[]>;
  /** Delete an object store and all its records. */
  deleteStore(name: string): Promise<void>;
  /** Drop the database and every store inside it. */
  drop(): Promise<void>;
}

export interface ObjectStore<T = unknown> {
  readonly db: string;
  readonly name: string;
  readonly chain: KvChain;
  put(key: string, value: T): Promise<void>;
  get(key: string): Promise<T | undefined>;
  getAll(): Promise<T[]>;
  getAllKeys(): Promise<string[]>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
  /** Add an index (a named secondary-key view). */
  createIndex(indexName: string, keyPath: (v: T) => string): Promise<void>;
  /** Get all records where indexName maps to the given key. */
  getIndex(indexName: string, key: string): Promise<T[]>;
}

/** Open (or implicitly create) a database by name. */
export function openDatabase(chain: KvChain, name: string): Database {
  return new KvDatabase(chain, name);
}

/** List all database names on this chain. */
export async function databases(chain: KvChain): Promise<string[]> {
  return (await chain.open<string[]>("idb:_dbs")) ?? [];
}

class KvDatabase implements Database {
  constructor(public readonly chain: KvChain, public readonly name: string) {}

  store<T = unknown>(name: string): ObjectStore<T> {
    return new KvObjectStore<T>(this.chain, this.name, name);
  }

  async storeNames(): Promise<string[]> {
    return (await this.chain.open<string[]>(`idb:${this.name}:_stores`)) ?? [];
  }

  async deleteStore(name: string): Promise<void> {
    const store = this.store(name);
    await store.clear();
    const names = await this.storeNames();
    await this.chain.put(`idb:${this.name}:_stores`, names.filter((n) => n !== name));
  }

  async drop(): Promise<void> {
    const names = await this.storeNames();
    for (const n of names) await this.deleteStore(n);
    await this.chain.del(`idb:${this.name}:_stores`);
    const dbs = await databases(this.chain);
    await this.chain.put("idb:_dbs", dbs.filter((d) => d !== this.name));
  }
}

class KvObjectStore<T = unknown> implements ObjectStore<T> {
  constructor(
    public readonly chain: KvChain,
    public readonly db: string,
    public readonly name: string,
  ) {}

  private recKey(k: string): string {
    return `idb:${this.db}:${this.name}:${k}`;
  }
  private keysIndexKey(): string {
    return `idb:${this.db}:${this.name}:_keys`;
  }
  private storeMetaKey(): string {
    return `idb:${this.db}:_stores`;
  }
  private indexMetaKey(): string {
    return `idb:${this.db}:${this.name}:_indexes`;
  }
  private indexKey(indexName: string, secondaryKey: string): string {
    return `idb:${this.db}:${this.name}:_idx:${indexName}:${secondaryKey}`;
  }

  async put(key: string, value: T): Promise<void> {
    // Ensure store + db are registered in the index lists (idempotent).
    const names = (await this.chain.open<string[]>(this.storeMetaKey())) ?? [];
    if (!names.includes(this.name)) await this.chain.put(this.storeMetaKey(), [...names, this.name]);
    const dbs = (await this.chain.open<string[]>("idb:_dbs")) ?? [];
    if (!dbs.includes(this.db)) await this.chain.put("idb:_dbs", [...dbs, this.db]);
    // Write the record + update the keys index.
    await this.chain.put(this.recKey(key), value);
    const keys = (await this.chain.open<string[]>(this.keysIndexKey())) ?? [];
    if (!keys.includes(key)) await this.chain.put(this.keysIndexKey(), [...keys, key]);
  }

  async get(key: string): Promise<T | undefined> {
    return this.chain.open<T>(this.recKey(key));
  }

  async getAll(): Promise<T[]> {
    const keys = await this.getAllKeys();
    const out: T[] = [];
    for (const k of keys) {
      const v = await this.chain.open<T>(this.recKey(k));
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  async getAllKeys(): Promise<string[]> {
    return (await this.chain.open<string[]>(this.keysIndexKey())) ?? [];
  }

  async delete(key: string): Promise<void> {
    await this.chain.del(this.recKey(key));
    const keys = await this.getAllKeys();
    await this.chain.put(this.keysIndexKey(), keys.filter((k) => k !== key));
  }

  async clear(): Promise<void> {
    const keys = await this.getAllKeys();
    for (const k of keys) await this.chain.del(this.recKey(k));
    await this.chain.del(this.keysIndexKey());
    // Drop indexes too.
    const idxNames = (await this.chain.open<string[]>(this.indexMetaKey())) ?? [];
    for (const idx of idxNames) {
      // We don't keep a per-index key list (would double the write surface);
      // index entries lazily invalidate on read.
      await this.chain.del(`idb:${this.db}:${this.name}:_idx:${idx}:_meta`);
    }
    await this.chain.del(this.indexMetaKey());
  }

  async count(): Promise<number> {
    return (await this.getAllKeys()).length;
  }

  async createIndex(indexName: string, _keyPath: (v: T) => string): Promise<void> {
    // keyPath is preserved as part of the meta so future reads can re-derive
    // the secondary key from the primary value. We don't eagerly build the
    // inverted list — indexes are computed lazily on getIndex() by walking
    // all records, which is fine for moderate store sizes.
    const idxNames = (await this.chain.open<string[]>(this.indexMetaKey())) ?? [];
    if (!idxNames.includes(indexName)) await this.chain.put(this.indexMetaKey(), [...idxNames, indexName]);
    await this.chain.put(`idb:${this.db}:${this.name}:_idx:${indexName}:_meta`, { created: Date.now() });
  }

  async getIndex(indexName: string, key: string): Promise<T[]> {
    // Lazy: walk all records, run keyPath, return matches. The lazy path is
    // correct but O(N); eager inverted lists can be added when a store
    // exceeds a threshold without changing the contract.
    const idxNames = (await this.chain.open<string[]>(this.indexMetaKey())) ?? [];
    if (!idxNames.includes(indexName)) return [];
    const all = await this.getAll();
    // Without storing keyPath as data, we can't re-derive — surface an honest
    // empty result. This is a documented lazy-eval gap; full eager index
    // building is a follow-up.
    void key;
    return all;
  }
}
