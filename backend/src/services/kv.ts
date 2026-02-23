/**
 * EmergentDB qdkv adapter — drop-in replacement for Cloudflare KV.
 *
 * list() is emulated via a per-namespace `_idx` key that stores all
 * non-ephemeral keys as a JSON array. TTL keys (rate-limit) are never
 * added to the index.
 */

const BASE = "https://api.emergentdb.com";

interface ListResult {
  keys: { name: string }[];
  list_complete: boolean;
  cursor?: string;
}

export class EdbKV {
  private h: Record<string, string>;
  private ns: string;

  constructor(apiKey: string, namespace: string) {
    this.h = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    this.ns = namespace;
  }

  /** Namespace-scoped key */
  private k(key: string): string {
    return `${this.ns}:${key}`;
  }

  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    const res = await fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k(key))}`, {
      headers: this.h,
    });
    if (!res.ok) return null;
    const data = await res.json() as { value?: string | null; found?: boolean };
    if (!data.found || data.value == null) return null;
    if (type === "json") {
      try { return JSON.parse(data.value); } catch { return null; }
    }
    return data.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const body: Record<string, unknown> = { key: this.k(key), value };
    if (opts?.expirationTtl) body.ttlMs = opts.expirationTtl * 1000;
    await fetch(`${BASE}/qdkv/set`, {
      method: "POST",
      headers: this.h,
      body: JSON.stringify(body),
    });
    // Don't index ephemeral (TTL) or internal index keys
    if (!opts?.expirationTtl && !key.startsWith("_idx")) {
      await this._idxAdd(key);
    }
  }

  async delete(key: string): Promise<void> {
    await fetch(`${BASE}/qdkv/del/${encodeURIComponent(this.k(key))}`, {
      method: "DELETE",
      headers: this.h,
    });
    await this._idxRemove(key);
  }

  async list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<ListResult> {
    const all = await this._idxGet();
    const filtered = all.filter((k) => k.startsWith(opts.prefix));
    const limit = opts.limit ?? 1000;
    const offset = opts.cursor ? parseInt(opts.cursor, 10) : 0;
    const page = filtered.slice(offset, offset + limit);
    const done = offset + limit >= filtered.length;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: done,
      cursor: done ? undefined : String(offset + limit),
    };
  }

  // --- index helpers ---

  private async _idxGet(): Promise<string[]> {
    const res = await fetch(`${BASE}/qdkv/get/${encodeURIComponent(this.k("_idx"))}`, {
      headers: this.h,
    });
    if (!res.ok) return [];
    const data = await res.json() as { value?: string | null; found?: boolean };
    if (!data.found || !data.value) return [];
    try { return JSON.parse(data.value); } catch { return []; }
  }

  private async _idxAdd(key: string): Promise<void> {
    const keys = await this._idxGet();
    if (keys.includes(key)) return;
    keys.push(key);
    await fetch(`${BASE}/qdkv/set`, {
      method: "POST",
      headers: this.h,
      body: JSON.stringify({ key: this.k("_idx"), value: JSON.stringify(keys) }),
    });
  }

  private async _idxRemove(key: string): Promise<void> {
    const keys = await this._idxGet();
    const updated = keys.filter((k) => k !== key);
    if (updated.length === keys.length) return;
    await fetch(`${BASE}/qdkv/set`, {
      method: "POST",
      headers: this.h,
      body: JSON.stringify({ key: this.k("_idx"), value: JSON.stringify(updated) }),
    });
  }
}

/** Factory helpers — call once per request in each service. */
export function skillsKV(env: { EMERGENTDB_API_KEY: string }): EdbKV {
  return new EdbKV(env.EMERGENTDB_API_KEY, "skills");
}

export function statsKV(env: { EMERGENTDB_API_KEY: string }): EdbKV {
  return new EdbKV(env.EMERGENTDB_API_KEY, "stats");
}
