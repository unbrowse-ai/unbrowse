import { test, expect, mock, afterAll } from "bun:test";
// Capture the real kv + emergentdb modules before mocking. mock.module is global
// and mock.restore() does not undo it, so afterAll must re-install the real
// modules or these stubs leak into every sibling file (spread keeps unlisted
// exports real during this file too).
import * as _realKv from "../src/services/kv.js";
import * as _realEdb from "../src/services/emergentdb.js";
const _REAL_KV = { ..._realKv };
const _REAL_EDB = { ..._realEdb };

// Witness for the server-side seed (services/bible-anchor.ts seedBibleChaptersBatch,
// the engine behind POST /v1/ops/seed-bible-chapters). The substrate is mocked: it
// proves a chapter batch is Nebius-embedded, /vectors/insert'd, and the KV sidecar
// maps each content-addressed vector id back to {idx, ref} — and that a failed embed
// is COUNTED, never thrown (a partial batch still records what it could).

const puts: Record<string, string> = {};
// Faithful to the real LocalKV/EdbKV surface. Bun's mock.module is GLOBAL and
// does NOT auto-restore between files, so an INCOMPLETE stub here leaks into
// every later test that calls statsKV(env).{delete,listWithValues,resetSplitIndex,…}
// → "not a function" across the suite. A complete surface keeps the leak harmless.
const kvSurface = {
  get: async (k: string, type?: "json") => {
    const v = puts[k] ?? null;
    if (v == null) return null;
    return type === "json" ? JSON.parse(v) : v;
  },
  put: async (k: string, v: string) => { puts[k] = v; },
  putBatch: async (pairs: Array<{ key: string; value: string }>) => {
    for (const { key, value } of pairs) puts[key] = value;
  },
  delete: async (k: string) => { delete puts[k]; },
  list: async ({ prefix, limit, cursor }: { prefix: string; limit?: number; cursor?: string }) => {
    const keys = Object.keys(puts).filter((k) => k.startsWith(prefix));
    const off = cursor ? parseInt(cursor, 10) : 0;
    const lim = limit ?? 1000;
    const page = keys.slice(off, off + lim);
    const done = off + lim >= keys.length;
    return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(off + lim) };
  },
  listWithValues: async (prefix: string) =>
    Object.entries(puts).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ name: k, key: k, value: v })),
  resetSplitIndex: async () => { delete puts["_idx"]; delete puts["_idx:main"]; delete puts["_idx:large"]; },
};
mock.module("../src/services/kv.js", () => ({
  ..._REAL_KV,
  statsKV: () => kvSurface,
  kvBackend: () => "unconfigured" as const,
}));

let assignedId = 5000; // IQ assigns its own content-addressed id on insert/search
mock.module("../src/services/emergentdb.js", () => ({
  ..._REAL_EDB,
  emergentDBRequest: async (_e: unknown, _m: string, path: string) => {
    if (path === "/vectors/insert") return { success: true };
    if (path === "/vectors/search") return { results: [{ id: assignedId++, score: 1.0 }] };
    return {};
  },
}));
afterAll(() => {
  mock.module("../src/services/kv.js", () => _REAL_KV);
  mock.module("../src/services/emergentdb.js", () => _REAL_EDB);
  mock.restore();
});

function embedOK() {
  // Batch-aware: return one embedding PER input (embedBatch sends input[]).
  globalThis.fetch = (async (url: unknown, opts?: { body?: string }) => {
    if (!String(url).includes("nebius")) return new Response("no", { status: 404 });
    const input = JSON.parse(opts?.body ?? "{}").input as string[] | string;
    const n = Array.isArray(input) ? input.length : 1;
    const data = Array.from({ length: n }, (_, i) => ({ index: i, embedding: new Array(1536).fill(0.01) }));
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}

const { seedBibleChaptersBatch } = await import("../src/services/bible-anchor.js");

test("seedBibleChaptersBatch inserts vectors + writes KV sidecar idx->ref", async () => {
  embedOK();
  for (const k of Object.keys(puts)) delete puts[k];
  const env = { EMERGENTDB_API_KEY: "k", NEBIUS_API_KEY: "n" } as never;
  const r = await seedBibleChaptersBatch(env, [
    { idx: 0, ref: "Genesis 1", text: "in the beginning God created" },
    { idx: 1100, ref: "1 John 4", text: "love one another" },
  ]);
  expect(r.seeded).toBe(2);
  expect(r.failed).toBe(0);
  const sidecars = Object.entries(puts).filter(([k]) => k.startsWith("bible-vec:"));
  expect(sidecars.length).toBe(2);
  const metas = sidecars.map(([, v]) => JSON.parse(v));
  expect(metas).toContainEqual({ idx: 0, ref: "Genesis 1" });
  expect(metas).toContainEqual({ idx: 1100, ref: "1 John 4" });
});

test("a chapter whose embed fails is counted, not thrown (partial batch survives)", async () => {
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  const env = { EMERGENTDB_API_KEY: "k", NEBIUS_API_KEY: "n" } as never;
  const r = await seedBibleChaptersBatch(env, [{ idx: 5, ref: "Ruth 1", text: "whither thou goest" }]);
  expect(r.seeded).toBe(0);
  expect(r.failed).toBe(1);
  expect(r.total).toBe(1);
});
