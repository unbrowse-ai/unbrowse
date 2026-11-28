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
export const PARAMS = { install: [["id", /^[0-9a-f]{32}$/]], period: [["days", /^(7|30|90)$/]] };

/** Every question in queries.sql starts `WITH clock`, which `namedQueries` writes out as the file's one clock helper
    (`-- helper: clock`): the clock it is asked at, bound as its first value, every window's start read from it, and
    `seen`, the events before it. So questions over one span share one start, and none counts an event after the clock
    (PR #1002 review, round 5). A question written out so starts with this. */
export const CLOCK = "WITH clock AS (";

/** The values to bind for `sql` asked at `now` (milliseconds): the worker's clock, in Unix seconds, first when the
    question reads the time, then `values`. So every question answers by the worker's clock, never SQLite's own, and
    the same question asked at the same clock gives the same answer (PR #1002 review: tests pin it). The second is
    rounded up: an event kept before the request, in the hour that starts at h, has h before it, and one in a later
    hour starts at or after it, so `received_hour < now` keeps exactly the hours that began before the request. */
export function clocked(sql, now, values) {
  return sql.startsWith(CLOCK) ? [Math.ceil(now / 1000), ...values] : values;
}

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
  const [head, ...questions] = text.split(/^-- name: /m);
  const helpers = blocks(head.split(/^-- helper: /m).slice(1));
  const out = {};
  for (const [name, body] of Object.entries(blocks(questions))) {
    // `WITH <helper>` at the start of a question is that helper written out in its place.
    const use = body.match(/^WITH ([a-z_]+)(?=,|\s)(?!\s+AS\b)/);
    out[name] = use && Object.hasOwn(helpers, use[1]) ? `WITH ${helpers[use[1]]}${body.slice(use[0].length)}` : body;
  }
  return out;
}

/** Each block's first line is its name, and the rest up to its closing `;`, comment lines left out, its body. */
function blocks(list) {
  const out = {};
  for (const block of list) {
    const [name, ...rest] = block.split("\n");
    const body = rest.filter((l) => !l.startsWith("--")).join("\n").trim().replace(/;$/, "");
    if (/^[a-z_]+$/.test(name.trim()) && body) out[name.trim()] = body;
  }
  return out;
}
