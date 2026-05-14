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
  // Telemetry tables — Phase 3 of docs/mcp-telemetry-plan.md. Co-located
  // here so cold starts bootstrap the schema without a separate migration
  // step. Re-running CREATE TABLE/INDEX IF NOT EXISTS is a no-op once
  // applied.
  await sql`
    CREATE TABLE IF NOT EXISTS telemetry_sessions (
      session_id              TEXT PRIMARY KEY,
      received_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms_total       BIGINT,
      tool_calls_total        INTEGER,
      errors_total            INTEGER,
      reflection_status       TEXT,
      events_json             JSONB NOT NULL,
      agent_kind_fingerprint  TEXT,
      mcp_version             TEXT,
      platform                TEXT,
      client_seed_fp          TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_received ON telemetry_sessions(received_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_reflection ON telemetry_sessions(reflection_status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_client_seed ON telemetry_sessions(client_seed_fp)`;
  await sql`
    CREATE TABLE IF NOT EXISTS telemetry_clusters (
      cluster_key             TEXT PRIMARY KEY,
      first_seen_at           TIMESTAMPTZ NOT NULL,
      last_seen_at            TIMESTAMPTZ NOT NULL,
      session_count           INTEGER NOT NULL DEFAULT 1,
      github_issue_url        TEXT,
      representative_sessions JSONB
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_telemetry_clusters_last_seen ON telemetry_clusters(last_seen_at DESC)`;
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
