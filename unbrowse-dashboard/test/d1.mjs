// A D1-shaped stand-in over node:sqlite, with the real migrations applied, so the store's SQL is what is tested.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => (db.prepare(sql).run(...args), { success: true }),
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    first: async () => {
      const r = db.prepare(sql).get(...args);
      return r ? { ...r } : null;
    },
  });
  return {
    prepare: (sql) => stmt(sql.replace(/\?(\d+)/g, "?")),
    batch: async (stmts) => {
      db.exec("BEGIN");
      try {
        for (const s of stmts) await s.run();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
