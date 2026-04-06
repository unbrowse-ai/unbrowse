import { PgKV } from "./pg-kv.js";

/**
 * EmergentDB qdkv adapter — drop-in replacement for Cloudflare KV.
 *
 * Index design: values are stored INLINE in the index so that listWithValues()
 * never needs per-entry HTTP fetches. To stay within EmergentDB's value size
 * limit, the index is split into prefix-based sub-indexes:
 *
 *   _idx:main   — small entries (< 512 bytes each): intent-idx, agent, perf, etc.
 *   _idx:large  — large entries (>= 512 bytes): skill manifests, stats, etc.
 *
 * Each sub-index is independently sized. Reads load both in parallel (2 HTTP).
 * Writes update only the relevant sub-index.
 *
 * Subrequest budget (CF Workers limit: 50/request):
 * - `_idxLoad()`: 2 HTTP calls if cold (both sub-indexes), 0 if warm
 * - `get()`: 0 extra if value is in idx, 1 fallback fetch otherwise
 * - `listWithValues()`: 0 extra fetches — all values inline
 * - `putBatch()`: N data writes + 1 idx load + 1 idx save = N+2
 */

const BASE = "https://api.emergentdb.com";
const IDX_TTL_MS = 30_000;

/** Entries above this size go into the "large" sub-index */
const LARGE_THRESHOLD = 512;

/**
 * If a single sub-index exceeds this byte size, overflow entries (oldest first)
 * are evicted from the persistent index. Their values will be fetched on-demand
 * via direct qdkv/get, but this should be rare.
 */
const MAX_IDX_BYTES = 400_000;

interface IdxEntry { k: string; v: string }
interface ListResult { keys: { name: string }[]; list_complete: boolean; cursor?: string }
interface ValuedEntry { name: string; key: string; value: string }

// Per-namespace merged index cache — lives for the lifetime of the Worker isolate
const _cache = new Map<string, { entries: IdxEntry[]; expires: number }>();

export function clearKVCacheForTests(namespace?: string): void {
  if (namespace) {
    _cache.delete(namespace);
    return;
  }
  _cache.clear();
}

export class EdbKV {
  private h: Record<string, string>;
  private ns: string;

  constructor(apiKey: string, namespace: string) {
    this.h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    this.ns = namespace;
  }

  private k(key: string): string { return `${this.ns}:${key}`; }

  // --- public API ---

  /**
   * Read a key — always goes through the idx cache first.
   * Cost: 2 HTTP subrequests if cache is cold (both sub-indexes), then 0 for subsequent gets.
   * Falls back to a direct qdkv/get only for keys not present in the idx.
   */
  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    const entries = await this._idxLoad();
    const hit = entries.find(e => e.k === key);
    if (hit && hit.v) {
      return type === "json" ? safeJson(hit.v) : hit.v;
    }

    // Direct fetch — key exists in idx with empty v, or is a TTL/migrated entry
    const keyInIndex = !!hit;
    const maxAttempts = keyInIndex ? 3 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 200 * attempt));
      const res = await fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k(key))}`, { headers: this.h });
      if (!res.ok) continue;
      const data = await res.json() as { value?: string | null; found?: boolean };
      if (!data.found || data.value == null) continue;
      const val = data.value;

      // Backfill in-memory cache so subsequent gets in this request are free
      const cached = _cache.get(this.ns);
      if (cached) {
        const i = cached.entries.findIndex(e => e.k === key);
        if (i >= 0) cached.entries[i].v = val;
        else cached.entries.push({ k: key, v: val });
      }
      return type === "json" ? safeJson(val) : val;
    }
    return null;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const body: Record<string, unknown> = { key: this.k(key), value };
    if (opts?.expirationTtl) body.ttlMs = opts.expirationTtl * 1000;
    await fetch(`${BASE}/qdkv/set`, { method: "POST", headers: this.h, body: JSON.stringify(body) });
    if (!opts?.expirationTtl && !key.startsWith("_idx")) {
      await this._idxUpsert(key, value);
    }
  }

  /**
   * Atomic batch put: N parallel data writes + 1 idx load + 1 idx save.
   * Values are stored inline in the index for zero-fetch listWithValues.
   */
  async putBatch(pairs: Array<{ key: string; value: string }>, opts?: { expirationTtl?: number }): Promise<void> {
    const ttl = opts?.expirationTtl;
    const results = await Promise.all(pairs.map(({ key, value }) => {
      const body: Record<string, unknown> = { key: this.k(key), value };
      if (ttl) body.ttlMs = ttl * 1000;
      return fetch(`${BASE}/qdkv/set`, { method: "POST", headers: this.h, body: JSON.stringify(body) });
    }));
    for (const res of results) {
      if (!res.ok) throw new Error(`KV write failed: ${res.status}`);
    }
    if (!ttl) {
      const toIndex = pairs.filter(({ key }) => !key.startsWith("_idx"));
      if (toIndex.length > 0) {
        const entries = await this._idxLoad();
        for (const { key, value } of toIndex) {
          const i = entries.findIndex(e => e.k === key);
          if (i >= 0) {
            entries[i].v = value;
          } else {
            entries.push({ k: key, v: value });
          }
        }
        await this._idxSave(entries);
      }
    }
  }

  async delete(key: string): Promise<void> {
    await fetch(`${BASE}/qdkv/del/${encodeURIComponent(this.k(key))}`, { method: "DELETE", headers: this.h });
    await this._idxRemove(key);
  }

  async list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<ListResult> {
    const all = await this._idxLoad();
    const filtered = all.filter(e => e.k.startsWith(opts.prefix));
    const limit = opts.limit ?? 1000;
    const offset = opts.cursor ? parseInt(opts.cursor, 10) : 0;
    const page = filtered.slice(offset, offset + limit);
    const done = offset + limit >= filtered.length;
    return { keys: page.map(e => ({ name: e.k })), list_complete: done, cursor: done ? undefined : String(offset + limit) };
  }

  /**
   * List all entries matching a prefix with their values.
   * Cost: 0 extra HTTP — all values are inline in the index.
   * For legacy entries with empty v, fetches in parallel (max 30) and backfills.
   */
  async listWithValues(prefix: string): Promise<ValuedEntry[]> {
    const all = await this._idxLoad();
    const matching = all.filter(e => e.k.startsWith(prefix));

    const results: ValuedEntry[] = [];
    const needFetch: IdxEntry[] = [];

    for (const e of matching) {
      if (e.v) {
        results.push({ name: e.k, key: e.k, value: e.v });
      } else {
        needFetch.push(e);
      }
    }

    if (needFetch.length === 0) return results;

    // Legacy/trimmed entries with empty v — fetch in bounded batches.
    // The previous implementation only fetched the first batch and silently
    // dropped the rest, which undercounted large prefixes like agent:.
    const BATCH_LIMIT = 30;
    let dirty = false;

    for (let offset = 0; offset < needFetch.length; offset += BATCH_LIMIT) {
      const batch = needFetch.slice(offset, offset + BATCH_LIMIT);
      const fetched = await Promise.all(batch.map(async (e) => {
        try {
          const res = await fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k(e.k))}`, { headers: this.h });
          if (!res.ok) return null;
          const data = await res.json() as { value?: string | null; found?: boolean };
          if (!data.found || data.value == null) return null;
          return { key: e.k, value: data.value };
        } catch { return null; }
      }));

      for (const r of fetched) {
        if (!r) continue;
        results.push({ name: r.key, key: r.key, value: r.value });
        const idx = all.findIndex(e => e.k === r.key);
        if (idx >= 0) { all[idx].v = r.value; dirty = true; }
      }
    }

    // Self-healing: persist backfilled values so next call has them inline
    if (dirty) {
      await this._idxSave(all);
    }

    return results;
  }

  // --- index helpers ---

  /**
   * Load all index sources (split + legacy) and merge.
   * Keeps the richest version of each entry (prefers non-empty v).
   * Cost: 3 HTTP calls if cold, 0 if warm (30s TTL cache).
   */
  private async _idxLoad(): Promise<IdxEntry[]> {
    const hit = _cache.get(this.ns);
    if (hit && Date.now() < hit.expires) return hit.entries;

    // Load all three index keys in parallel: split main, split large, legacy
    const [mainRes, largeRes, legacyRes] = await Promise.all([
      fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k("_idx:main"))}`, { headers: this.h }),
      fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k("_idx:large"))}`, { headers: this.h }),
      fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k("_idx"))}`, { headers: this.h }),
    ]);

    const mainEntries = await this._parseIdxResponse(mainRes);
    const largeEntries = await this._parseIdxResponse(largeRes);
    const legacyEntries = await this._parseIdxResponse(legacyRes);

    // Merge all sources — prefer entries with non-empty values
    const byKey = new Map<string, IdxEntry>();
    for (const e of legacyEntries) {
      byKey.set(e.k, e);
    }
    for (const e of [...mainEntries, ...largeEntries]) {
      const existing = byKey.get(e.k);
      if (!existing || (e.v && !existing.v)) {
        byKey.set(e.k, e);
      }
    }

    const entries = Array.from(byKey.values());
    _cache.set(this.ns, { entries, expires: Date.now() + IDX_TTL_MS });
    return entries;
  }

  private async _parseIdxResponse(res: Response): Promise<IdxEntry[]> {
    if (!res.ok) return [];
    const data = await res.json() as { value?: string | null; found?: boolean };
    if (!data.found || !data.value) return [];
    const raw = safeJson(data.value) as unknown[];
    if (!Array.isArray(raw) || raw.length === 0) return [];

    // Handle old string[] format
    if (typeof raw[0] === "string") {
      return (raw as string[]).map(k => ({ k, v: "" }));
    }
    return raw as IdxEntry[];
  }

  /**
   * Save entries split across sub-indexes by value size.
   * Small values go to _idx:main, large values go to _idx:large.
   * If a sub-index exceeds MAX_IDX_BYTES, excess entries store v: ""
   * (their values are still in individual qdkv keys as backup).
   */
  private async _idxSave(entries: IdxEntry[]): Promise<void> {
    const mainEntries: IdxEntry[] = [];
    const largeEntries: IdxEntry[] = [];

    for (const e of entries) {
      if (e.v.length >= LARGE_THRESHOLD) {
        largeEntries.push(e);
      } else {
        mainEntries.push(e);
      }
    }

    // Enforce size limits — trim values to empty if over budget
    const trimToSize = (arr: IdxEntry[]): IdxEntry[] => {
      let size = 0;
      const result: IdxEntry[] = [];
      for (const e of arr) {
        const entrySize = e.k.length + e.v.length + 20; // JSON overhead
        if (size + entrySize > MAX_IDX_BYTES) {
          result.push({ k: e.k, v: "" }); // keep key, drop value
        } else {
          result.push(e);
          size += entrySize;
        }
      }
      return result;
    };

    const trimmedMain = trimToSize(mainEntries);
    const trimmedLarge = trimToSize(largeEntries);

    await Promise.all([
      fetch(`${BASE}/qdkv/set`, {
        method: "POST",
        headers: this.h,
        body: JSON.stringify({ key: this.k("_idx:main"), value: JSON.stringify(trimmedMain) }),
      }),
      fetch(`${BASE}/qdkv/set`, {
        method: "POST",
        headers: this.h,
        body: JSON.stringify({ key: this.k("_idx:large"), value: JSON.stringify(trimmedLarge) }),
      }),
    ]);

    // In-memory cache keeps full values (no trimming) for current request
    _cache.set(this.ns, { entries, expires: Date.now() + IDX_TTL_MS });
  }

  /**
   * Upsert a key+value into the index. Value is stored inline.
   */
  private async _idxUpsert(key: string, value: string): Promise<void> {
    const entries = await this._idxLoad();
    const i = entries.findIndex(e => e.k === key);
    if (i >= 0) {
      entries[i].v = value;
    } else {
      entries.push({ k: key, v: value });
    }
    await this._idxSave(entries);
  }

  /**
   * Delete the split sub-indexes so the next _idxLoad falls back to the
   * legacy _idx key. Used once to recover from a botched migration.
   */
  async resetSplitIndex(): Promise<void> {
    await Promise.all([
      fetch(`${BASE}/qdkv/del/${encodeURIComponent(this.k("_idx:main"))}`, { method: "DELETE", headers: this.h }),
      fetch(`${BASE}/qdkv/del/${encodeURIComponent(this.k("_idx:large"))}`, { method: "DELETE", headers: this.h }),
    ]);
    _cache.delete(this.ns);
  }

  private async _idxRemove(key: string): Promise<void> {
    const entries = await this._idxLoad();
    const updated = entries.filter(e => e.k !== key);
    if (updated.length === entries.length) return;
    await this._idxSave(updated);
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

type KVEnv = {
  DATABASE_URL?: string;
  EMERGENTDB_API_KEY?: string;
  ENVIRONMENT?: string;
};

export function skillsKV(env: KVEnv): PgKV | EdbKV {
  const ns = env.ENVIRONMENT === "staging" ? "staging-skills-v2" : "skills";
  if (env.DATABASE_URL?.trim()) {
    return new PgKV(env.DATABASE_URL, ns);
  }
  if (!env.EMERGENTDB_API_KEY?.trim()) {
    throw new Error("EMERGENTDB_API_KEY is required when DATABASE_URL is unset");
  }
  return new EdbKV(env.EMERGENTDB_API_KEY, ns);
}

export function statsKV(env: KVEnv): PgKV | EdbKV {
  const ns = env.ENVIRONMENT === "staging" ? "staging-stats" : "stats";
  if (env.DATABASE_URL?.trim()) {
    return new PgKV(env.DATABASE_URL, ns);
  }
  if (!env.EMERGENTDB_API_KEY?.trim()) {
    throw new Error("EMERGENTDB_API_KEY is required when DATABASE_URL is unset");
  }
  return new EdbKV(env.EMERGENTDB_API_KEY, ns);
}
