// A stand-in for the worker's database on Node's own SQLite, loaded with ../schema.sql, so the worker's SQL runs as
// written. Only the calls the worker makes: prepare, bind, first, run, all and batch.
//
// With TELEMETRY_TEST_STORE=do the same tests go the deployed way: through ../src/sql.js's client to a stand-in for
// the TelemetryStore Durable Object, which runs each op with ../src/sql.js's execute over SQLite, a batch in one
// transaction. `npm test` runs both.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { client, execute } from "../src/sql.js";

/** `exec(sql, ...values)` over node:sqlite, shaped as a Durable Object's `storage.sql.exec`. */
export function sqlExec(db) {
  return (sql, ...values) => {
    const rows = db.prepare(sql).all(...values);
    const written = Number(db.prepare("SELECT changes() AS c").get().c);
    return { toArray: () => rows, rowsWritten: written };
  };
}

/** The TelemetryStore Durable Object, standing in: the same execute, a batch in one transaction. */
export function fakeStore(db, { fails = false, failOn = () => false } = {}) {
  const exec = sqlExec(db);
  const check = (sql) => {
    if (fails || failOn(sql)) throw new Error("the store is down");
  };
  return {
    async query(op) {
      check(op.sql);
      return execute(exec, op);
    },
    async batch(ops) {
      for (const op of ops) check(op.sql);
      db.exec("BEGIN");
      try {
        const out = ops.map((op) => execute(exec, op));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

/** `fails`: every call throws, as the store down. `failOn(sql)`: the calls whose SQL it says yes to throw. */
export function d1({ fails = false, failOn = () => false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const rows = (sql, ...values) => db.prepare(sql).all(...values);
  if (process.env.TELEMETRY_TEST_STORE === "do") return { sqlite: db, ...client(fakeStore(db, { fails, failOn })), rows };
  const statement = (sql, values = []) => ({
    sql,
    values,
    bind: (...v) => statement(sql, v),
    async first() {
      if (fails || failOn(sql)) throw new Error("D1 is down");
      return db.prepare(sql).get(...values) ?? null;
    },
    async run() {
      if (fails || failOn(sql)) throw new Error("D1 is down");
      const r = db.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
    async all() {
      if (fails || failOn(sql)) throw new Error("D1 is down");
      return { results: db.prepare(sql).all(...values) };
    },
  });
  return {
    sqlite: db,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    rows,
  };
}
