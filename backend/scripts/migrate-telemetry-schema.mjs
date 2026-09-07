#!/usr/bin/env node
// Apply backend/schema/telemetry-sessions.sql to the Postgres database
// referenced by $DATABASE_URL. Idempotent — re-running is safe.
//
// Usage:
//   DATABASE_URL=postgres://... node backend/scripts/migrate-telemetry-schema.mjs
//
// Reads the SQL file, splits on statement boundaries, runs each via the
// neon serverless SDK. Matches the pattern used by migrate-cf-kv-to-neon.mjs.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL required (set wrangler secret value, or local DATABASE_URL=...)");
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(HERE, "..", "schema", "telemetry-sessions.sql");

const raw = await readFile(SCHEMA_FILE, "utf8");

// Strip line comments, then split on `;` outside of quotes. Schema file is
// hand-written and uses no PL/pgSQL blocks, so this is sufficient.
const stripped = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const statements = stripped
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const sql = neon(DATABASE_URL);

console.log(`[telemetry-schema] applying ${statements.length} statements to ${new URL(DATABASE_URL).host}`);
let applied = 0;
for (const stmt of statements) {
  try {
    await sql(stmt);
    applied += 1;
  } catch (err) {
    console.error(`[telemetry-schema] statement failed: ${stmt.slice(0, 120)}...`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
console.log(`[telemetry-schema] ok — ${applied} statement(s) applied`);
