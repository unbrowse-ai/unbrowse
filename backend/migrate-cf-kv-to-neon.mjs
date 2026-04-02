#!/usr/bin/env node

import { execSync } from "child_process";
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const NAMESPACES = [
  { id: "dfc844e685144df485790a8933796b28", name: "skills" },
  { id: "1d315d7cda1742b785cf5d23c892c5d7", name: "stats" },
];
const NAMESPACE_FILTER = process.env.NAMESPACE?.trim();

async function ensureSchema() {
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
}

async function pool(items, worker, concurrency = 12) {
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    await Promise.all(batch.map(worker));
  }
}

function kvList(namespaceId) {
  const raw = execSync(`cd backend && bunx wrangler kv key list --namespace-id ${namespaceId}`, {
    maxBuffer: 100 * 1024 * 1024,
  }).toString();
  return JSON.parse(raw).map((entry) => entry.name);
}

function kvGet(namespaceId, key) {
  try {
    return execSync(
      `cd backend && bunx wrangler kv key get --namespace-id ${namespaceId} "${key.replace(/"/g, '\\"')}"`,
      { maxBuffer: 50 * 1024 * 1024 },
    ).toString();
  } catch {
    return null;
  }
}

async function importNamespace(namespace) {
  const keys = kvList(namespace.id);
  console.log(`importing ${namespace.name}: ${keys.length} keys`);
  let imported = 0;

  await pool(keys, async (key) => {
    const value = kvGet(namespace.id, key);
    if (value == null) return;
    await sql`
      INSERT INTO app_kv (namespace, key, value)
      VALUES (${namespace.name}, ${key}, ${value})
      ON CONFLICT (namespace, key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
    `;
    imported++;
    if (imported % 50 === 0) {
      console.log(`${namespace.name}: ${imported}/${keys.length}`);
    }
  });

  console.log(`${namespace.name}: imported ${imported}`);
}

await ensureSchema();
for (const namespace of NAMESPACES.filter((item) => !NAMESPACE_FILTER || item.name === NAMESPACE_FILTER)) {
  await importNamespace(namespace);
}
console.log("cf kv backfill -> neon complete");
