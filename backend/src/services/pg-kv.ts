import { getNeonClient } from "./neon.js";

interface ListResult {
  keys: { name: string }[];
  list_complete: boolean;
  cursor?: string;
}

interface ValuedEntry {
  name: string;
  value: string;
}

export class PgKV {
  constructor(
    private readonly databaseUrl: string,
    private readonly namespace: string,
  ) {}

  private async sql() {
    return await getNeonClient(this.databaseUrl);
  }

  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    const sql = await this.sql();
    const rows = await sql`
      SELECT value
      FROM app_kv
      WHERE namespace = ${this.namespace}
        AND key = ${key}
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    ` as Array<{ value: string }>;
    const raw = rows[0]?.value ?? null;
    if (raw == null) return null;
    return type === "json" ? safeJson(raw) : raw;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const sql = await this.sql();
    const expiresAt = opts?.expirationTtl
      ? new Date(Date.now() + opts.expirationTtl * 1000).toISOString()
      : null;
    await sql`
      INSERT INTO app_kv (namespace, key, value, expires_at)
      VALUES (${this.namespace}, ${key}, ${value}, ${expiresAt})
      ON CONFLICT (namespace, key)
      DO UPDATE SET
        value = EXCLUDED.value,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `;
  }

  async putBatch(pairs: Array<{ key: string; value: string }>, opts?: { expirationTtl?: number }): Promise<void> {
    if (pairs.length === 0) return;
    const sql = await this.sql();
    const expiresAt = opts?.expirationTtl
      ? new Date(Date.now() + opts.expirationTtl * 1000).toISOString()
      : null;
    await sql.transaction(
      pairs.map((pair) => sql`
        INSERT INTO app_kv (namespace, key, value, expires_at)
        VALUES (${this.namespace}, ${pair.key}, ${pair.value}, ${expiresAt})
        ON CONFLICT (namespace, key)
        DO UPDATE SET
          value = EXCLUDED.value,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
      `),
    );
  }

  async delete(key: string): Promise<void> {
    const sql = await this.sql();
    await sql`
      DELETE FROM app_kv
      WHERE namespace = ${this.namespace}
        AND key = ${key}
    `;
  }

  async list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<ListResult> {
    const sql = await this.sql();
    const limit = opts.limit ?? 1000;
    const offset = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const rows = await sql`
      SELECT key
      FROM app_kv
      WHERE namespace = ${this.namespace}
        AND key LIKE ${opts.prefix + "%"}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY key
      LIMIT ${limit}
      OFFSET ${Number.isFinite(offset) ? offset : 0}
    ` as Array<{ key: string }>;
    const nextOffset = (Number.isFinite(offset) ? offset : 0) + rows.length;
    return {
      keys: rows.map((row) => ({ name: row.key })),
      list_complete: rows.length < limit,
      cursor: rows.length < limit ? undefined : String(nextOffset),
    };
  }

  async listWithValues(prefix: string): Promise<ValuedEntry[]> {
    const sql = await this.sql();
    const rows = await sql`
      SELECT key, value
      FROM app_kv
      WHERE namespace = ${this.namespace}
        AND key LIKE ${prefix + "%"}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY key
    ` as Array<{ key: string; value: string }>;
    return rows.map((row) => ({ name: row.key, value: row.value }));
  }

  async resetSplitIndex(): Promise<void> {
    return;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
