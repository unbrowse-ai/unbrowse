// The deployed path: events through ../src/sql.js's client to the TelemetryStore stand-in (./d1.mjs), and the stats
// door that reads queries.sql's named questions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { handle, KEEP_DAYS } from "../src/index.js";
import { client, migrate, namedQueries } from "../src/sql.js";
import { fakeStore, sqlExec } from "./d1.mjs";

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
const install = (id) => get(`install${id === undefined ? "" : `?id=${encodeURIComponent(id)}`}`);

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

test("a kept batch deletes every event past KEEP_DAYS from the hour it arrived, and keeps the rest", async () => {
  const { db, env } = store();
  const day = 86_400_000;
  const now = Date.UTC(2026, 10, 16, 3, 40);
  await handle(post([event({ duration_ms: 1 })]), env, now - (KEEP_DAYS + 1) * day);
  await handle(post([event({ duration_ms: 2 })]), env, now - KEEP_DAYS * day + 3_600_000);
  const r = await handle(post([event({ duration_ms: 3 })]), env, now);
  assert.equal(r.status, 204);
  assert.deepEqual(db.prepare("SELECT duration_ms FROM events ORDER BY id").all().map((x) => x.duration_ms), [2, 3]);
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
  assert.deepEqual(Object.keys(q), ["installs", "calls", "breaks", "times", "versions", "gate", "funnel", "funnel_by_from", "arms", "install"]);
  const { env } = store();
  await handle(post([event(), event({ outcome: "failed", error_class: "site" })]), env);
  for (const name of Object.keys(q)) {
    const r = await handle(name === "install" ? install(ID) : get(name), env);
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

// The events table as a store made before from_tag has it: what `CREATE TABLE IF NOT EXISTS` leaves in place.
const OLD_EVENTS = `CREATE TABLE events (id INTEGER PRIMARY KEY, received_hour INTEGER NOT NULL, event TEXT NOT NULL,
  version TEXT NOT NULL, os TEXT NOT NULL, install_id TEXT NOT NULL, tool TEXT, outcome TEXT NOT NULL, duration_ms INTEGER,
  error_class TEXT)`;

test("a store made before from_tag gets the column, keeps its rows, and the next start changes nothing", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(OLD_EVENTS);
  db.exec("INSERT INTO events (received_hour, event, version, os, install_id, outcome) VALUES (3600, 'node_start', '1.0.0', 'linux', '" + ID + "', 'ok')");
  // As the store starts: schema.sql, then the migration. Twice, as every start does it.
  for (let i = 0; i < 2; i++) {
    db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    migrate(sqlExec(db));
  }
  const cols = db.prepare("SELECT name FROM pragma_table_info('events')").all().map((r) => r.name);
  assert.ok(cols.includes("from_tag"), cols.join());
  assert.equal(cols.filter((c) => c === "from_tag").length, 1);
  assert.deepEqual({ ...db.prepare("SELECT event, from_tag FROM events").get() }, { event: "node_start", from_tag: null });
  // The deployed path takes a tagged start into it.
  const env = { TELEMETRY_DB: client(fakeStore(db)), QUERIES, ADMIN_TOKEN: TOKEN };
  const r = await handle(post([event({ event: "node_start", tool: undefined, duration_ms: undefined, from: "hn-e" })]), env);
  assert.equal(r.status, 204);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM events WHERE from_tag = 'hn-e'").get().c, 1);
});

test("a column another start added meanwhile is not an error; any other failure is", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(OLD_EVENTS);
  const exec = sqlExec(db);
  // The look says the column is missing, and by the ALTER it is there: as two starts racing.
  const racing = (sql, ...v) => (sql.startsWith("SELECT 1 FROM pragma_table_info") ? { toArray: () => [] } : exec(sql, ...v));
  db.exec("ALTER TABLE events ADD COLUMN from_tag TEXT");
  assert.doesNotThrow(() => migrate(racing));
  const broken = (sql, ...v) => {
    if (sql.startsWith("ALTER")) throw new Error("disk I/O error");
    return sql.startsWith("SELECT 1 FROM pragma_table_info") ? { toArray: () => [] } : exec(sql, ...v);
  };
  assert.throws(() => migrate(broken), /disk I\/O/);
});

const H = 3600, D = 86400;
/** Events for one install, at hours after `t0`: [hour offset, overrides]. */
const at = (id, t0, list) => list.map(([h, over]) => [t0 + h * H, event({ install_id: id, ...over })]);
const START = { event: "node_start", tool: undefined, duration_ms: undefined };

async function postAt(env, timed) {
  for (const [t, e] of timed) {
    const r = await handle(post([JSON.parse(JSON.stringify(e))]), env, t * 1000);
    assert.equal(r.status, 204, r.status === 204 ? "" : `${JSON.stringify(e)}: ${(await r.json()).error}`);
  }
}

test("funnel_by_from splits the funnel by each install's first tag, and an install that sent none is direct", async () => {
  const { env } = store();
  const t0 = Math.floor(Date.now() / 1000 / D) * D - 2 * D;
  const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => x.repeat(32));
  await postAt(env, [
    ...at(a, t0, [[0, { ...START, from: "hn-e" }], [1, { tool: "unbrowse_do" }], [2, { ...START, from: "reddit" }]]),
    ...at(b, t0, [[0, { ...START, from: "hn-e" }], [1, { tool: "unbrowse_search" }]]),
    ...at(c, t0, [[0, START], [1, { tool: "unbrowse_do" }]]),
    ...at(d, t0, [[0, { ...START, from: "reddit" }]]),
    ...at(GATE, t0, [[0, { ...START, from: "internal" }], [1, { tool: "unbrowse_do" }]]),
  ]);
  const { rows } = await (await handle(get("funnel_by_from"), env)).json();
  const by = Object.fromEntries(rows.map(({ week, from_tag, ...n }) => [from_tag, n]));
  assert.deepEqual(Object.keys(by).sort(), ["direct", "hn-e", "reddit"], "the gate's tag is left out; a later tag never moves an install");
  assert.deepEqual(by["hn-e"], { installs: 2, called: 2, good_call: 1, good_call_7d: 1, back_after_7d: 0 });
  assert.deepEqual(by.direct, { installs: 1, called: 1, good_call: 1, good_call_7d: 1, back_after_7d: 0 });
  assert.deepEqual(by.reddit, { installs: 1, called: 0, good_call: 0, good_call_7d: 0, back_after_7d: 0 });
  assert.equal(new Set(rows.map((r) => r.week)).size, 1);
});

test("arms counts a first good call within 7 days per one-letter arm, and settles only installs 7 days old", async () => {
  const { env } = store();
  const now = Math.floor(Date.now() / 1000 / H) * H;
  const old = now - 10 * D, fresh = now - 1 * D;
  const ids = "01234567".split("").map((x) => x.repeat(32));
  await postAt(env, [
    // Arm e: two settled installs, one good within 7 days, one good only after 8; one fresh install, good.
    ...at(ids[0], old, [[0, { ...START, from: "hn-e" }], [5, { tool: "unbrowse_do" }]]),
    ...at(ids[1], old, [[0, { ...START, from: "x-e" }], [8 * 24, { tool: "unbrowse_do" }]]),
    ...at(ids[2], fresh, [[0, { ...START, from: "hn-e" }], [2, { tool: "/v1/do" }]]),
    // Arm d: one settled install whose call failed.
    ...at(ids[3], old, [[0, { ...START, from: "hn-d" }], [1, { tool: "unbrowse_do", outcome: "failed", error_class: "site" }]]),
    // No arm: a tag whose end is a word, one with no dash, one ending in a digit, and an install with no tag.
    ...at(ids[4], old, [[0, { ...START, from: "ai-chatgpt" }], [1, { tool: "unbrowse_do" }]]),
    ...at(ids[5], old, [[0, { ...START, from: "e" }], [1, { tool: "unbrowse_do" }]]),
    ...at(ids[6], old, [[0, { ...START, from: "door-7" }], [1, { tool: "unbrowse_do" }]]),
    ...at(ids[7], old, [[0, START], [1, { tool: "unbrowse_do" }]]),
    ...at(GATE, old, [[0, { ...START, from: "gate-e" }], [1, { tool: "unbrowse_do" }]]),
  ]);
  const { rows } = await (await handle(get("arms"), env)).json();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { arm: "d", installs: 1, good_call_7d: 0, settled: 1, settled_good_call_7d: 0 },
    { arm: "e", installs: 3, good_call_7d: 2, settled: 2, settled_good_call_7d: 1 },
  ]);
});

test("install answers one install's first seen, tag, first call, first good call and last seen, by its id", async () => {
  const { env } = store();
  const t0 = Math.floor(Date.now() / 1000 / H) * H - 3 * D;
  const [a, b] = ["a", "b"].map((x) => x.repeat(32));
  await postAt(env, [
    ...at(a, t0, [
      [0, { ...START, from: "hn-e" }],
      [1, { tool: "unbrowse_search" }],
      [2, { tool: "unbrowse_do", outcome: "failed", error_class: "site" }],
      [3, { tool: "unbrowse_do" }],
      [4, { tool: "/v1/do" }],
      [30, { ...START, from: "reddit" }],
    ]),
    ...at(b, t0, [[0, START], [1, { tool: "unbrowse_do" }]]),
  ]);
  const { rows } = await (await handle(install(a), env)).json();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{
    install_id: a, first_seen: t0, from_tag: "hn-e", first_call: t0 + 1 * H, first_good_call: t0 + 3 * H,
    last_seen: t0 + 30 * H, calls: 4, good_calls: 2,
  }], "the first tag stays; a failed call and a search are calls, not good calls");
  const other = (await (await handle(install(b), env)).json()).rows[0];
  assert.equal(other.from_tag, null, "an install that sent no tag has none");
  assert.equal(other.first_good_call, t0 + 1 * H);
  assert.deepEqual((await (await handle(install("c".repeat(32)), env)).json()).rows, [], "an unknown install has no row");
});

test("install binds its id only after the id's shape is checked, and asks nothing of the store otherwise", async () => {
  // A store that fails every question: a refused id must be refused before the store is asked (400, never 503).
  const { env } = store({ fails: true });
  for (const id of [undefined, "", "' OR 1=1 --", "A".repeat(32), "a".repeat(31), "a".repeat(33), `${"a".repeat(32)}' OR '1'='1`]) {
    const r = await handle(install(id), env);
    assert.equal(r.status, 400, String(id));
  }
  assert.equal((await (await handle(install(undefined), env)).json()).error, "install needs ?id=", "a missing id is said as missing");
  assert.equal((await (await handle(install("' OR 1=1 --"), env)).json()).error, "id is not an allowed value");
  // The token still guards it: a wrong one is the same 404 as anywhere on the door.
  assert.equal((await handle(new Request(`https://t/v1/stats/install?id=${ID}`, { headers: { authorization: "Bearer wrong-token-of-a-length" } }), env)).status, 404);
  // A value sent to a question that takes none is not bound into it.
  const ok = store();
  await handle(post([event()]), ok.env);
  const r = await handle(get(`installs?id=${encodeURIComponent("x') UNION SELECT 1 --")}`), ok.env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).rows[0].installs, 1);
});
