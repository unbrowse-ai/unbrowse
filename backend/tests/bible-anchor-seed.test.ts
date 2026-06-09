import { test, expect, mock } from "bun:test";

// Witness for the server-side seed (services/bible-anchor.ts seedBibleChaptersBatch,
// the engine behind POST /v1/ops/seed-bible-chapters). The substrate is mocked: it
// proves a chapter batch is Nebius-embedded, /vectors/insert'd, and the KV sidecar
// maps each content-addressed vector id back to {idx, ref} — and that a failed embed
// is COUNTED, never thrown (a partial batch still records what it could).

const puts: Record<string, string> = {};
mock.module("../src/services/kv.js", () => ({
  statsKV: () => ({
    get: async (k: string) => puts[k] ?? null,
    put: async (k: string, v: string) => { puts[k] = v; },
  }),
}));

let assignedId = 5000; // IQ assigns its own content-addressed id on insert/search
mock.module("../src/services/emergentdb.js", () => ({
  emergentDBRequest: async (_e: unknown, _m: string, path: string) => {
    if (path === "/vectors/insert") return { success: true };
    if (path === "/vectors/search") return { results: [{ id: assignedId++, score: 1.0 }] };
    return {};
  },
}));

function embedOK() {
  globalThis.fetch = (async (url: unknown) =>
    String(url).includes("nebius")
      ? new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.01) }] }), { status: 200 })
      : new Response("no", { status: 404 })) as typeof fetch;
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
