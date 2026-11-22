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

/** Columns added to a table after a store was first made: CREATE TABLE IF NOT EXISTS leaves a table that is already
    there as it was, so each is added here when it is missing. */
export const ADDED_COLUMNS = [{ table: "events", column: "from_tag", type: "TEXT" }];

/** Brings a store made from an older schema.sql up to this one, on `exec(sql, ...values)`: adds each missing column.
    Safe to run on every start: a column already there is left alone, and one added meanwhile is not an error. */
export function migrate(exec) {
  for (const { table, column, type } of ADDED_COLUMNS) {
    const has = exec(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`, column).toArray().length > 0;
    if (has) continue;
    try {
      exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (e) {
      if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
    }
  }
}

/** The questions that take values from the caller's query string, each value's name and the one shape it may have,
    in the order the question's `?`s bind them. A value is only ever bound, never written into the SQL; a missing one,
    or one off its shape, is refused before the store is asked. */
export const PARAMS = { install: [["id", /^[0-9a-f]{32}$/]] };

/** The values to bind for question `name` from `search` (a URLSearchParams), or { error } when one is missing or off
    its shape. A question that takes none binds none, whatever the query string says. */
export function bindings(name, search) {
  const values = [];
  for (const [key, shape] of PARAMS[name] ?? []) {
    const v = search.get(key);
    if (v === null || v === "") return { error: `${name} needs ?${key}=` };
    if (!shape.test(v)) return { error: `${key} is not an allowed value` };
    values.push(v);
  }
  return { values };
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
