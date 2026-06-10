import { test, expect, beforeEach, afterEach } from "bun:test";
import { indexEndpoints } from "../src/services/discovery";

// Witness for the BM25 global-write fix: indexEndpoints must write the per-domain
// BM25 key (awaited) AND merge into the GLOBAL key (accumulate across publishes,
// dedup by id). Before the fix the global key was never written, so global
// /v1/search saw nothing and relied entirely on the degraded EmergentDB graph.

function fakeKV() {
  const m = new Map<string, string>();
  return {
    store: m,
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => { m.set(k, v); },
  };
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  // graph batch_insert → no-op OK so indexEndpoints completes past the KV writes
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const ep = (id: string, desc: string, url: string) =>
  ({ endpoint_id: id, description: desc, method: "GET", url_template: url });

test("indexEndpoints writes BOTH the per-domain and the GLOBAL bm25 key", async () => {
  const kv = fakeKV();
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  await indexEndpoints(env, "skillA",
    [ep("e1", "list posts", "https://jsonplaceholder.typicode.com/posts")],
    { domain: "jsonplaceholder.typicode.com" });

  expect(kv.store.has("bm25-idx:v2-jsonplaceholder.typicode.com")).toBe(true); // per-domain
  expect(kv.store.has("bm25-idx:v2-global")).toBe(true);                       // GLOBAL (the fix)
  const global = JSON.parse(kv.store.get("bm25-idx:v2-global")!);
  expect(global.length).toBe(1);
  expect(global[0].id).toBe("skillA:e1");
});

test("the GLOBAL key ACCUMULATES across publishes and DEDUPS by id", async () => {
  const kv = fakeKV();
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  // publish skillA (domain 1)
  await indexEndpoints(env, "skillA", [ep("e1", "list posts", "https://a.example/posts")], { domain: "a.example" });
  // publish skillB (domain 2) — global must now hold BOTH, not be overwritten
  await indexEndpoints(env, "skillB", [ep("e1", "list users", "https://b.example/users")], { domain: "b.example" });
  let global = JSON.parse(kv.store.get("bm25-idx:v2-global")!);
  expect(global.map((d: { id: string }) => d.id).sort()).toEqual(["skillA:e1", "skillB:e1"]);

  // re-publish skillA (same ids) — must DEDUP, not duplicate
  await indexEndpoints(env, "skillA", [ep("e1", "list posts v2", "https://a.example/posts")], { domain: "a.example" });
  global = JSON.parse(kv.store.get("bm25-idx:v2-global")!);
  expect(global.length).toBe(2);                                          // still 2, not 3
  const a = global.find((d: { id: string }) => d.id === "skillA:e1");
  expect(a.text).toContain("list posts v2");                             // newest version kept
});

// EDGE: endpoints with no description are filtered out — early return, no empty write.
test("edge: undescribed endpoints → early return, no global key written", async () => {
  const kv = fakeKV();
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  await indexEndpoints(env, "skillX",
    [{ endpoint_id: "e1", method: "GET", url_template: "https://x.example/" }] as never,
    { domain: "x.example" });
  expect(kv.store.size).toBe(0); // nothing indexed (no description) — no junk in the index
});

// EDGE: a malformed existing global value must not crash — recover to a clean write.
test("edge: malformed existing global JSON → recovers, writes clean", async () => {
  const kv = fakeKV();
  kv.store.set("bm25-idx:v2-global", "{not valid json");
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  await indexEndpoints(env, "skillA", [ep("e1", "list posts", "https://a.example/posts")], { domain: "a.example" });
  const global = JSON.parse(kv.store.get("bm25-idx:v2-global")!); // must parse now (recovered)
  expect(global.length).toBe(1);
  expect(global[0].id).toBe("skillA:e1");
});

// DEGRADED: when the graph (fetch) throws, the KV index must ALREADY be written — the
// whole point of the fix is KV-before-graph so search survives a down graph.
test("degraded: graph insert throws AFTER the KV index is already written", async () => {
  const kv = fakeKV();
  globalThis.fetch = (async () => { throw new Error("graph down"); }) as typeof fetch;
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  let threw = false;
  try {
    await indexEndpoints(env, "skillA", [ep("e1", "list posts", "https://a.example/posts")], { domain: "a.example" });
  } catch { threw = true; }
  expect(threw).toBe(true);                                  // graph failure surfaces
  expect(kv.store.has("bm25-idx:v2-global")).toBe(true);     // but KV index was written FIRST (search survives)
  expect(JSON.parse(kv.store.get("bm25-idx:v2-global")!)[0].id).toBe("skillA:e1");
});

// ADVERSARIAL: 50 domains churned through the global key — accumulates all, no loss, deduped.
test("adversarial: 50 publishes accumulate into the global key without loss", async () => {
  const kv = fakeKV();
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  for (let i = 0; i < 50; i++) {
    await indexEndpoints(env, `skill${i}`, [ep("e1", `task ${i}`, `https://d${i}.example/x`)], { domain: `d${i}.example` });
  }
  const global = JSON.parse(kv.store.get("bm25-idx:v2-global")!);
  expect(global.length).toBe(50);                            // every publish present, none clobbered
  expect(new Set(global.map((d: { id: string }) => d.id)).size).toBe(50); // all distinct
});
