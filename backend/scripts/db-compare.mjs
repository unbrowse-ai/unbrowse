#!/usr/bin/env node
/**
 * db-compare.mjs — READ-ONLY diagnostic. Answers "are staging and prod the same
 * database?" without mutating anything. No INSERT/UPDATE/DELETE/DROP — SELECT only.
 *
 * Usage:
 *   STAGING_DATABASE_URL='postgres://...' PROD_DATABASE_URL='postgres://...' \
 *     node backend/scripts/db-compare.mjs
 *
 * It reports, for each side: host, database name, and per-table row counts, then
 * a same/different verdict. Use this to scope a merge BEFORE touching any data.
 */
import process from "node:process";

const STAGING = process.env.STAGING_DATABASE_URL;
const PROD = process.env.PROD_DATABASE_URL;
if (!STAGING || !PROD) {
  console.error("Set STAGING_DATABASE_URL and PROD_DATABASE_URL (read-only SELECTs only).");
  process.exit(2);
}

async function connect(url) {
  // Prefer the project's neon serverless driver; fall back to pg.
  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url);
    return { kind: "neon", q: async (text) => (await sql.query(text)).rows ?? (await sql.query(text)) };
  } catch {
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return { kind: "pg", q: async (text) => (await client.query(text)).rows, end: () => client.end() };
  }
}

async function probe(label, url) {
  const c = await connect(url);
  const id = (await c.q("select current_database() as db, inet_server_addr()::text as host, version() as v"))[0];
  const tables = await c.q(`select table_name from information_schema.tables where table_schema='public' order by table_name`);
  const counts = {};
  for (const t of tables) {
    try { counts[t.table_name] = Number((await c.q(`select count(*)::bigint as n from "${t.table_name}"`))[0].n); }
    catch (e) { counts[t.table_name] = `err:${String(e.message).slice(0, 40)}`; }
  }
  if (c.end) await c.end();
  return { label, db: id.db, host: id.host, tables: counts };
}

const [s, p] = await Promise.all([probe("staging", STAGING), probe("prod", PROD)]);
for (const r of [s, p]) {
  console.log(`\n[${r.label}] db=${r.db} host=${r.host ?? "(pooler/unknown)"}`);
  for (const [t, n] of Object.entries(r.tables)) console.log(`  ${t.padEnd(32)} ${n}`);
}
const sameTarget = s.db === p.db && s.host === p.host;
console.log(`\nVERDICT: ${sameTarget ? "SAME database/host — already one DB." : "DIFFERENT databases — a merge would move data."}`);
const onlyStaging = Object.keys(s.tables).filter((t) => !(t in p.tables));
const onlyProd = Object.keys(p.tables).filter((t) => !(t in s.tables));
if (onlyStaging.length) console.log(`  tables only in staging: ${onlyStaging.join(", ")}`);
if (onlyProd.length) console.log(`  tables only in prod:    ${onlyProd.join(", ")}`);
