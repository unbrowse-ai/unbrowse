
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

/**
 * BUG-011 default per-value size cap. EmergentDB silently truncates oversize
 * values, so EdbKV.put/putBatch refuse anything beyond this many bytes (UTF-8).
 * Override via the EMERGENTDB_MAX_VALUE_BYTES env var or the EdbKV constructor.
 */
const DEFAULT_MAX_VALUE_BYTES = 10_240;

function readMaxValueBytes(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  // Read from process.env so Worker bindings (set via wrangler vars) and
  // node-test runners both see the same knob.
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.EMERGENTDB_MAX_VALUE_BYTES;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_VALUE_BYTES;
}

interface IdxEntry { k: string; v: string }
interface ListResult { keys: { name: string }[]; list_complete: boolean; cursor?: string }
interface ValuedEntry { name: string; key: string; value: string }

// Per-namespace merged index cache — lives for the lifetime of the Worker isolate
const _cache = new Map<string, { entries: IdxEntry[]; expires: number }>();
const _localStores = new Map<string, Map<string, string>>();

export function clearKVCacheForTests(namespace?: string): void {
  if (namespace) {
    _cache.delete(namespace);
    _localStores.delete(namespace);
    return;
  }
  _cache.clear();
  _localStores.clear();
}

export class EdbKV {
  private h: Record<string, string>;
  private ns: string;
  private maxValueBytes: number;

  constructor(apiKey: string, namespace: string, opts?: { maxValueBytes?: number }) {
    this.h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    this.ns = namespace;
    this.maxValueBytes = readMaxValueBytes(opts?.maxValueBytes);
  }

  private k(key: string): string { return `${this.ns}:${key}`; }

  /**
   * BUG-011 (contract 311771e1): qdkv/set returns {ok:true} even when the value
   * exceeds EmergentDB's storage limit — the data is silently truncated/lost.
   * Pre-check the byte length so the write fails LOUDLY at the caller instead
   * of leaving an empty row behind. Threshold is configurable via the
   * EMERGENTDB_MAX_VALUE_BYTES env var (default 10240 = 10 KB), matching the
   * empirical limit observed in the bug investigation.
   */
  private assertWithinSizeLimit(key: string, value: string): void {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > this.maxValueBytes) {
      throw new Error(`value_too_large: ${bytes} bytes exceeds ${this.maxValueBytes} (key=${key})`);
    }
  }

  // --- public API ---

  /** Cache-first: 2 HTTP if cold (both sub-indexes), 0 for subsequent gets. Falls back to direct qdkv/get for keys not in the idx. */
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
    // BUG-011: refuse oversize writes before they silently truncate.
    // Index buckets (_idx*) are managed by _idxSave with its own overflow
    // protection, so allow them to bypass the gate.
    if (!key.startsWith("_idx")) {
      this.assertWithinSizeLimit(key, value);
    }
    const body: Record<string, unknown> = { key: this.k(key), value };
    if (opts?.expirationTtl) body.ttlMs = opts.expirationTtl * 1000;
    const res = await fetch(`${BASE}/qdkv/set`, { method: "POST", headers: this.h, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`qdkv set failed: ${res.status} ${text.slice(0, 300)}`);
    }
    if (!opts?.expirationTtl && !key.startsWith("_idx")) {
      await this._idxUpsert(key, value);
      return;
    }
    // TTL'd writes don't go into the persistent index, but if a previous get()
    // backfilled the in-memory cache with a stale value for this key, the next
    // get() in the same isolate would return that stale value. Keep the cache
    // honest so short-TTL flows (magic-link verify -> poll) read fresh.
    if (!key.startsWith("_idx")) {
      const cached = _cache.get(this.ns);
      if (cached) {
        const i = cached.entries.findIndex(e => e.k === key);
        if (i >= 0) cached.entries[i].v = value;
        else cached.entries.push({ k: key, v: value });
      }
    }
  }

  /** N parallel data writes + 1 idx load + 1 idx save. Values inline so listWithValues stays zero-fetch. */
  async putBatch(pairs: Array<{ key: string; value: string }>, opts?: { expirationTtl?: number }): Promise<void> {
    // BUG-011: same pre-write size gate as put().
    for (const { key, value } of pairs) {
      if (!key.startsWith("_idx")) this.assertWithinSizeLimit(key, value);
    }
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
      // ONE mget per batch instead of BATCH_LIMIT parallel single-gets — fewer
      // round-trips, fewer subrequests, and ~2.4x faster per the qdkv/mget witness.
      const vals = await this._mget(batch.map(e => this.k(e.k)));
      for (const e of batch) {
        const value = vals[this.k(e.k)];
        if (value == null) continue;
        results.push({ name: e.k, key: e.k, value });
        const idx = all.findIndex(x => x.k === e.k);
        if (idx >= 0) { all[idx].v = value; dirty = true; }
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

    // Load all three index keys in ONE mget (1 subrequest instead of 3; latency
    // ~= 3 parallel gets at this small N): split main, split large, legacy.
    const mainK = this.k("_idx:main"), largeK = this.k("_idx:large"), legacyK = this.k("_idx");
    const vals = await this._mget([mainK, largeK, legacyK]);
    const mainEntries = this._parseIdxValue(vals[mainK]);
    const largeEntries = this._parseIdxValue(vals[largeK]);
    const legacyEntries = this._parseIdxValue(vals[legacyK]);

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
    if (!data.found) return [];
    return this._parseIdxValue(data.value);
  }

  /** Parse a raw index value string (shared by qdkv/get and qdkv/mget paths). */
  private _parseIdxValue(value: string | null | undefined): IdxEntry[] {
    if (!value) return [];
    const raw = safeJson(value) as unknown[];
    if (!Array.isArray(raw) || raw.length === 0) return [];
    // Handle old string[] format
    if (typeof raw[0] === "string") {
      return (raw as string[]).map(k => ({ k, v: "" }));
    }
    return raw as IdxEntry[];
  }

  /**
   * Batch get via qdkv/mget — ONE HTTP for N keys, returning a fullKey -> value|null
   * map ({} on transport error; callers treat as all-miss). Two wins, both measured:
   *  - subrequests: N -> 1 (Cloudflare Workers cap at 50/request) — always.
   *  - latency: ~equal to N parallel gets at small N (fetch keep-alive overlaps them,
   *    so the idx load's 3 keys see little change) but a real ~3.4x win at large N
   *    (30 keys: 819ms of parallel gets saturating the connection pool vs 240ms for
   *    one server-side mget) — the listWithValues batch path.
   */
  private async _mget(fullKeys: string[]): Promise<Record<string, string | null>> {
    if (fullKeys.length === 0) return {};
    const res = await fetch(`${BASE}/qdkv/mget`, {
      method: "POST", headers: this.h, body: JSON.stringify({ keys: fullKeys }),
    });
    if (!res.ok) return {};
    const data = await res.json() as { values?: Record<string, string | null> };
    return data.values ?? {};
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

export class LocalKV {
  private store: Map<string, string>;

  constructor(namespace: string) {
    let store = _localStores.get(namespace);
    if (!store) {
      store = new Map();
      _localStores.set(namespace, store);
    }
    this.store = store;
  }

  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    const value = this.store.get(key) ?? null;
    if (value == null) return null;
    return type === "json" ? safeJson(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async putBatch(pairs: Array<{ key: string; value: string }>): Promise<void> {
    for (const { key, value } of pairs) this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<ListResult> {
    const keys = Array.from(this.store.keys()).filter((key) => key.startsWith(opts.prefix));
    const limit = opts.limit ?? 1000;
    const offset = opts.cursor ? parseInt(opts.cursor, 10) : 0;
    const page = keys.slice(offset, offset + limit);
    const done = offset + limit >= keys.length;
    return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(offset + limit) };
  }

  async listWithValues(prefix: string): Promise<ValuedEntry[]> {
    return Array.from(this.store.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ name: key, key, value }));
  }

  async resetSplitIndex(): Promise<void> {
    this.store.delete("_idx");
    this.store.delete("_idx:main");
    this.store.delete("_idx:large");
  }
}

/**
 * FallbackKV — the paper's `kv-fallback-pipe` made operational: EmergentDB (the
 * primary IQ store) with Cloudflare KV as a durable fallback, so a flaky or down
 * EmergentDB still serves reads and accepts writes. The worker runs ON Cloudflare,
 * so STATS_KV is always reachable even when the EmergentDB HTTP API is degraded.
 *
 *  - put: write-through to BOTH stores. Succeeds if EITHER accepts it; only a
 *    double failure throws. So an EmergentDB outage degrades to "CF KV only" — the
 *    write is not lost — and CF KV stays populated so reads can fall back.
 *  - get: EmergentDB first; on a miss OR an error, fall through to CF KV.
 *  - list/listWithValues: EmergentDB first; on error, CF KV (prefix-scoped).
 *
 * Keys are namespace-prefixed in CF KV (`<ns>:<key>`) so skills + stats share one
 * Cloudflare namespace without colliding — the same prefixing EdbKV uses.
 */
export class FallbackKV {
  constructor(private primary: EdbKV, private cf: KVNamespace, private ns: string) {}

  private ck(key: string): string { return `${this.ns}:${key}`; }
  private strip(name: string): string {
    return name.startsWith(`${this.ns}:`) ? name.slice(this.ns.length + 1) : name;
  }
  /** CF KV requires expirationTtl >= 60s; clamp so a short TTL doesn't reject the mirror. */
  private cfOpts(opts?: { expirationTtl?: number }): { expirationTtl: number } | undefined {
    return opts?.expirationTtl ? { expirationTtl: Math.max(60, opts.expirationTtl) } : undefined;
  }

  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    try {
      const v = await this.primary.get(key, type);
      if (v != null) return v;
    } catch { /* EmergentDB down — fall through to CF KV */ }
    const raw = await this.cf.get(this.ck(key)).catch(() => null);
    if (raw == null) return null;
    return type === "json" ? safeJson(raw) : raw;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const [p, c] = await Promise.allSettled([
      this.primary.put(key, value, opts),
      this.cf.put(this.ck(key), value, this.cfOpts(opts)),
    ]);
    if (p.status === "rejected" && c.status === "rejected") {
      throw new Error(`FallbackKV.put failed both stores (key=${key})`);
    }
  }

  async putBatch(pairs: Array<{ key: string; value: string }>, opts?: { expirationTtl?: number }): Promise<void> {
    const cfOpts = this.cfOpts(opts);
    await Promise.allSettled([
      this.primary.putBatch(pairs, opts),
      ...pairs.map(({ key, value }) => this.cf.put(this.ck(key), value, cfOpts)),
    ]);
  }

  async delete(key: string): Promise<void> {
    await Promise.allSettled([this.primary.delete(key), this.cf.delete(this.ck(key))]);
  }

  async list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<ListResult> {
    try {
      return await this.primary.list(opts);
    } catch {
      const res = await this.cf.list({ prefix: this.ck(opts.prefix), limit: opts.limit, cursor: opts.cursor });
      return {
        keys: res.keys.map((k) => ({ name: this.strip(k.name) })),
        list_complete: res.list_complete,
        cursor: res.list_complete ? undefined : (res as { cursor?: string }).cursor,
      };
    }
  }

  async listWithValues(prefix: string): Promise<ValuedEntry[]> {
    try {
      return await this.primary.listWithValues(prefix);
    } catch {
      const res = await this.cf.list({ prefix: this.ck(prefix) });
      const out: ValuedEntry[] = [];
      for (const k of res.keys) {
        const raw = await this.cf.get(k.name).catch(() => null);
        const name = this.strip(k.name);
        out.push({ name, key: name, value: raw ?? "" });
      }
      return out;
    }
  }

  async resetSplitIndex(): Promise<void> {
    await this.primary.resetSplitIndex().catch(() => {});
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

type KVEnv = {
  EMERGENTDB_API_KEY?: string;
  /** BUG-011: override the per-value byte cap. Read by EdbKV.put / putBatch. */
  EMERGENTDB_MAX_VALUE_BYTES?: string;
  ENVIRONMENT?: string;
  /** Cloudflare KV durable fallback (kv-fallback-pipe). When bound, EdbKV is
   *  wrapped in FallbackKV so a degraded EmergentDB still serves. */
  STATS_KV?: KVNamespace;
};

function readEnvMaxBytes(env: KVEnv): number | undefined {
  const raw = env.EMERGENTDB_MAX_VALUE_BYTES;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Storage is IQ-only: EdbKV (EmergentDB) primary, wrapped in FallbackKV over
// Cloudflare KV (STATS_KV) when bound so a degraded EmergentDB still serves;
// LocalKV under local-dev. Legacy Postgres/PgKV removed in the Neon->IQ migration.
function wrap(env: KVEnv, edb: EdbKV, ns: string): EdbKV | FallbackKV {
  return env.STATS_KV ? new FallbackKV(edb, env.STATS_KV, ns) : edb;
}

export function skillsKV(env: KVEnv): EdbKV | LocalKV | FallbackKV {
  const ns = env.ENVIRONMENT === "gate-staging" ? "gate-staging-skills-v3" : env.ENVIRONMENT === "staging" ? "staging-skills-v3" : "skills-v2";
  if (env.ENVIRONMENT === "local-dev") {
    return new LocalKV(ns);
  }
  if (!env.EMERGENTDB_API_KEY?.trim()) {
    throw new Error("EMERGENTDB_API_KEY is required");
  }
  return wrap(env, new EdbKV(env.EMERGENTDB_API_KEY, ns, { maxValueBytes: readEnvMaxBytes(env) }), ns);
}

export function statsKV(env: KVEnv): EdbKV | LocalKV | FallbackKV {
  const ns = env.ENVIRONMENT === "gate-staging" ? "gate-staging-stats" : env.ENVIRONMENT === "staging" ? "staging-stats" : "stats";
  if (env.ENVIRONMENT === "local-dev") {
    return new LocalKV(ns);
  }
  if (!env.EMERGENTDB_API_KEY?.trim()) {
    throw new Error("EMERGENTDB_API_KEY is required");
  }
  return wrap(env, new EdbKV(env.EMERGENTDB_API_KEY, ns, { maxValueBytes: readEnvMaxBytes(env) }), ns);
}

export function kvBackend(env: KVEnv): "emergentdb" | "unconfigured" {
  if (env.EMERGENTDB_API_KEY?.trim()) return "emergentdb";
  return "unconfigured";
}
