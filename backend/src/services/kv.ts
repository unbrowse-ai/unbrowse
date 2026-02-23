/**
 * EmergentDB qdkv adapter — drop-in replacement for Cloudflare KV.
 *
 * Subrequest budget (CF Workers limit: 50/request):
 * - `get()` always goes through `_idxLoad()` first (1 HTTP if cold, 0 if warm).
 *   After the first load, all reads in the same request are free.
 * - `putBatch()` coalesces N data writes + 1 idx save into N+2 subrequests.
 *   Use this instead of Promise.all([put(), put()]) in hot paths.
 * - Migration from old string[] idx format: convert in-place without N+1 fetches.
 */

const BASE = "https://api.emergentdb.com";
const IDX_TTL_MS = 30_000;

interface IdxEntry { k: string; v: string }
interface ListResult { keys: { name: string }[]; list_complete: boolean; cursor?: string }
interface ValuedEntry { name: string; value: string }

// Per-namespace index cache — lives for the lifetime of the Worker isolate
const _cache = new Map<string, { entries: IdxEntry[]; expires: number }>();

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
   * Cost: 1 HTTP subrequest if cache is cold (idx load), then 0 for subsequent gets.
   * Falls back to a direct qdkv/get only for keys not present in the idx
   * (TTL keys, search-cache entries, or newly-published skills before next idx load).
   */
  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    const entries = await this._idxLoad();
    const hit = entries.find(e => e.k === key);
    if (hit && hit.v) {
      return type === "json" ? safeJson(hit.v) : hit.v;
    }

    // Not in idx — direct fetch (TTL keys, migrated entries with empty v, etc.)
    const res = await fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k(key))}`, { headers: this.h });
    if (!res.ok) return null;
    const data = await res.json() as { value?: string | null; found?: boolean };
    if (!data.found || data.value == null) return null;
    const val = data.value;

    // Backfill cache so subsequent gets in this request are free
    const cached = _cache.get(this.ns);
    if (cached) {
      const i = cached.entries.findIndex(e => e.k === key);
      if (i >= 0) cached.entries[i].v = val;
    }
    return type === "json" ? safeJson(val) : val;
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
   * Prefer this over Promise.all([put(), put()]) in hot paths to halve subrequest
   * count and avoid idx write-after-write races.
   */
  async putBatch(pairs: Array<{ key: string; value: string }>, opts?: { expirationTtl?: number }): Promise<void> {
    const ttl = opts?.expirationTtl;
    await Promise.all(pairs.map(({ key, value }) => {
      const body: Record<string, unknown> = { key: this.k(key), value };
      if (ttl) body.ttlMs = ttl * 1000;
      return fetch(`${BASE}/qdkv/set`, { method: "POST", headers: this.h, body: JSON.stringify(body) });
    }));
    if (!ttl) {
      const toIndex = pairs.filter(({ key }) => !key.startsWith("_idx"));
      if (toIndex.length > 0) {
        const entries = await this._idxLoad();
        for (const { key, value } of toIndex) {
          const i = entries.findIndex(e => e.k === key);
          if (i >= 0) entries[i].v = value;
          else entries.push({ k: key, v: value });
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

  async listWithValues(prefix: string): Promise<ValuedEntry[]> {
    const all = await this._idxLoad();
    return all.filter(e => e.k.startsWith(prefix) && e.v).map(e => ({ name: e.k, value: e.v }));
  }

  // --- index helpers ---

  private async _idxLoad(): Promise<IdxEntry[]> {
    const hit = _cache.get(this.ns);
    if (hit && Date.now() < hit.expires) return hit.entries;

    const res = await fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k("_idx"))}`, { headers: this.h });
    if (!res.ok) return [];
    const data = await res.json() as { value?: string | null; found?: boolean };
    if (!data.found || !data.value) return [];
    const raw = safeJson(data.value) as unknown[];
    if (!Array.isArray(raw) || raw.length === 0) return [];

    let entries: IdxEntry[];
    if (typeof raw[0] === "string") {
      // Migrate old string[] → {k, v: ""}[] without N+1 HTTP fetches.
      // Values will be fetched on demand by get() if needed.
      // Persist the converted format so this branch runs only once.
      entries = (raw as string[]).map(k => ({ k, v: "" }));
      this._idxSave(entries).catch(() => {});
    } else {
      entries = raw as IdxEntry[];
    }

    _cache.set(this.ns, { entries, expires: Date.now() + IDX_TTL_MS });
    return entries;
  }

  private async _idxSave(entries: IdxEntry[]): Promise<void> {
    await fetch(`${BASE}/qdkv/set`, {
      method: "POST",
      headers: this.h,
      body: JSON.stringify({ key: this.k("_idx"), value: JSON.stringify(entries) }),
    });
    _cache.set(this.ns, { entries, expires: Date.now() + IDX_TTL_MS });
  }

  private async _idxUpsert(key: string, value: string): Promise<void> {
    const entries = await this._idxLoad();
    const i = entries.findIndex(e => e.k === key);
    if (i >= 0) entries[i].v = value;
    else entries.push({ k: key, v: value });
    await this._idxSave(entries);
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

export function skillsKV(env: { EMERGENTDB_API_KEY: string }): EdbKV {
  return new EdbKV(env.EMERGENTDB_API_KEY, "skills");
}

export function statsKV(env: { EMERGENTDB_API_KEY: string }): EdbKV {
  return new EdbKV(env.EMERGENTDB_API_KEY, "stats");
}
