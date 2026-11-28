// The deployed path: events through ../src/sql.js's client to the TelemetryStore stand-in (./d1.mjs), and the stats
// door that reads queries.sql's named questions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handle as handleAt, KEEP_DAYS } from "../src/index.js";
import { client, CLOCK, migrate, namedQueries } from "../src/sql.js";
import { cloudflareSqlite, fakeStore, sqlExec } from "./d1.mjs";

const QUERIES = readFileSync(new URL("../queries.sql", import.meta.url), "utf8");

// PR #1002 review, round 4: a fixture placed by the wall clock failed between 01:00 and 01:59 UTC. Every request here
// runs at one fixed clock (a Wednesday, 12:30 UTC) unless it names another, and the questions read the worker's clock,
// never SQLite's. The tests that read time (`clocked`) run again at 00:30, 01:30 and 23:30 UTC, over a day's and a
// week's edge, at the end of this file.
let NOW_MS = Date.UTC(2026, 10, 25, 12, 30);
const handle = (request, env, now = NOW_MS, ...rest) => handleAt(request, env, now, ...rest);
const CLOCKED = [];
const clocked = (name, fn) => {
  CLOCKED.push([name, fn]);
  test(name, fn);
};
const TOKEN = "an-admin-token-of-length";
const GATE = "f".repeat(32);
const ID = "0123456789abcdef0123456789abcdef";

function store(opts) {
  const db = cloudflareSqlite();
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
  assert.deepEqual(Object.keys(q), ["installs", "calls", "breaks", "times", "versions", "gate", "funnel", "funnel_by_from", "arms", "ours",
    "days", "weeks", "cohorts", "releases", "release_errors", "tool_weeks", "error_weeks", "arm_weeks", "period", "install"]);
  const { env } = store();
  await handle(post([event(), event({ outcome: "failed", error_class: "site" })]), env);
  for (const name of Object.keys(q)) {
    const r = await handle(name === "install" ? install(ID) : name === "period" ? get("period?days=30") : get(name), env);
    assert.equal(r.status, 200, name);
    assert.ok(Array.isArray((await r.json()).rows), name);
  }
});

clocked("the counts leave the gate's own events out, and the gate question counts only them", async () => {
  const { env } = store();
  await handle(post([event(), event({ install_id: GATE })]), env);
  const installs = await (await handle(get("installs"), env)).json();
  assert.equal(installs.rows[0].installs, 1);
  const gate = await (await handle(get("gate"), env)).json();
  assert.equal(gate.rows[0].events, 1);
});

clocked("the funnel counts each install once, at its furthest step, and leaves the gate out", async () => {
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
  const db = cloudflareSqlite();
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
  const db = cloudflareSqlite();
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

clocked("funnel_by_from splits the funnel by each install's first tag, and an install that sent none is direct", async () => {
  const { env } = store();
  const t0 = Math.floor(NOW_MS / 1000 / D) * D - 2 * D;
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

clocked("arms counts a first good call within 7 days per one-letter arm, and settles only installs 7 days old", async () => {
  const { env } = store();
  const now = Math.floor(NOW_MS / 1000 / H) * H;
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

clocked("install answers one install's first seen, tag, first call, first good call and last seen, by its id", async () => {
  const { env } = store();
  const t0 = Math.floor(NOW_MS / 1000 / H) * H - 3 * D;
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

// UNB-303 (Lewis, 25 Nov 2026: "can we exclude our usage counts as users"): our own nodes and test builds were counted
// as people. The Steam Deck's source-build node sent 34% of a month's calls, and test builds that were never offered to
// anyone filled the installs. Ours is: the gate, a source build (0.x: no release is), a node started with an internal
// source tag, an install on the list, or one that sent a version on the list.
const ours = (body, method = "POST", token = TOKEN) =>
  new Request("https://t/v1/ours", { method, headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });

clocked("the funnel and the counts leave our own installs out, and `ours` says how many and why", async () => {
  const { env } = store();
  const person = "a".repeat(32), source = "b".repeat(32), tagged = "c".repeat(32), listed = "d".repeat(32), tester = "e".repeat(32);
  assert.equal((await handle(ours({ kind: "install", value: listed, why: "Lewis's Mac" }), env)).status, 204);
  assert.equal((await handle(ours({ kind: "version", value: "13.21.0-installers.6", why: "device test build, never offered" }), env)).status, 204);
  await handle(post([
    event({ install_id: person, event: "node_start", tool: undefined, version: "13.21.0-installers.4" }),
    event({ install_id: person, version: "13.21.0-installers.4" }),
    event({ install_id: source, version: "0.1.0" }),
    event({ install_id: tagged, event: "node_start", tool: undefined, from: "internal" }),
    event({ install_id: tagged }),
    event({ install_id: listed }),
    event({ install_id: tester, version: "13.21.0-installers.6" }),
    event({ install_id: GATE }),
  ]), env);
  const funnel = (await (await handle(get("funnel"), env)).json()).rows;
  assert.deepEqual(funnel.map(({ week, ...c }) => c), [{ installs: 1, called: 1, good_call: 1, good_call_7d: 1, back_after_7d: 0 }]);
  for (const name of ["installs", "versions"]) {
    const rows = (await (await handle(get(name), env)).json()).rows;
    assert.equal(rows.reduce((n, r) => n + r.installs, 0), 1, name);
  }
  const calls = (await (await handle(get("calls"), env)).json()).rows;
  assert.equal(calls.reduce((n, r) => n + r.calls, 0), 1, "only the person's call");
  const why = Object.fromEntries((await (await handle(get("ours"), env)).json()).rows.map((r) => [r.why, [r.installs, r.calls]]));
  assert.deepEqual(why, { gate: [1, 1], listed: [1, 1], "listed version": [1, 1], "source build": [1, 1], "internal tag": [1, 1] });
});

test("only the admin token adds or removes one of ours, and only a value of its kind's shape", async () => {
  const { env } = store();
  const id = "a".repeat(32);
  assert.equal((await handle(ours({ kind: "install", value: id, why: "x" }, "POST", null), env)).status, 404);
  assert.equal((await handle(ours({ kind: "install", value: id, why: "x" }, "POST", "wrong-token-of-a-length"), env)).status, 404);
  assert.equal((await handle(ours({ kind: "install", value: "not-hex", why: "x" }), env)).status, 400);
  assert.equal((await handle(ours({ kind: "version", value: "https://evil.example", why: "x" }), env)).status, 400);
  assert.equal((await handle(ours({ kind: "person", value: id, why: "x" }), env)).status, 400);
  assert.equal((await handle(ours({ kind: "install", value: id, why: "" }), env)).status, 400);
  assert.equal((await handle(ours({ kind: "install", value: id, why: "w".repeat(81) }), env)).status, 400);
  assert.equal((await handle(ours({ kind: "install", value: id, why: "our test box" }), env)).status, 204);
  await handle(post([event({ install_id: id })]), env);
  assert.equal((await (await handle(get("installs"), env)).json()).rows.length, 0);
  assert.equal((await handle(ours({ kind: "install", value: id }, "DELETE"), env)).status, 204);
  assert.equal((await (await handle(get("installs"), env)).json()).rows[0].installs, 1, "a removed install counts again");
});

// UNB-315: /admin counted our own device-test and staging builds (13.21.0-installers.6, 13.21.0-staging.2) as people.
// Only the prereleases the site's Download buttons served (installers.3 and .4) reached anyone.
test("a prerelease build the site never offered is ours, an offered one stays a person's, and an admin can offer one", async () => {
  const { env } = store();
  const [person, device, staging, later] = ["a", "b", "c", "d"].map((x) => x.repeat(32));
  await handle(post([
    event({ install_id: person, version: "13.21.0-installers.4" }),
    event({ install_id: device, version: "13.21.0-installers.6" }),
    event({ install_id: staging, version: "13.21.0-staging.2" }),
    event({ install_id: later, version: "13.22.0-installers.1" }),
    event({ install_id: "e".repeat(32), version: "13.1.0" }),
  ]), env);
  const count = async () => (await (await handle(get("installs"), env)).json()).rows.reduce((n, r) => n + r.installs, 0);
  assert.equal(await count(), 2, "the installers.4 person and the 13.1.0 person");
  const why = Object.fromEntries((await (await handle(get("ours"), env)).json()).rows.map((r) => [r.why, r.installs]));
  assert.deepEqual(why, { "test build": 3 });
  assert.equal((await handle(ours({ kind: "offered", value: "13.22.0-installers.1", why: "site Download buttons" }), env)).status, 204);
  assert.equal(await count(), 3, "offered: its installs are people's from then on");
  assert.equal((await handle(ours({ kind: "offered", value: "13.22.0" }), env)).status, 400, "only a prerelease can be offered");
  assert.equal((await handle(ours({ kind: "offered", value: "13.22.0-installers.1" }, "DELETE"), env)).status, 204);
  assert.equal(await count(), 2);
});

const WEEK = 7 * D;
/** The Monday (UTC) that starts the week `weeksAgo` weeks before this one, in Unix seconds. */
const monday = (weeksAgo) => { const d = Math.floor(NOW_MS / 1000 / D); return (d - ((d + 3) % 7)) * D - weeksAgo * WEEK; };
const rowsOf = async (env, name) => (await (await handle(get(name), env)).json()).rows;

clocked("days and weeks split every count into real and ours, and add up to the events", async () => {
  const { env } = store();
  const w = monday(1), [a, b] = ["a", "b"].map((x) => x.repeat(32));
  await postAt(env, [
    ...at(a, w, [[0, START], [1, { tool: "unbrowse_search" }], [2, { tool: "unbrowse_do", outcome: "failed", error_class: "site" }], [26, { tool: "unbrowse_do" }]]),
    ...at(b, w, [[0, { ...START, from: "internal" }], [1, { tool: "unbrowse_do" }]]),
  ]);
  const weeks = await rowsOf(env, "weeks");
  const by = Object.fromEntries(weeks.map(({ week, who, ...n }) => [`${week}|${who}`, n]));
  const key = new Date(w * 1000).toISOString().slice(0, 10);
  assert.deepEqual(by[`${key}|real`], { active: 1, new_installs: 1, calling: 1, first_good: 1, calls: 3, ok_calls: 2 });
  assert.deepEqual(by[`${key}|ours`], { active: 1, new_installs: 1, calling: 1, first_good: 1, calls: 1, ok_calls: 1 });
  const days = (await rowsOf(env, "days")).filter((r) => r.who === "real");
  assert.deepEqual(days.map((r) => [r.active, r.new_installs, r.first_good, r.calls]).sort(), [[1, 0, 1, 1], [1, 1, 0, 2]],
    "day one: new, two calls and no good one; day two: its first good call");
});

clocked("cohorts count who called again in the 1st, 2nd and 4th week after the week they were first seen", async () => {
  const { env } = store();
  const w = monday(6), ids = ["a", "b", "c"].map((x) => x.repeat(32));
  await postAt(env, [
    ...at(ids[0], w, [[0, START], [1, { tool: "unbrowse_do" }], [24 * 8, { tool: "unbrowse_search" }], [24 * 29, { tool: "unbrowse_search" }]]),
    ...at(ids[1], w, [[0, START], [24 * 15, { tool: "unbrowse_search" }], [24 * 15 + 1, { event: "node_start", tool: undefined, duration_ms: undefined }]]),
    ...at(ids[2], w, [[0, START], [24 * 30, START]]),
  ]);
  const [row] = (await rowsOf(env, "cohorts")).filter((r) => r.who === "real");
  assert.deepEqual(row, { week: new Date(w * 1000).toISOString().slice(0, 10), who: "real", installs: 3, called: 2, good_call_7d: 1, week_1: 1, week_2: 0, week_4: 1, weeks_old: 6 },
    "a start with no call is not coming back, and nor is a first call ever (the second install's, on day 15)");
});

clocked("releases give each version's installs, calls, ok calls and call times, and release_errors what broke, real and ours", async () => {
  const { env } = store();
  const [a, b] = ["a", "b"].map((x) => x.repeat(32));
  await handle(post([
    ...[100, 200, 300, 400].map((ms) => event({ install_id: a, version: "13.1.0", duration_ms: ms })),
    event({ install_id: a, version: "13.1.0", outcome: "failed", error_class: "site", duration_ms: 5000 }),
    event({ install_id: a, version: "13.0.0", outcome: "error", duration_ms: 50 }),
    event({ install_id: b, version: "13.21.0-staging.2", duration_ms: 70 }),
  ]), env).then((r) => assert.equal(r.status, 204));
  const rel = Object.fromEntries((await rowsOf(env, "releases")).map(({ version, who, first_hour, ...n }) => [`${version}|${who}`, n]));
  assert.deepEqual(rel["13.1.0|real"], { installs: 1, calls: 5, ok_calls: 4, p50_ms: 300, p95_ms: 5000 });
  assert.deepEqual(rel["13.0.0|real"], { installs: 1, calls: 1, ok_calls: 0, p50_ms: 50, p95_ms: 50 });
  assert.deepEqual(rel["13.21.0-staging.2|ours"], { installs: 1, calls: 1, ok_calls: 1, p50_ms: 70, p95_ms: 70 });
  const errs = (await rowsOf(env, "release_errors")).map((r) => `${r.version} ${r.who} ${r.error_class} ${r.calls}`).sort();
  assert.deepEqual(errs, ["13.0.0 real error 1", "13.1.0 real site 1"], "no class: the outcome stands in");
});

clocked("tool_weeks, error_weeks and arm_weeks count by week, real and ours", async () => {
  const { env } = store();
  const w = monday(2), [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(32));
  await postAt(env, [
    ...at(a, w, [[0, { ...START, from: "hn-e" }], [1, { tool: "unbrowse_do" }], [2, { tool: "unbrowse_do", outcome: "error", error_class: "unavailable" }]]),
    ...at(b, w, [[0, { ...START, from: "x-f" }], [1, { tool: "unbrowse_search" }]]),
    ...at(c, w, [[0, { ...START, from: "internal" }], [1, { tool: "unbrowse_do", outcome: "error", error_class: "unavailable" }]]),
  ]);
  const week = new Date(w * 1000).toISOString().slice(0, 10);
  const tools = (await rowsOf(env, "tool_weeks")).map((r) => `${r.week === week} ${r.who} ${r.tool} ${r.calls} ${r.ok_calls}`).sort();
  assert.deepEqual(tools, ["true ours unbrowse_do 1 0", "true real unbrowse_do 2 1", "true real unbrowse_search 1 1"]);
  const errors = (await rowsOf(env, "error_weeks")).map((r) => `${r.who} ${r.error_class} ${r.calls}`).sort();
  assert.deepEqual(errors, ["ours unavailable 1", "real unavailable 1"]);
  const arms = (await rowsOf(env, "arm_weeks")).map(({ week: k, ...r }) => ({ ...r, k: k === week }));
  assert.deepEqual(arms, [
    { who: "real", arm: "e", installs: 1, good_call_7d: 1, settled: 1, settled_good_call_7d: 1, k: true },
    { who: "real", arm: "f", installs: 1, good_call_7d: 0, settled: 1, settled_good_call_7d: 0, k: true },
  ], "an internal tag is no arm");
});

clocked("period counts the last 7, 30 or 90 days against the days before, real and ours, and takes no other range", async () => {
  const { env } = store();
  const now = Math.floor(NOW_MS / 1000 / H) * H, [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(32));
  await postAt(env, [
    ...at(a, now - 10 * D, [[0, START], [1, { tool: "unbrowse_do" }], [24 * 8, { tool: "unbrowse_search" }]]),
    ...at(b, now - 2 * D, [[0, START], [1, { tool: "unbrowse_search", outcome: "error", error_class: "unavailable" }]]),
    ...at(c, now - 2 * D, [[0, { ...START, from: "ci" }], [1, { tool: "unbrowse_do" }]]),
  ]);
  const rows = (await (await handle(get("period?days=7"), env)).json()).rows;
  const by = Object.fromEntries(rows.map(({ period, who, ...n }) => [`${period}|${who}`, n]));
  assert.deepEqual(by["current|real"], { active: 2, new_installs: 1, calling: 2, first_good: 0, calls: 2, ok_calls: 1 }, "a came back, b is new");
  assert.deepEqual(by["previous|real"], { active: 1, new_installs: 1, calling: 1, first_good: 1, calls: 1, ok_calls: 1 });
  assert.deepEqual(by["current|ours"], { active: 1, new_installs: 1, calling: 1, first_good: 1, calls: 1, ok_calls: 1 });
  for (const bad of ["", "?days=14", "?days=7;DROP", "?days=400"]) assert.equal((await handle(get(`period${bad}`), env)).status, 400, bad);
});

// UNB-315, staging gate 2026-11-27: a sixth UNION term in the `ours` view ("test build") made the Durable Object's
// start fail on Cloudflare's SQLite ("too many terms in compound SELECT"), so every batch and every question answered 503.
test("the store starts on Cloudflare's SQLite: schema.sql and every named question fit its compound SELECT limit", async () => {
  const { env } = store();
  assert.equal((await handle(post([event()]), env)).status, 204);
  for (const name of Object.keys(namedQueries(QUERIES))) {
    const q = name === "install" ? `install?id=${ID}` : name === "period" ? "period?days=30" : name;
    assert.equal((await handle(get(q), env)).status, 200, name);
  }
});

// PR #1002 review: `GROUP BY error_class` named the events column, not the COALESCE that stood in for it, so every
// call with no class fell into one NULL bucket whatever its outcome.
clocked("a call with no error class is counted under its own outcome: failed and error never share a row", async () => {
  const { env } = store();
  const w = monday(1), a = "a".repeat(32);
  await postAt(env, at(a, w, [[1, { outcome: "failed" }], [2, { outcome: "error" }], [3, { outcome: "error" }], [4, { outcome: "failed", error_class: "site" }]]));
  const rel = (await rowsOf(env, "release_errors")).map((r) => `${r.version} ${r.who} ${r.error_class} ${r.calls}`).sort();
  assert.deepEqual(rel, ["1.4.2 real error 2", "1.4.2 real failed 1", "1.4.2 real site 1"]);
  const weeks = (await rowsOf(env, "error_weeks")).map((r) => `${r.who} ${r.error_class} ${r.calls}`).sort();
  assert.deepEqual(weeks, ["real error 2", "real failed 1", "real site 1"]);
});

// PR #1002 review: schema.sql runs on every start of the store, and its INSERT OR IGNORE put back any seeded offered
// version an admin had removed, so a revoked prerelease's installs counted as people's again after a restart.
test("an offered version an admin removed stays removed when the store starts again", async () => {
  const { db, env } = store();
  const person = "a".repeat(32);
  await handle(post([event({ install_id: person, version: "13.21.0-installers.4" })]), env);
  const count = async () => (await rowsOf(env, "installs")).reduce((n, r) => n + r.installs, 0);
  assert.equal(await count(), 1, "seeded: offered");
  assert.equal((await handle(ours({ kind: "offered", value: "13.21.0-installers.4" }, "DELETE"), env)).status, 204);
  assert.equal(await count(), 0, "removed: ours");
  // As the Durable Object starts again: schema.sql, then the migration.
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  migrate(sqlExec(db));
  assert.equal(await count(), 0, "still removed after the restart");
  assert.equal((await handle(ours({ kind: "offered", value: "13.21.0-installers.4", why: "offered again" }), env)).status, 204);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  assert.equal(await count(), 1, "an admin can offer it again, and it stays offered");
});

// PR #1002 review: a release branch publishes X.Y.P-rc.N to npm's public `next` tag and to canary
// (.github/scripts/release-version.sh), so anyone can install one; only staging builds and device tests are ours.
clocked("a public release candidate is a person's install, and its later stable calls count too", async () => {
  const { env } = store();
  const [rc, staging, device] = ["a", "b", "c"].map((x) => x.repeat(32));
  await handle(post([
    event({ install_id: rc, version: "13.22.0-rc.3" }),
    event({ install_id: rc, version: "13.22.0" }),
    event({ install_id: staging, version: "13.23.0-staging.4" }),
    event({ install_id: device, version: "13.22.0-installers.6" }),
    event({ install_id: device, version: "13.22.0-rc.3x" }),
  ]), env);
  assert.equal((await rowsOf(env, "installs")).reduce((n, r) => n + r.installs, 0), 1, "the rc install alone");
  const rel = Object.fromEntries((await rowsOf(env, "releases")).map((r) => [`${r.version}|${r.who}`, r.calls]));
  assert.equal(rel["13.22.0-rc.3|real"], 1);
  assert.equal(rel["13.22.0|real"], 1, "its stable calls stay real");
  assert.deepEqual((await rowsOf(env, "ours")).map((r) => [r.why, r.installs]), [["test build", 2]]);
});

// PR #1002 review, round 2: week_1, week_2 and week_4 counted any call in that week, so an install whose first call
// ever fell in week 2 was counted as coming back in week 2. Again means it had called before that week.
clocked("cohorts count a call in week N as coming back only when the install had called before week N", async () => {
  const { env } = store();
  const w = monday(6), [back, late, first1] = ["a", "b", "c"].map((x) => x.repeat(32));
  await postAt(env, [
    ...at(back, w, [[0, START], [1, { tool: "unbrowse_do" }], [24 * 15, { tool: "unbrowse_search" }]]),
    ...at(late, w, [[0, START], [24 * 15, { tool: "unbrowse_search" }], [24 * 29, { tool: "unbrowse_search" }]]),
    ...at(first1, w, [[0, START], [24 * 8, { tool: "unbrowse_do" }], [24 * 16, { tool: "unbrowse_do" }]]),
  ]);
  const [row] = (await rowsOf(env, "cohorts")).filter((r) => r.who === "real");
  assert.deepEqual({ called: row.called, week_1: row.week_1, week_2: row.week_2, week_4: row.week_4 }, { called: 3, week_1: 0, week_2: 2, week_4: 1 },
    "week 1: first1's first call is not a return; week 2: back and first1 return, late's first call does not; week 4: late returns");
});

// PR #1002 review, round 2: a version an admin had marked ours (kind "version") and then offered (kind "offered")
// stayed ours, as its "listed version" entry still stood. The two say opposite things of one version: the later wins.
test("the later word on a version wins: offering one that was marked ours makes it people's, and marking it ours again takes it back", async () => {
  const { env } = store();
  const person = "a".repeat(32);
  await handle(post([event({ install_id: person, version: "13.22.0-installers.1" })]), env);
  const count = async () => (await rowsOf(env, "installs")).reduce((n, r) => n + r.installs, 0);
  assert.equal((await handle(ours({ kind: "version", value: "13.22.0-installers.1", why: "device test" }), env)).status, 204);
  assert.equal((await handle(ours({ kind: "offered", value: "13.22.0-installers.1", why: "site Download buttons" }), env)).status, 204);
  assert.equal(await count(), 1, "offered after it was marked ours: people's");
  assert.equal((await handle(ours({ kind: "version", value: "13.22.0-installers.1", why: "pulled from the site" }), env)).status, 204);
  assert.equal(await count(), 0, "marked ours after it was offered: ours");
  assert.equal((await handle(ours({ kind: "offered", value: "13.21.0-installers.4" }, "DELETE"), env)).status, 204);
  assert.equal((await handle(ours({ kind: "version", value: "1.4.2", why: "a stable version can be ours" }), env)).status, 204);
});

// PR #1002 review, round 2: the current period's events had no upper bound, but its new installs and first good calls
// had `< now`, so an install whose first hour was the hour `now` falls on (the first second of an hour) was active and
// calling but not new. The clock is pinned (round 4), so the question is asked a moment into that hour; asked at its
// very first instant, the hour has not begun before the clock and is in no period (round 5: `< now`).
clocked("period counts an install as new and first good in the period its first hour falls in, by the rule that places its events", async () => {
  const { env } = store();
  const top = Math.floor(NOW_MS / 1000 / H) * H, a = "a".repeat(32);
  await postAt(env, at(a, top, [[0, { tool: "unbrowse_do" }]]));
  assert.deepEqual((await (await handle(get("period?days=7"), env, top * 1000)).json()).rows, [], "at the hour's first instant: not yet");
  const rows = (await (await handle(get("period?days=7"), env, top * 1000 + 500)).json()).rows;
  const by = Object.fromEntries(rows.map(({ period, who, ...n }) => [`${period}|${who}`, n]));
  assert.deepEqual(by["current|real"], { active: 1, new_installs: 1, calling: 1, first_good: 1, calls: 1, ok_calls: 1 });
});

// PR #1002 review, round 3: one prerelease event (a public `unbrowse@staging` build, published --access public) made
// the whole install ours, so a person who tried staging and went back to stable vanished from every real count.
// Real or ours is decided per event, by that event's version, unless the install itself is ours (the gate, the
// install list, an internal source tag): then all of it is.
clocked("real or ours is decided per event by its version: a person who tried a staging build still counts on stable", async () => {
  const { env } = store();
  const x = "a".repeat(32), tagged = "b".repeat(32);
  const t0 = Math.floor(NOW_MS / 1000 / H) * H - 5 * H;
  const STAGING = "13.23.0-staging.4", STABLE = "13.22.0";
  await postAt(env, [
    ...at(x, t0, [[0, { ...START, version: STAGING, from: "hn-e" }], [1, { version: STAGING }],
      [2, { ...START, version: STABLE, from: "hn-e" }], [3, { version: STABLE }], [4, { version: STABLE, outcome: "failed", error_class: "site" }]]),
    ...at(tagged, t0, [[0, { ...START, version: STABLE, from: "internal" }], [1, { version: STABLE }]]),
  ]);
  const sum = (rows, k) => rows.reduce((n, r) => n + r[k], 0);
  // A bucketed question gives one row per day or week and side: the fixture may cross midnight or a Monday (it does at
  // 00:30 and 01:30), so counts that add up are summed per side, and a distinct count is read per row, never keyed by
  // side alone (PR #1002 review, round 4: one day's row overwrote the other's).
  const sumBy = (rows, k) => rows.reduce((m, r) => ({ ...m, [r.who]: (m[r.who] ?? 0) + r[k] }), {});
  const maxBy = (rows, k) => rows.reduce((m, r) => ({ ...m, [r.who]: Math.max(m[r.who] ?? 0, r[k]) }), {});
  const installs = await rowsOf(env, "installs");
  assert.ok(installs.length >= 1 && installs.every((r) => r.installs === 1), "installs: the one person each day it was active");
  assert.equal(sum(await rowsOf(env, "calls"), "calls"), 2, "calls: the stable two");
  assert.equal(sum(await rowsOf(env, "breaks"), "calls"), 1, "breaks");
  assert.equal(sum(await rowsOf(env, "times"), "total"), 2, "times");
  assert.deepEqual((await rowsOf(env, "versions")).map((r) => [r.version, r.installs]), [[STABLE, 1]], "versions");
  assert.deepEqual((await rowsOf(env, "funnel")).map(({ week, ...c }) => c), [{ installs: 1, called: 1, good_call: 1, good_call_7d: 1, back_after_7d: 0 }], "funnel");
  assert.deepEqual((await rowsOf(env, "funnel_by_from")).map((r) => [r.from_tag, r.installs]), [["hn-e", 1]], "funnel_by_from");
  assert.deepEqual((await rowsOf(env, "arms")).map((r) => [r.arm, r.installs]), [["e", 1]], "arms");
  assert.deepEqual(sumBy(await rowsOf(env, "weeks"), "calls"), { real: 2, ours: 2 }, "weeks: x's staging call and tagged's call are ours");
  assert.deepEqual(maxBy(await rowsOf(env, "weeks"), "active"), { real: 1, ours: 2 });
  assert.deepEqual(sumBy((await rowsOf(env, "days")).filter((r) => r.who === "real"), "calls"), { real: 2 }, "days");
  const rel = Object.fromEntries((await rowsOf(env, "releases")).map((r) => [`${r.version}|${r.who}`, [r.installs, r.calls]]));
  assert.deepEqual(rel, { [`${STABLE}|real`]: [1, 2], [`${STABLE}|ours`]: [1, 1], [`${STAGING}|ours`]: [1, 1] }, "releases");
  assert.deepEqual((await rowsOf(env, "release_errors")).map((r) => `${r.version} ${r.who} ${r.error_class}`), [`${STABLE} real site`]);
  assert.deepEqual(sumBy(await rowsOf(env, "tool_weeks"), "calls"), { real: 2, ours: 2 }, "tool_weeks");
  assert.deepEqual(sumBy(await rowsOf(env, "error_weeks"), "calls"), { real: 1 }, "error_weeks");
  assert.deepEqual((await rowsOf(env, "arm_weeks")).map((r) => [r.who, r.arm, r.installs]).sort(), [["ours", "e", 1], ["real", "e", 1]],
    "arm_weeks: tagged is no arm; x's staging start counts on our side, its stable start on the person's");
  assert.deepEqual(sumBy(await rowsOf(env, "cohorts"), "installs"), { real: 1, ours: 2 }, "cohorts");
  const period = Object.fromEntries((await (await handle(get("period?days=7"), env)).json()).rows.filter((r) => r.period === "current").map((r) => [r.who, [r.active, r.calls]]));
  assert.deepEqual(period, { real: [1, 2], ours: [2, 2] }, "period");
  assert.deepEqual(Object.fromEntries((await rowsOf(env, "ours")).map((r) => [r.why, [r.installs, r.calls]])), { "internal tag": [1, 1], "test build": [1, 1] }, "ours: by reason, per event");
});

// PR #1002 review, round 3: days and weeks dropped events before `now - 189 days`, mid-bucket, but placed first good
// calls and new installs in the whole bucket, so the oldest bucket could show a first good call and no call. Every
// windowed question starts its window at the start of a whole bucket, the same one for every count in it.
clocked("at the window's edge every count in the oldest bucket agrees: whole days and weeks, calls, first good calls and new installs alike", async () => {
  const { env } = store();
  const now = Math.floor(NOW_MS / 1000);
  const dayOf = (t) => Math.floor(t / D) * D, weekOf = (t) => { const d = Math.floor(t / D); return (d - ((d + 3) % 7)) * D; };
  const edgeDay = dayOf(now - 189 * D), edgeWeek = weekOf(now - 189 * D), edge30 = dayOf(now) - 29 * D;
  const [d, w, c] = ["a", "b", "c"].map((x) => x.repeat(32));
  const timed = [
    ...at(d, edgeDay, [[0, { tool: "unbrowse_do" }], [23, START]]),
    ...at(w, edgeWeek, [[0, { ...START, from: "hn-e" }], [1, { tool: "unbrowse_do" }], [2, { tool: "unbrowse_do", outcome: "failed", error_class: "site" }], [24 * 7 - 1, START]]),
    ...at(c, edge30, [[0, { tool: "unbrowse_do" }]]),
  ].sort((a, b) => a[0] - b[0]);
  await postAt(env, timed);
  // What a whole bucket [from, from + span) holds, counted from the fixture itself, so it holds at any clock.
  const whole = (from, span) => {
    const inside = timed.filter(([t]) => t >= from && t < from + span), ids = (f) => new Set(inside.filter(f).map(([, e]) => e.install_id)).size;
    const firstOf = (id, f) => timed.find(([t, e]) => e.install_id === id && f(e))?.[0];
    const call = (e) => e.event === "tool_call", good = (e) => call(e) && e.outcome === "ok";
    const placed = (f) => ids(([, e]) => { const t = firstOf(e.install_id, f); return t >= from && t < from + span; });
    return { active: ids(() => true), new_installs: placed(() => true), calling: ids(([, e]) => call(e)), first_good: placed(good),
      calls: inside.filter(([, e]) => call(e)).length, ok_calls: inside.filter(([, e]) => good(e)).length };
  };
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const pick = ({ active, new_installs, calling, first_good, calls, ok_calls }) => ({ active, new_installs, calling, first_good, calls, ok_calls });
  const days = (await rowsOf(env, "days")).find((r) => r.day === iso(edgeDay) && r.who === "real");
  assert.deepEqual(days && pick(days), whole(edgeDay, D), "days: the oldest day is whole");
  assert.ok(days.calling >= days.first_good && days.calls >= days.first_good, "days: no first good call without its call");
  const weeks = (await rowsOf(env, "weeks")).find((r) => r.week === iso(edgeWeek) && r.who === "real");
  assert.deepEqual(weeks && pick(weeks), whole(edgeWeek, 7 * D), "weeks: the oldest week is whole");
  assert.deepEqual(pick(weeks), { active: 2, new_installs: 2, calling: 2, first_good: 2, calls: 3, ok_calls: 2 }, "weeks: d and w both");
  const tools = (await rowsOf(env, "tool_weeks")).find((r) => r.week === iso(edgeWeek));
  assert.deepEqual(tools && [tools.calls, tools.ok_calls], [3, 2], "tool_weeks");
  const errs = (await rowsOf(env, "error_weeks")).find((r) => r.week === iso(edgeWeek));
  assert.deepEqual(errs && [errs.error_class, errs.calls], ["site", 1], "error_weeks");
  const arms = (await rowsOf(env, "arm_weeks")).find((r) => r.week === iso(edgeWeek));
  assert.deepEqual(arms && [arms.arm, arms.installs, arms.good_call_7d], ["e", 1, 1], "arm_weeks");
  const cohort = (await rowsOf(env, "cohorts")).find((r) => r.week === iso(edgeWeek));
  assert.deepEqual(cohort && [cohort.installs, cohort.called, cohort.good_call_7d], [2, 2, 2], "cohorts");
  const calls = (await rowsOf(env, "calls")).filter((r) => r.day === iso(edge30));
  assert.equal(calls.reduce((n, r) => n + r.calls, 0), 1, "calls: the oldest of its 30 days is whole");
});

// PR #1002 review, round 4: funnel_by_from and arms read an install's first source tag after keeping only its real
// events, so an install whose `hn-e` start ran a staging build and whose stable calls came with no start of their own
// was `direct` and in no arm. What an install is (its source tag and arm, the list, the gate, a source build) is read
// once over all of its events, in the view, before any event is split real or ours by its version.
clocked("an install's source tag and arm are read over all its events: a tag sent on a staging start still attributes its stable calls", async () => {
  const { env } = store();
  const x = "a".repeat(32), t0 = Math.floor(NOW_MS / 1000 / H) * H - 5 * H;
  await postAt(env, at(x, t0, [[0, { ...START, version: "13.23.0-staging.4", from: "hn-e" }], [1, { version: "13.22.0" }]]));
  assert.deepEqual((await rowsOf(env, "funnel_by_from")).map((r) => [r.from_tag, r.installs, r.good_call]), [["hn-e", 1, 1]], "funnel_by_from");
  assert.deepEqual((await rowsOf(env, "arms")).map((r) => [r.arm, r.installs, r.good_call_7d]), [["e", 1, 1]], "arms");
  assert.deepEqual((await rowsOf(env, "arm_weeks")).map((r) => [r.who, r.arm, r.installs]), [["ours", "e", 1], ["real", "e", 1]], "arm_weeks");
  assert.equal((await (await handle(install(x), env)).json()).rows[0].from_tag, "hn-e", "install");
});

// PR #1002 review, round 4, and UNB-303 (docs/REQUIREMENTS.md): a source build (0.x) is a node built from a checkout,
// so all of that install is ours, as the install list, an internal tag and the gate are, whatever version it sends next.
clocked("an install that ever ran a source build is ours whole: its stable calls stay out of every real count", async () => {
  const { env } = store();
  const dev = "a".repeat(32), person = "b".repeat(32), t0 = Math.floor(NOW_MS / 1000 / H) * H - 3 * H;
  await postAt(env, [
    ...at(dev, t0, [[0, { version: "0.1.0" }], [1, { version: "13.22.0" }], [2, { version: "13.22.0", outcome: "failed", error_class: "site" }]]),
    ...at(person, t0, [[1, { version: "13.22.0" }]]),
  ].sort((a, b) => a[0] - b[0]));
  const sum = (rows, k) => rows.reduce((n, r) => n + r[k], 0);
  assert.equal(sum(await rowsOf(env, "installs"), "installs"), 1, "installs: the person alone");
  assert.equal(sum(await rowsOf(env, "calls"), "calls"), 1, "calls");
  assert.equal(sum(await rowsOf(env, "breaks"), "calls"), 0, "breaks");
  const rel = Object.fromEntries((await rowsOf(env, "releases")).map((r) => [`${r.version}|${r.who}`, r.calls]));
  assert.deepEqual(rel, { "13.22.0|real": 1, "13.22.0|ours": 2, "0.1.0|ours": 1 });
  assert.deepEqual((await rowsOf(env, "ours")).map((r) => [r.why, r.installs, r.calls]), [["source build", 1, 3]]);
});

// PR #1002 review, round 5: funnel kept 12 weeks by LIMIT while funnel_by_from rounded 84 days back to a Monday and
// kept 13, and questions bounded only the start of their window, so an event in an hour after the clock was counted.
// Every question reads its window from one clock helper (queries.sql `-- helper: clock`): questions over one span read
// the same start, and every one counts only events before the clock.
clocked("questions over one span agree on its weeks: the funnel and its source split, and the weekly questions", async () => {
  const { env } = store();
  const now = Math.floor(NOW_MS / 1000), d0 = Math.floor(now / D), week0 = (d0 - ((d0 + 3) % 7)) * D;
  const id = (k) => (k + 1).toString(16).padStart(32, "a");
  const timed = [];
  for (let k = 0; k < 30; k++) timed.push(...at(id(k), week0 - k * 7 * D, [[0, { ...START, from: "hn-e" }], [0, { tool: "unbrowse_do" }]]));
  await postAt(env, timed.sort((a, b) => a[0] - b[0]));
  const weeksOf = async (name, f = () => true) => [...new Set((await rowsOf(env, name)).filter(f).map((r) => r.week))].sort();
  const funnel = await weeksOf("funnel");
  assert.equal(funnel.length, 12, "funnel: 12 weeks, this one and the 11 before");
  assert.deepEqual(await weeksOf("funnel_by_from"), funnel, "funnel_by_from: the funnel's weeks");
  const weeks = await weeksOf("weeks", (r) => r.who === "real");
  assert.equal(weeks.length, 28, "weeks: this one and the 27 before");
  for (const name of ["cohorts", "tool_weeks", "arm_weeks"]) assert.deepEqual(await weeksOf(name, (r) => r.who === "real"), weeks, `${name}: the weeks' weeks`);
});

clocked("no question counts an event after the clock it is asked at", async () => {
  const { env } = store();
  const now = Math.floor(NOW_MS / 1000), d0 = Math.floor(now / D), week0 = (d0 - ((d0 + 3) % 7)) * D;
  const id = (k) => (k + 1).toString(16).padStart(32, "a");
  const timed = [];
  for (let k = 0; k < 30; k++) timed.push(...at(id(k), week0 - k * 7 * D, [[0, { ...START, from: "hn-e" }], [0, { tool: "unbrowse_do" }]]));
  await postAt(env, timed.sort((a, b) => a[0] - b[0]));
  const ask = (name) => (name === "install" ? `install?id=${id(0)}` : name === "period" ? "period?days=7" : name);
  const answers = async () => {
    const out = {};
    for (const name of Object.keys(namedQueries(QUERIES))) out[name] = (await (await handle(get(ask(name)), env)).json()).rows;
    return out;
  };
  const before = await answers();
  // Events in the hour after the clock and a day on: a new tagged install, more calls of an old one, one of ours.
  const next = (Math.floor(now / H) + 1) * H;
  for (const t of [next, next + D]) {
    const r = await handleAt(post([event({ install_id: "b".repeat(32), event: "node_start", tool: undefined, from: "hn-e" }),
      event({ install_id: "b".repeat(32) }), event({ install_id: id(0) }), event({ install_id: id(0), outcome: "failed", error_class: "site" }),
      event({ install_id: GATE }), event({ install_id: "c".repeat(32), version: "13.23.0-staging.1" })]), env, t * 1000);
    assert.equal(r.status, 204);
  }
  const after = await answers();
  for (const name of Object.keys(before)) assert.deepEqual(after[name], before[name], `${name} counted an event after the clock`);
});

// PR #1002 review, round 5: an install first seen in the 12:00 bucket was settled at 12:30 seven days on, while a good
// call stored in that day's 12:00 bucket could still arrive until 13:00 and count. Settled means the follow-up window
// is over by the clock: the first hour, 7 days, and the hour bucket the last qualifying call is kept in.
clocked("an arm's install is settled only once its whole 7 days of follow-up have passed by the clock", async () => {
  const { env } = store();
  const f = Math.floor(NOW_MS / 1000 / H) * H - 8 * D, x = "a".repeat(32);
  await postAt(env, at(x, f, [[0, { ...START, from: "hn-e" }], [24 * 7, { tool: "unbrowse_do" }]]));
  const armsAt = async (t) => (await (await handle(get("arms"), env, t * 1000)).json()).rows.map((r) => [r.installs, r.good_call_7d, r.settled, r.settled_good_call_7d]);
  const weeksAt = async (t) => (await (await handle(get("arm_weeks"), env, t * 1000)).json()).rows.map((r) => [r.installs, r.good_call_7d, r.settled, r.settled_good_call_7d]);
  const open = f + 7 * D + 30 * 60, over = f + 7 * D + H;
  assert.deepEqual(await armsAt(open), [[1, 1, 0, 0]], "arms: its last qualifying hour is still open");
  assert.deepEqual(await weeksAt(open), [[1, 1, 0, 0]], "arm_weeks: likewise");
  assert.deepEqual(await armsAt(over), [[1, 1, 1, 1]], "arms: settled once that hour is over");
  assert.deepEqual(await weeksAt(over), [[1, 1, 1, 1]], "arm_weeks: likewise");
});

// PR #1002 review, round 4: the questions read the clock the worker is asked at, bound as a value, so a test can pin it
// and a deployed worker answers by its own clock. A question that read SQLite's 'now' could not be pinned.
test("no question reads SQLite's own clock: every question that reads the time is asked at the worker's", () => {
  const q = namedQueries(QUERIES);
  for (const [name, sql] of Object.entries(q)) assert.ok(!/'now'/.test(sql), `${name} reads SQLite's 'now'`);
});

test("the time-sensitive questions answer alike at 00:30, 01:30 and 23:30 UTC, over a day's and a week's edge", async () => {
  const saved = NOW_MS;
  try {
    // Monday 23 November 2026 at 00:30 and 01:30 (a fixture a few hours back crosses the day and the week), and
    // Sunday 29 November at 23:30 (the last hour of a week).
    for (const clock of [Date.UTC(2026, 10, 23, 0, 30), Date.UTC(2026, 10, 23, 1, 30), Date.UTC(2026, 10, 29, 23, 30)]) {
      NOW_MS = clock;
      for (const [name, fn] of CLOCKED) {
        try {
          await fn();
        } catch (e) {
          e.message = `at ${new Date(clock).toISOString()}, ${name}: ${e.message}`;
          throw e;
        }
      }
    }
  } finally {
    NOW_MS = saved;
  }
});

test("every question reads the view `labelled`, never the events table, and takes an install's tag and arm from it", () => {
  for (const [name, sql] of Object.entries(namedQueries(QUERIES))) {
    // Round 5: through the clock helper alone, so every window starts at a `clock` column and ends at the clock.
    assert.ok(sql.startsWith(CLOCK), `${name} doesn't start with the clock helper`);
    const own = sql.slice(sql.indexOf("\nseen AS (") + 1).replace(/^seen AS \(.*\)/, "");
    assert.ok(!/\blabelled\b/.test(own), `${name} reads labelled past seen, so it can count events after the clock`);
    assert.ok(!/\b(FROM|JOIN)\s+events\b/i.test(sql), `${name} reads the events table`);
    assert.ok(!/\bfrom_tag\b/.test(sql.replace(/AS from_tag/g, "")), `${name} reads from_tag itself`);
  }
});
