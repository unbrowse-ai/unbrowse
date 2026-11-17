// The worker's storage is one SQLite Durable Object (./store.js), reached through a client shaped like the part of
// D1's API the worker uses (prepare, bind, first, run, all, batch), so ./index.js runs the same SQL on either.
// Both halves here are plain functions, so Node's tests run them over node:sqlite.

/** One statement as it crosses to the store: its SQL, its values, and what the caller wants back. */
const op = (sql, values, mode) => ({ sql, values: values.map((v) => (v === undefined ? null : v)), mode });

/** A D1-shaped database whose calls go to `store`, an object with `query(op)` and `batch(ops)` (the DO's stub). */
export function client(store) {
  const statement = (sql, values = []) => ({
    sql,
    values,
    bind: (...v) => statement(sql, v),
    first: () => store.query(op(sql, values, "first")),
    run: () => store.query(op(sql, values, "run")),
    all: () => store.query(op(sql, values, "all")),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: (statements) => store.batch(statements.map((s) => op(s.sql, s.values, "run"))),
  };
}

/** Runs one op on `exec(sql, ...values)` (a Durable Object's `storage.sql.exec`) and answers as D1 would. */
export function execute(exec, { sql, values = [], mode = "run" }) {
  const cursor = exec(sql, ...values);
  const rows = cursor.toArray();
  if (mode === "first") return rows[0] ?? null;
  if (mode === "all") return { results: rows };
  return { success: true, meta: { changes: cursor.rowsWritten ?? 0 } };
}

/** The named questions in queries.sql: each `-- name: <name>` line starts one, up to its closing `;`. */
export function namedQueries(text) {
  const out = {};
  for (const block of text.split(/^-- name: /m).slice(1)) {
    const [name, ...rest] = block.split("\n");
    const body = rest.filter((l) => !l.startsWith("--")).join("\n").trim().replace(/;$/, "");
    if (/^[a-z_]+$/.test(name.trim()) && body) out[name.trim()] = body;
  }
  return out;
}
