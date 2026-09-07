#!/usr/bin/env node
//
// Reverse of migrate-cf-kv-to-neon.mjs: streams every app_kv row out of
// Neon Postgres and into EmergentDB qdkv. Idempotent (qdkv/set is upsert).
// Safe to re-run; partial-run resumes from wherever it left off.
//
// Usage:
//   DATABASE_URL=postgres://...  \
//   EMERGENTDB_API_KEY=emdb__... \
//   node backend/scripts/migrate-neon-to-edb.mjs
//
// Optional:
//   NAMESPACE=skills-v2          # migrate only one namespace
//   CONCURRENCY=24               # parallel qdkv writes (default 12)
//   DRY_RUN=1                    # count rows, do not write
//

import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
const EMERGENTDB_API_KEY = process.env.EMERGENTDB_API_KEY;
const NAMESPACE_FILTER = process.env.NAMESPACE?.trim();
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.CONCURRENCY ?? "12", 10));
const DRY_RUN = /^(1|true)$/i.test(process.env.DRY_RUN ?? "");

if (!DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
if (!EMERGENTDB_API_KEY) {
  console.error("EMERGENTDB_API_KEY required");
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const EDB = "https://api.emergentdb.com";
const H = { Authorization: `Bearer ${EMERGENTDB_API_KEY}`, "Content-Type": "application/json" };

async function listNamespaces() {
  const rows = await sql`SELECT namespace, COUNT(*)::int AS n FROM app_kv GROUP BY namespace ORDER BY namespace`;
  return rows;
}

async function* pageRows(namespace, pageSize = 500) {
  let offset = 0;
  for (;;) {
    const rows = await sql`
      SELECT key, value
      FROM app_kv
      WHERE namespace = ${namespace}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY key
      LIMIT ${pageSize}
      OFFSET ${offset}
    `;
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < pageSize) return;
    offset += rows.length;
  }
}

async function pool(items, worker, concurrency) {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(batch.map(worker));
  }
}

async function qdkvSet(namespace, key, value) {
  const body = JSON.stringify({ key: `${namespace}:${key}`, value });
  const res = await fetch(`${EDB}/qdkv/set`, { method: "POST", headers: H, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`qdkv set failed (${namespace}:${key}): ${res.status} ${text.slice(0, 200)}`);
  }
}

async function nudgeIdx(namespace) {
  // After bulk writes, write a no-op key so the next EdbKV._idxLoad sees a
  // fresh idx (the in-Worker cache TTL is 30s; the persistent idx is rebuilt
  // by EdbKV itself on the next put). This is best-effort.
  const empty = JSON.stringify([]);
  await fetch(`${EDB}/qdkv/set`, {
    method: "POST", headers: H,
    body: JSON.stringify({ key: `${namespace}:_idx:nudge`, value: empty }),
  }).catch(() => {});
}

async function migrateNamespace(namespace, rowCount) {
  console.log(`[${namespace}] expected ${rowCount} rows`);
  let written = 0;
  let failed = 0;
  for await (const page of pageRows(namespace)) {
    await pool(page, async (row) => {
      try {
        if (!DRY_RUN) await qdkvSet(namespace, row.key, row.value);
        written++;
      } catch (err) {
        failed++;
        if (failed <= 5) console.error(`  fail: ${err.message}`);
      }
    }, CONCURRENCY);
    console.log(`[${namespace}] ${written}/${rowCount}  fail=${failed}`);
  }
  if (!DRY_RUN) await nudgeIdx(namespace);
  console.log(`[${namespace}] done. written=${written} failed=${failed}`);
}

const all = await listNamespaces();
console.log(`namespaces present in Neon app_kv:`);
for (const row of all) console.log(`  ${row.namespace}  rows=${row.n}`);
const targets = NAMESPACE_FILTER
  ? all.filter((row) => row.namespace === NAMESPACE_FILTER)
  : all;
if (targets.length === 0) {
  console.error(`no namespaces to migrate (filter=${NAMESPACE_FILTER ?? "<none>"})`);
  process.exit(1);
}
for (const row of targets) {
  await migrateNamespace(row.namespace, row.n);
}
console.log(DRY_RUN ? "DRY_RUN complete (no writes)" : "neon -> emergentdb migration complete");
