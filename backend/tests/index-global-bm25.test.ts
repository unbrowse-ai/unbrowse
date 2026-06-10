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
