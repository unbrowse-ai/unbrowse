import { neon } from "@neondatabase/serverless";

const clientCache = new Map<string, any>();
const initCache = new Map<string, Promise<void>>();

function getClient(databaseUrl: string): any {
  const cached = clientCache.get(databaseUrl);
  if (cached) return cached;
  const client = neon(databaseUrl);
  clientCache.set(databaseUrl, client);
  return client;
}

async function initialize(databaseUrl: string): Promise<void> {
  const sql = getClient(databaseUrl);
  await sql`
    CREATE TABLE IF NOT EXISTS app_kv (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (namespace, key)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS app_kv_namespace_key_idx
    ON app_kv (namespace, key)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS app_kv_expires_at_idx
    ON app_kv (expires_at)
  `;
}

export async function getNeonClient(databaseUrl: string): Promise<any> {
  const trimmed = databaseUrl.trim();
  if (!trimmed) {
    throw new Error("DATABASE_URL is required");
  }

  let init = initCache.get(trimmed);
  if (!init) {
    init = initialize(trimmed);
    initCache.set(trimmed, init);
  }
  await init;
  return getClient(trimmed);
}
