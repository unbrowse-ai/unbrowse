// A tiny read-only SQLite reader: enough to SELECT every row of one table from a browser cookie database, with
// no native module or Node version floor. It parses the file format directly (the b-tree pages and record
// format) — https://www.sqlite.org/fileformat2.html. Only what cookie DBs use is handled: table b-trees,
// overflow pages, and the value serial types (null, ints, float, text, blob).

/** A row as column name → value. */
export type Row = Record<string, Value>;
export type Value = null | number | bigint | string | Uint8Array;

const HEADER = 100;

class Reader {
  private view: DataView;
  constructor(
    private buf: Uint8Array,
    readonly pageSize: number,
    readonly usable: number,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  page(n: number): { data: DataView; start: number } {
    const start = (n - 1) * this.pageSize;
    return { data: this.view, start };
  }
  u8(at: number): number {
    return this.view.getUint8(at);
  }
  u16(at: number): number {
    return this.view.getUint16(at);
  }
  u32(at: number): number {
    return this.view.getUint32(at);
  }
  slice(at: number, len: number): Uint8Array {
    return this.buf.subarray(at, at + len);
  }
}

/** A SQLite varint (1–9 bytes, big-endian, 7 bits per byte except the 9th). Returns the value and byte length. */
function varint(view: DataView, at: number): [bigint, number] {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    const byte = view.getUint8(at + i);
    result = (result << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return [result, i + 1];
  }
  const byte = view.getUint8(at + 8);
  return [(result << 8n) | BigInt(byte), 9];
}

/** Reassemble a cell's payload, following overflow pages when it does not fit on the page. */
function payload(r: Reader, at: number, total: number): Uint8Array {
  const usable = r.usable;
  const maxLocal = usable - 35;
  if (total <= maxLocal) return r.slice(at, total);
  const minLocal = ((usable - 12) * 32) / 255 - 23;
  let local = minLocal + ((total - minLocal) % (usable - 4));
  if (local > maxLocal) local = minLocal;
  local = Math.floor(local);
  const out = new Uint8Array(total);
  out.set(r.slice(at, local), 0);
  let filled = local;
  let overflow = r.u32(at + local);
  while (overflow !== 0 && filled < total) {
    const pageStart = (overflow - 1) * r.pageSize;
    const next = r.u32(pageStart);
    const take = Math.min(usable - 4, total - filled);
    out.set(r.slice(pageStart + 4, take), filled);
    filled += take;
    overflow = next;
  }
  return out;
}

/** Decode one record (the SQLite serial-type format) into its column values. */
function record(bytes: Uint8Array): Value[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [headerLen, n0] = varint(view, 0);
  const serials: bigint[] = [];
  let at = n0;
  while (at < Number(headerLen)) {
    const [t, len] = varint(view, at);
    serials.push(t);
    at += len;
  }
  const out: Value[] = [];
  let body = Number(headerLen);
  for (const s of serials) {
    const t = Number(s);
    if (t === 0) out.push(null);
    else if (t === 1) out.push(view.getInt8(body)), (body += 1);
    else if (t === 2) out.push(view.getInt16(body)), (body += 2);
    else if (t === 3) out.push((view.getInt8(body) << 16) | view.getUint16(body + 1)), (body += 3);
    else if (t === 4) out.push(view.getInt32(body)), (body += 4);
    else if (t === 5) out.push(readInt(view, body, 6)), (body += 6);
    else if (t === 6) out.push(readBig(view, body)), (body += 8);
    else if (t === 7) out.push(view.getFloat64(body)), (body += 8);
    else if (t === 8) out.push(0);
    else if (t === 9) out.push(1);
    else if (t >= 12 && t % 2 === 0) {
      const len = (t - 12) / 2;
      out.push(bytes.subarray(body, body + len));
      body += len;
    } else if (t >= 13) {
      const len = (t - 13) / 2;
      out.push(new TextDecoder().decode(bytes.subarray(body, body + len)));
      body += len;
    } else out.push(null);
  }
  return out;
}

function readInt(view: DataView, at: number, n: number): number {
  let v = view.getInt8(at);
  for (let i = 1; i < n; i++) v = v * 256 + view.getUint8(at + i);
  return v;
}
function readBig(view: DataView, at: number): number | bigint {
  const v = view.getBigInt64(at);
  return v >= -BigInt(Number.MAX_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

/** Walk a table b-tree from its root page, calling `emit` with every leaf cell's payload + rowid. */
function walk(r: Reader, root: number, emit: (rowid: bigint, payload: Uint8Array) => void): void {
  const pageStart = (root - 1) * r.pageSize;
  const headerAt = root === 1 ? pageStart + HEADER : pageStart;
  const type = r.u8(headerAt);
  const cells = r.u16(headerAt + 3);
  const cellPtrAt = headerAt + (type === 5 || type === 2 ? 12 : 8);
  for (let i = 0; i < cells; i++) {
    const ptr = r.u16(cellPtrAt + i * 2);
    const cellAt = pageStart + ptr;
    if (type === 5) {
      // interior table: 4-byte left child, then the key
      const child = r.u32(cellAt);
      walk(r, child, emit);
    } else if (type === 13) {
      // leaf table cell: payload length (varint), rowid (varint), payload
      const [len, n1] = varint(dvOf(r, cellAt), 0);
      const [rowid, n2] = varint(dvOf(r, cellAt + n1), 0);
      const pay = payload(r, cellAt + n1 + n2, Number(len));
      emit(rowid, pay);
    }
  }
  if (type === 5) {
    // rightmost child
    const right = r.u32(headerAt + 8);
    walk(r, right, emit);
  }
}

/** A DataView over the whole file, positioned so getUint8(0) reads byte `at`. */
function dvOf(r: Reader, at: number): DataView {
  const bytes = r.slice(at, Math.min(16, r.pageSize));
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Read every row of `table` as objects keyed by column name. */
export function readTable(file: Uint8Array, table: string): Row[] {
  if (new TextDecoder().decode(file.subarray(0, 15)) !== "SQLite format 3") throw new Error("not a SQLite database");
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const pageSize = view.getUint16(16) === 1 ? 65536 : view.getUint16(16);
  const reserved = view.getUint8(20);
  const r = new Reader(file, pageSize, pageSize - reserved);

  // sqlite_master is the b-tree rooted at page 1: rows are (type, name, tbl_name, rootpage, sql).
  let rootpage = 0;
  let sql = "";
  walk(r, 1, (_rowid, pay) => {
    const cols = record(pay);
    if (cols[0] === "table" && cols[1] === table) {
      rootpage = Number(cols[3]);
      sql = String(cols[4] ?? "");
    }
  });
  if (!rootpage) throw new Error(`no table "${table}"`);
  const columns = parseColumns(sql);

  const rows: Row[] = [];
  walk(r, rootpage, (rowid, pay) => {
    const values = record(pay);
    const row: Row = {};
    columns.forEach((name, i) => {
      // An INTEGER PRIMARY KEY column is stored as null in the record and equals the rowid.
      row[name] = values[i] === null && /integer/i.test(columns.types[i] ?? "") ? Number(rowid) : (values[i] ?? null);
    });
    rows.push(row);
  });
  return rows;
}

/** Column names (and declared types) from a CREATE TABLE statement. */
function parseColumns(sql: string): string[] & { types: string[] } {
  const inner = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
  const names: string[] = [];
  const types: string[] = [];
  let depth = 0;
  let cur = "";
  const parts: string[] = [];
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const part of parts) {
    const t = part.trim();
    if (/^(primary|unique|foreign|check|constraint)\b/i.test(t)) continue;
    const m = /^["`[]?([A-Za-z_][\w]*)["`\]]?\s*(.*)$/.exec(t);
    if (!m) continue;
    names.push(m[1]!);
    types.push(m[2] ?? "");
  }
  const out = names as string[] & { types: string[] };
  out.types = types;
  return out;
}
