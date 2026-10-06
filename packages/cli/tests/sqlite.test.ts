import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readTable } from "../src/sqlite.ts";

function build(rows: number, big = 50): Uint8Array {
  const path = `/tmp/ub-sqlite-${Math.random().toString(36).slice(2)}.db`;
  const db = new Database(path);
  db.run("create table cookies(id integer primary key, host_key text, name text, encrypted_value blob, path text, is_secure integer)");
  const ins = db.prepare("insert into cookies(host_key,name,encrypted_value,path,is_secure) values(?,?,?,?,?)");
  for (let i = 0; i < rows; i++) ins.run(`.site${i % 30}.com`, `c${i}`, Buffer.alloc(i % big === 0 ? 9000 : 20 + (i % 40), i % 256), `/p${i}`, i % 2);
  db.close();
  const bytes = new Uint8Array(require("node:fs").readFileSync(path));
  require("node:fs").rmSync(path);
  return bytes;
}

test("reads every row of a small table with the right columns", () => {
  const rows = readTable(build(12), "cookies");
  expect(rows.length).toBe(12);
  expect(rows[0]).toHaveProperty("host_key");
  expect(rows[0]!.name).toBe("c0");
  expect((rows[0]!.encrypted_value as Uint8Array)[0]).toBe(0);
  expect(rows[0]!.id).toBe(1); // INTEGER PRIMARY KEY = rowid
});

test("handles interior b-tree pages and overflow blobs across thousands of rows", () => {
  const rows = readTable(build(4000), "cookies");
  expect(rows.length).toBe(4000);
  const overflow = rows.filter((r) => (r.encrypted_value as Uint8Array).length === 9000);
  expect(overflow.length).toBe(80);
  for (const r of rows) {
    const i = (r.id as number) - 1;
    expect(r.host_key).toBe(`.site${i % 30}.com`);
    expect((r.encrypted_value as Uint8Array).length).toBe(i % 50 === 0 ? 9000 : 20 + (i % 40));
  }
}, 30_000); // builds a 4000-row database: 7–10 s on a 2-vCPU CI runner

test("throws on a non-SQLite file and a missing table", () => {
  expect(() => readTable(new Uint8Array([1, 2, 3]), "cookies")).toThrow(/SQLite/);
  expect(() => readTable(build(1), "nope")).toThrow(/no table/);
});
