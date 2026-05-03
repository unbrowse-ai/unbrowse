import { neon } from "@neondatabase/serverless";

const clientCache = new Map<string, any>();
const initCache = new Map<string, Promise<void>>();
let neonFactory = neon;
let customNeonFactory = false;

async function getClient(databaseUrl: string): Promise<any> {
  const cached = clientCache.get(databaseUrl);
  if (cached) return cached;
  const client = isNeonUrl(databaseUrl)
    ? neonFactory(databaseUrl)
    : (await import("postgres")).default(databaseUrl, { max: 5 });
  clientCache.set(databaseUrl, client);
  return client;
}

async function initialize(databaseUrl: string): Promise<void> {
  const sql = await getClient(databaseUrl);
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
    init = initialize(trimmed).catch((error) => {
      initCache.delete(trimmed);
      throw error;
    });
    initCache.set(trimmed, init);
  }
  await init;
  return getClient(trimmed);
}

export async function withPostgresTransaction<T>(
  databaseUrl: string,
  buildQueries: (sql: any) => unknown[],
): Promise<T[]> {
  const sql = await getNeonClient(databaseUrl);
  if (typeof sql.transaction === "function") {
    return await sql.transaction(buildQueries(sql));
  }
  if (typeof sql.begin === "function") {
    return await sql.begin((tx: any) => Promise.all(buildQueries(tx)));
  }
  return await Promise.all(buildQueries(sql)) as T[];
}

export function __setNeonFactoryForTests(factory: typeof neon): void {
  neonFactory = factory;
  customNeonFactory = true;
  clientCache.clear();
  initCache.clear();
}

export function __resetNeonForTests(): void {
  neonFactory = neon;
  customNeonFactory = false;
  clientCache.clear();
  initCache.clear();
}

function isNeonUrl(databaseUrl: string): boolean {
  if (customNeonFactory) return true;
  try {
    return new URL(databaseUrl).hostname.endsWith(".neon.tech");
  } catch {
    return true;
  }
}
