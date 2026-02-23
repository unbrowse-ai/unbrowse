/**
 * EmergentDB qdkv adapter — drop-in replacement for Cloudflare KV.
 *
 * The index key (`_idx`) stores `{k, v}[]` — both the key name AND its
 * value — so `listWithValues()` is a single HTTP round-trip instead of
 * 1 (list) + N (individual gets). TTL keys (rate-limit) are excluded.
 *
 * A module-level cache (30s TTL) means repeated reads within the same
 * Worker isolate never hit EmergentDB twice.
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

  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    // Serve from index cache if warm
    const cached = _cache.get(this.ns);
    if (cached && Date.now() < cached.expires) {
      const hit = cached.entries.find(e => e.k === key);
      if (hit != null) {
        return type === "json" ? safeJson(hit.v) : hit.v;
      }
    }
    const res = await fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k(key))}`, { headers: this.h });
    if (!res.ok) return null;
    const data = await res.json() as { value?: string | null; found?: boolean };
    if (!data.found || data.value == null) return null;
    return type === "json" ? safeJson(data.value) : data.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const body: Record<string, unknown> = { key: this.k(key), value };
    if (opts?.expirationTtl) body.ttlMs = opts.expirationTtl * 1000;
    await fetch(`${BASE}/qdkv/set`, { method: "POST", headers: this.h, body: JSON.stringify(body) });
    // Ephemeral (TTL) keys and internal index keys are not indexed
    if (!opts?.expirationTtl && !key.startsWith("_idx")) {
      await this._idxUpsert(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await fetch(`${BASE}/qdkv/del/${encodeURIComponent(this.k(key))}`, { method: "DELETE", headers: this.h });
    await this._idxRemove(key);
  }

  /** Returns matching keys (names only). Use listWithValues to avoid follow-up gets. */
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
   * Single round-trip list — returns keys + values from the cached index.
   * Eliminates the N follow-up get() calls that list() requires.
   */
  async listWithValues(prefix: string): Promise<ValuedEntry[]> {
    const all = await this._idxLoad();
    return all.filter(e => e.k.startsWith(prefix)).map(e => ({ name: e.k, value: e.v }));
  }

  // --- index helpers ---

  private async _idxLoad(): Promise<IdxEntry[]> {
    const hit = _cache.get(this.ns);
    if (hit && Date.now() < hit.expires) return hit.entries;

    const res = await fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k("_idx"))}`, { headers: this.h });
    if (!res.ok) return [];
    const data = await res.json() as { value?: string | null; found?: boolean };
    if (!data.found || !data.value) return [];
    const entries = safeJson(data.value) as IdxEntry[] ?? [];
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
