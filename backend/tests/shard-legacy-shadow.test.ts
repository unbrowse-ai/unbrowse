import { test, expect, beforeEach, afterEach } from "bun:test";
import { indexEndpoints, searchIntent, __resetSearchCacheForTests } from "../src/services/discovery";

// Witness for the shard-vs-legacy shadow fix. A skill in the legacy global key
// (published pre-shard) re-published post-shard now lives in a shard with FRESH text.
// bm25SearchGlobal dedups by first-seen id; reading shards FIRST keeps the fresh shard
// version. Discriminator: a query term ("delivery") present ONLY in the fresh shard text
// — under the bug (legacy-first) the stale legacy doc wins dedup and scores 0 on it, so
// the skill is NOT returned; under the fix it IS.

function fakeKV() {
  const m = new Map<string, string>();
  return { store: m, get: async (k: string) => (m.has(k) ? m.get(k)! : null), put: async (k: string, v: string) => { m.set(k, v); } };
}
const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = (async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch; __resetSearchCacheForTests(); });
afterEach(() => { globalThis.fetch = realFetch; __resetSearchCacheForTests(); });
const ep = (id: string, desc: string, url: string) => ({ endpoint_id: id, description: desc, method: "GET", url_template: url });

test("re-published shard version shadows the stale legacy doc (fresh text wins, not old)", async () => {
  const kv = fakeKV();
  const e = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  // Pre-shard publish sitting in the LEGACY key — its text lacks the word "delivery".
  kv.store.set("bm25-idx:v2-global", JSON.stringify([
    { id: "skillP:e1", text: "old stale pizza menu listing [GET /menu]", metadata: { skill_id: "skillP", content: JSON.stringify({ skill_id: "skillP", endpoint_id: "e1", domain: "p.example" }) } },
  ]));
  // Re-publish post-shard → shard, NEW text that DOES contain "delivery".
  await indexEndpoints(e, "skillP", [ep("e1", "fresh pizza menu with delivery tracking", "https://p.example/menu")], { domain: "p.example" });
  __resetSearchCacheForTests();

  // "delivery" is ONLY in the fresh shard text. If the stale legacy doc shadows it (the
  // bug), this query scores 0 and returns nothing; with the fix the shard doc is kept.
  const ids = (await searchIntent(e, "delivery tracking", 5)).map((r) => String(r.id));
  expect(ids).toContain("skillP:e1");
});
