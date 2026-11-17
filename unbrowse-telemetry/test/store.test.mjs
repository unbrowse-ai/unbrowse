// The deployed path: events through ../src/sql.js's client to the TelemetryStore stand-in (./d1.mjs), and the stats
// door that reads queries.sql's named questions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { handle } from "../src/index.js";
import { client, namedQueries } from "../src/sql.js";
import { fakeStore } from "./d1.mjs";

const QUERIES = readFileSync(new URL("../queries.sql", import.meta.url), "utf8");
const TOKEN = "an-admin-token-of-length";
const GATE = "f".repeat(32);
const ID = "0123456789abcdef0123456789abcdef";

function store(opts) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return { db, env: { TELEMETRY_DB: client(fakeStore(db, opts)), QUERIES, ADMIN_TOKEN: TOKEN } };
}
const event = (over = {}) => ({ event: "tool_call", version: "1.4.2", os: "linux", install_id: ID, tool: "unbrowse_do", outcome: "ok", duration_ms: 90, ...over });
const post = (events) =>
  new Request("https://t/v1/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) });
const get = (name, token = TOKEN, method = "GET") =>
  new Request(`https://t/v1/stats/${name}`, { method, headers: token === null ? {} : { authorization: `Bearer ${token}` } });

test("a batch through the store is kept, one row per event, and a missing field is kept as null", async () => {
  const { db, env } = store();
  const r = await handle(post([event(), event({ event: "node_start", tool: undefined, duration_ms: undefined })]), env, Date.UTC(2026, 10, 16, 3, 40));
  assert.equal(r.status, 204);
  const rows = db.prepare("SELECT received_hour, event, tool, duration_ms FROM events ORDER BY id").all();
  assert.deepEqual(rows.map((x) => ({ ...x })), [
    { received_hour: Date.UTC(2026, 10, 16, 3) / 1000, event: "tool_call", tool: "unbrowse_do", duration_ms: 90 },
    { received_hour: Date.UTC(2026, 10, 16, 3) / 1000, event: "node_start", tool: null, duration_ms: null },
  ]);
});

test("a batch the store can't take is refused whole, and nothing is half kept", async () => {
  let n = 0;
  const { db, env } = store({ failOn: () => ++n === 2 });
  const r = await handle(post([event(), event()]), env);
  assert.equal(r.status, 503);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM events").get().c, 0);
});

test("queries.sql names its questions, and every one runs on the schema", async () => {
  const q = namedQueries(QUERIES);
  assert.deepEqual(Object.keys(q), ["installs", "calls", "breaks", "times", "versions", "gate", "funnel"]);
  const { env } = store();
  await handle(post([event(), event({ outcome: "failed", error_class: "site" })]), env);
  for (const name of Object.keys(q)) {
    const r = await handle(get(name), env);
    assert.equal(r.status, 200, name);
    assert.ok(Array.isArray((await r.json()).rows), name);
  }
});

test("the counts leave the gate's own events out, and the gate question counts only them", async () => {
  const { env } = store();
  await handle(post([event(), event({ install_id: GATE })]), env);
  const installs = await (await handle(get("installs"), env)).json();
  assert.equal(installs.rows[0].installs, 1);
  const gate = await (await handle(get("gate"), env)).json();
  assert.equal(gate.rows[0].events, 1);
});

test("the funnel counts each install once, at its furthest step, and leaves the gate out", async () => {
  const { env } = store();
  const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32);
  await handle(post([
    event({ install_id: a, event: "node_start", tool: undefined }),
    event({ install_id: a, tool: "unbrowse_search" }),
    event({ install_id: a, tool: "unbrowse_do" }),
    event({ install_id: a, tool: "unbrowse_do" }),
    event({ install_id: b, event: "node_start", tool: undefined }),
    event({ install_id: b, tool: "unbrowse_do", outcome: "failed", error_class: "site" }),
    event({ install_id: b, tool: "unbrowse_search" }),
    event({ install_id: c, event: "node_start", tool: undefined }),
    event({ install_id: GATE, tool: "unbrowse_do" }),
  ]), env);
  const { rows } = await (await handle(get("funnel"), env)).json();
  assert.equal(rows.length, 1);
  const { week, ...counts } = rows[0];
  assert.match(week, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(week + "T00:00:00Z").getUTCDay(), 1, "weeks start on Monday");
  assert.deepEqual(counts, { installs: 3, called: 2, good_call: 1, good_call_7d: 1, back_after_7d: 0 });
});

test("the stats door is 404 with no token set, a wrong one or none, and never runs a caller's SQL", async () => {
  const { env } = store();
  assert.equal((await handle(get("installs"), { ...env, ADMIN_TOKEN: undefined })).status, 404);
  assert.equal((await handle(get("installs", "short"), { ...env, ADMIN_TOKEN: "short" })).status, 404);
  assert.equal((await handle(get("installs", "wrong-token-of-a-length"), env)).status, 404);
  assert.equal((await handle(get("installs", null), env)).status, 404);
  assert.equal((await handle(get("installs", TOKEN, "POST"), env)).status, 405);
  const sql = await handle(get(encodeURIComponent("SELECT * FROM events")), env);
  assert.equal(sql.status, 404);
  assert.deepEqual((await handle(get(""), env).then((r) => r.json())).names, Object.keys(namedQueries(QUERIES)));
});

test("a store that doesn't answer a question is a 503", async () => {
  const { env } = store({ fails: true });
  assert.equal((await handle(get("installs"), env)).status, 503);
});
