import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker, { handle, hourOf } from "../src/index.js";
import * as schema from "../src/schema.js";

const ID = "0123456789abcdef0123456789abcdef";
const event = (over = {}) => ({
  event: "tool_call",
  version: "1.4.2",
  os: "macos",
  install_id: ID,
  tool: "unbrowse_do",
  outcome: "ok",
  duration_ms: 120,
  ...over,
});

/** A D1 stand-in that keeps each bound row. */
function fakeDb({ fails = false } = {}) {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return { sql, bind: (...values) => ({ sql, values }) };
    },
    async batch(statements) {
      if (fails) throw new Error("D1 is down");
      for (const s of statements) rows.push(s.values);
      return statements.map(() => ({ success: true }));
    },
  };
}

function post(body, headers = {}) {
  return new Request("https://telemetry.unbrowse.ai/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("a valid batch is kept, one row per event, with its fields and the hour", async () => {
  const db = fakeDb();
  const now = Date.UTC(2026, 9, 29, 13, 47, 12);
  const r = await handle(post({ events: [event(), event({ event: "node_start", tool: undefined, duration_ms: undefined })] }), { TELEMETRY_DB: db }, now);
  assert.equal(r.status, 204);
  assert.equal(db.rows.length, 2);
  assert.deepEqual(db.rows[0], [hourOf(now), "tool_call", "1.4.2", "macos", ID, "unbrowse_do", "ok", 120, null]);
  assert.deepEqual(db.rows[1], [hourOf(now), "node_start", "1.4.2", "macos", ID, null, "ok", null, null]);
  assert.equal(hourOf(now), Date.UTC(2026, 9, 29, 13) / 1000);
});

test("a field not on the list refuses the batch, and nothing is kept", async () => {
  for (const field of ["url", "host", "ip", "cookie", "body", "user", "name"]) {
    const db = fakeDb();
    const r = await handle(post({ events: [event(), event({ [field]: "x" })] }), { TELEMETRY_DB: db });
    assert.equal(r.status, 400, field);
    assert.equal((await r.json()).error, `event 1: field not allowed: ${field}`);
    assert.equal(db.rows.length, 0, field);
  }
  const db = fakeDb();
  const r = await handle(post({ events: [event()], ip: "1.2.3.4" }), { TELEMETRY_DB: db });
  assert.equal(r.status, 400);
  assert.equal(db.rows.length, 0);
});

test("a value that looks like an address is refused", async () => {
  for (const v of [
    "https://hn.algolia.com/?q=rust",
    "hn.algolia.com",
    "www.example.co.uk",
    "localhost:7788",
    "10.0.0.1",
    "::1",
    "lewis@unbrowse.ai",
    "/v1/routes/abc?x=1",
    "a b",
  ]) {
    assert.ok(schema.urlLike(v), v);
    for (const field of ["tool", "event", "outcome", "error_class", "os", "version", "install_id"]) {
      const db = fakeDb();
      const r = await handle(post({ events: [event({ [field]: v })] }), { TELEMETRY_DB: db });
      assert.equal(r.status, 400, `${field}=${v}`);
      assert.equal((await r.json()).error, `event 0: ${field} looks like an address`);
      assert.equal(db.rows.length, 0);
    }
  }
  for (const v of ["1.4.2", "1.0.0-rc.1", "/v1/routes/{id}/call", "unbrowse_do", ID]) assert.ok(!schema.urlLike(v), v);
});

test("values off their lists, or of the wrong shape, are refused", () => {
  const bad = [
    { tool: "unbrowse_vault" },
    { event: "page_view" },
    { outcome: "maybe" },
    { error_class: "timeout_at_example" },
    { os: "ios" },
    { version: "latest" },
    { install_id: "not-hex" },
    { install_id: ID.toUpperCase() },
    { duration_ms: -1 },
    { duration_ms: 1.5 },
    { duration_ms: schema.MAX_DURATION_MS + 1 },
    { duration_ms: "120" },
    { tool: 7 },
  ];
  for (const over of bad) assert.ok(schema.check(event(over)), JSON.stringify(over));
  const missing = event();
  delete missing.install_id;
  assert.equal(schema.check(missing), "missing field: install_id");
  assert.equal(schema.check(event()), null);
});

test("a batch is bounded in events and in bytes", async () => {
  const db = fakeDb();
  let r = await handle(post({ events: Array.from({ length: schema.MAX_EVENTS + 1 }, () => event()) }), { TELEMETRY_DB: db });
  assert.equal(r.status, 400);
  r = await handle(post({ events: [] }), { TELEMETRY_DB: db });
  assert.equal(r.status, 400);
  r = await handle(post(" ".repeat(schema.MAX_BODY_BYTES + 1)), { TELEMETRY_DB: db });
  assert.equal(r.status, 413);
  assert.equal(db.rows.length, 0);
});

test("the caller's address and headers are never kept", async () => {
  const db = fakeDb();
  const r = await handle(
    post({ events: [event()] }, { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9", "user-agent": "unbrowse-node/1.4.2 (host-a)" }),
    { TELEMETRY_DB: db },
  );
  assert.equal(r.status, 204);
  const kept = JSON.stringify(db.rows);
  assert.ok(!kept.includes("203.0.113.9"));
  assert.ok(!kept.includes("host-a"));
  assert.equal(db.rows[0].length, 9, "the hour and the eight fields, nothing more");
  // The worker reads no header but the body's type and length, and a report's key and signature; the stats door alone reads the admin's token.
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const door = src.slice(src.indexOf("async function stats("), src.indexOf("export default {"));
  const outside = src.replace(door, "");
  const read = (s) => [...s.matchAll(/headers\.get\("([^"]+)"\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(read(outside), ["content-length", "content-type", "x-unbrowse-key", "x-unbrowse-signature"]);
  assert.deepEqual(read(door), ["authorization"]);
});

test("only POST /v1/events with JSON is answered", async () => {
  const env = { TELEMETRY_DB: fakeDb() };
  assert.equal((await worker.fetch(new Request("https://telemetry.unbrowse.ai/"), env)).status, 404);
  assert.equal((await handle(new Request("https://telemetry.unbrowse.ai/v1/events"), env)).status, 405);
  assert.equal((await handle(post("{", {}), env)).status, 400);
  assert.equal((await handle(post({ events: [event()] }, { "content-type": "text/plain" }), env)).status, 415);
});

test("a store that's down refuses the batch; the node drops it", async () => {
  const r = await handle(post({ events: [event()] }), { TELEMETRY_DB: fakeDb({ fails: true }) });
  assert.equal(r.status, 503);
});

test("the worker's lists are the shared schema's", () => {
  const shared = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.FIELDS, shared.fields);
  assert.deepEqual(schema.REQUIRED, shared.required);
  assert.deepEqual(schema.EVENTS, shared.events);
  assert.deepEqual(schema.TOOLS, shared.tools);
  assert.deepEqual(schema.OUTCOMES, shared.outcomes);
  assert.deepEqual(schema.ERROR_CLASSES, shared.error_classes);
  assert.deepEqual(schema.OSES, shared.oses);
  assert.equal(schema.MAX_DURATION_MS, shared.max_duration_ms);
  assert.equal(schema.MAX_EVENTS, shared.max_events);
  assert.equal(schema.MAX_BODY_BYTES, shared.max_body_bytes);
});
