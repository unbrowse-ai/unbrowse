#!/usr/bin/env node
// Reads one of the named questions in queries.sql from the deployed worker and prints its rows as a table.
//
//   node stats.mjs                 the names
//   node stats.mjs installs        active installs a day (also: calls, breaks, times, versions, gate, funnel,
//                                  funnel_by_from, arms)
//
// TELEMETRY_URL (default https://telemetry.unbrowse.ai) picks the worker. The token is ADMIN_TOKEN, or the file
// ~/.config/unbrowse/telemetry-admin-token (production) / telemetry-admin-token-staging (any other URL).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = (process.env.TELEMETRY_URL || "https://telemetry.unbrowse.ai").replace(/\/$/, "");
const file = base === "https://telemetry.unbrowse.ai" ? "telemetry-admin-token" : "telemetry-admin-token-staging";
let token = process.env.ADMIN_TOKEN;
if (!token) {
  try {
    token = readFileSync(join(homedir(), ".config/unbrowse", file), "utf8").trim();
  } catch {
    console.error(`no token: set ADMIN_TOKEN or write ~/.config/unbrowse/${file}`);
    process.exit(2);
  }
}
const name = process.argv[2] || "";
const r = await fetch(`${base}/v1/stats/${name}`, { headers: { authorization: `Bearer ${token}` } });
const body = await r.json().catch(() => ({}));
if (!r.ok) {
  console.error(`${r.status} ${body.error || ""}`.trim());
  process.exit(1);
}
if (body.names) console.log(body.names.join("\n"));
else if (!body.rows.length) console.log("(no rows)");
else console.table(body.rows);
