/**
 * Runtime-agnostic SQLite driver — the tiny `bun:sqlite` surface we use,
 * backed by Bun's built-in driver when available and Node's built-in
 * `node:sqlite` otherwise. Only the read-only cookie/history inventory paths
 * touch this, and they are all best-effort: if no driver is available,
 * construction throws and every caller already degrades to an empty result.
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
interface BunDatabase {
  query(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}
interface BunSqliteModule {
  Database: new (location: string, options?: { readonly?: boolean; readwrite?: boolean }) => BunDatabase;
}

type Driver =
  | { kind: "bun"; module: BunSqliteModule }
  | { kind: "node"; module: NodeSqliteModule };

let cachedDriver: Driver | null | undefined;
function loadDriver(): Driver {
  if (cachedDriver === undefined) {
    try {
      cachedDriver = {
        kind: "bun",
        module: require("bun:sqlite") as BunSqliteModule,
      };
      return cachedDriver;
    } catch {
      // Not Bun, or Bun's SQLite module is unavailable. Try Node next.
    }
    try {
      // Lazy: never loaded unless a cookie/history read actually runs. On
      // Node >= 22.5 this resolves; otherwise it throws and the best-effort
      // callers swallow it.
      cachedDriver = {
        kind: "node",
        module: require("node:sqlite") as NodeSqliteModule,
      };
    } catch {
      cachedDriver = null;
    }
  }
  if (!cachedDriver) {
    throw new Error("sqlite unavailable (need bun:sqlite or Node >= 22.5 node:sqlite)");
  }
  return cachedDriver;
}

export interface Statement<Row = Record<string, unknown>> {
  all(): Row[];
  get(): Row | undefined;
}

export class Database {
  #db: NodeDatabase | BunDatabase;
  #driverKind: Driver["kind"];

  /**
   * Accepts the bun:sqlite signature. We open the underlying file read-only;
   * the `file:...?mode=ro&immutable=1` URI form bun used is reduced to a plain
   * path (node:sqlite does not parse URIs) — locked-DB safety is preserved by
   * the callers' existing copy-to-temp fallback.
   */
  constructor(uri: string, _options?: { readonly?: boolean }) {
    const path = uri.replace(/^file:/, "").replace(/\?.*$/, "");
    const driver = loadDriver();
    this.#driverKind = driver.kind;
    if (driver.kind === "bun") {
      this.#db = new driver.module.Database(path, { readonly: true });
    } else {
      this.#db = new driver.module.DatabaseSync(path, { readOnly: true });
    }
  }

  query<Row = Record<string, unknown>, _Params = unknown[]>(sql: string): Statement<Row> {
    if (this.#driverKind === "bun") {
      const stmt = (this.#db as BunDatabase).query(sql);
      return {
        all: () => stmt.all() as Row[],
        get: () => stmt.get() as Row | undefined,
      };
    }
    const stmt = (this.#db as NodeDatabase).prepare(sql);
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
