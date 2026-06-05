/**
 * Runtime-agnostic SQLite driver — the bun:sqlite surface we use, backed by
 * Node's built-in `node:sqlite` so the readable runtime runs on plain Node
 * (no Bun). Only the read-only cookie/history inventory paths touch this, and
 * they are all best-effort: if the driver is unavailable (very old Node, or
 * the experimental module is disabled) construction throws and every caller
 * already degrades to an empty result.
 *
 * API kept intentionally tiny — exactly what auth-inventory-sources use:
 *   new Database(uri, { readonly: true })
 *   db.query<Row>(sql).all() / .get()
 *   db.close()
 */

interface NodeStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface NodeDatabase {
  prepare(sql: string): NodeStatement;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => NodeDatabase;
}

let cachedModule: NodeSqliteModule | null | undefined;
function loadDriver(): NodeSqliteModule {
  if (cachedModule === undefined) {
    try {
      // Lazy: never loaded unless a cookie/history read actually runs. On Bun
      // (dev) and Node >= 22.5 this resolves; otherwise it throws and the
      // best-effort callers swallow it.
      cachedModule = require("node:sqlite") as NodeSqliteModule;
    } catch {
      cachedModule = null;
    }
  }
  if (!cachedModule) throw new Error("node:sqlite unavailable (need Node >= 22.5)");
  return cachedModule;
}

export interface Statement<Row = Record<string, unknown>> {
  all(): Row[];
  get(): Row | undefined;
}

export class Database {
  #db: NodeDatabase;

  /**
   * Accepts the bun:sqlite signature. We open the underlying file read-only;
   * the `file:...?mode=ro&immutable=1` URI form bun used is reduced to a plain
   * path (node:sqlite does not parse URIs) — locked-DB safety is preserved by
   * the callers' existing copy-to-temp fallback.
   */
  constructor(uri: string, _options?: { readonly?: boolean }) {
    const path = uri.replace(/^file:/, "").replace(/\?.*$/, "");
    const { DatabaseSync } = loadDriver();
    this.#db = new DatabaseSync(path, { readOnly: true });
  }

  query<Row = Record<string, unknown>, _Params = unknown[]>(sql: string): Statement<Row> {
    const stmt = this.#db.prepare(sql);
    return {
      all: () => stmt.all() as Row[],
      get: () => stmt.get() as Row | undefined,
    };
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      /* already closed / never opened */
    }
  }
}
