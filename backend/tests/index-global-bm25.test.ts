import { test, expect, beforeEach, afterEach } from "bun:test";
import { indexEndpoints, hashToInt } from "../src/services/discovery";

// Witness for the BM25 global index: indexEndpoints writes the per-domain BM25 key AND
// merges into the SHARDED global index (16 shards by hash(skillId), + a legacy single
// key for pre-shard back-compat). Sharding keeps any one KV value far under CF's 25MB
// cap (the single global key broke at ~7.4k skills) while still accumulating + dedup-ing.

function fakeKV() {
  const m = new Map<string, string>();
  return {
    store: m,
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => { m.set(k, v); },
  };
}

// Union all global docs across every shard + the legacy key — mirrors the search read
// (globalReadKeys). This is how /v1/search sees the global index.
function globalDocs(store: Map<string, string>): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const [k, v] of store) {
    if (k === "bm25-idx:v2-global" || k.startsWith("bm25-idx:v2-global:s")) {
      try { out.push(...JSON.parse(v)); } catch { /* skip corrupt */ }
    }
  }
  return out;
}
// Replicate the production shard key for a skillId (shardForId = hashToInt % 16).
const shardKeyFor = (skillId: string) => `bm25-idx:v2-global:s${(hashToInt(skillId) % 16).toString(16)}`;
const globalShardKeysUsed = (store: Map<string, string>) =>
  [...store.keys()].filter((k) => k.startsWith("bm25-idx:v2-global:s"));

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const ep = (id: string, desc: string, url: string) =>
  ({ endpoint_id: id, description: desc, method: "GET", url_template: url });

test("indexEndpoints writes the per-domain key AND a global SHARD (not the monolithic key)", async () => {
  const kv = fakeKV();
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  await indexEndpoints(env, "skillA",
    [ep("e1", "list posts", "https://jsonplaceholder.typicode.com/posts")],
    { domain: "jsonplaceholder.typicode.com" });

  expect(kv.store.has("bm25-idx:v2-jsonplaceholder.typicode.com")).toBe(true); // per-domain
  expect(kv.store.has(shardKeyFor("skillA"))).toBe(true);                      // the skill's shard
  expect(kv.store.has("bm25-idx:v2-global")).toBe(false);                      // NOT the monolithic key
  const docs = globalDocs(kv.store);
  expect(docs.length).toBe(1);
  expect(docs[0].id).toBe("skillA:e1");
});

test("the global index ACCUMULATES across publishes and DEDUPS by id (across shards)", async () => {
  const kv = fakeKV();
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  await indexEndpoints(env, "skillA", [ep("e1", "list posts", "https://a.example/posts")], { domain: "a.example" });
  await indexEndpoints(env, "skillB", [ep("e1", "list users", "https://b.example/users")], { domain: "b.example" });
  expect(globalDocs(kv.store).map((d) => d.id).sort()).toEqual(["skillA:e1", "skillB:e1"]);

  // re-publish skillA (same ids) — must DEDUP within its shard, not duplicate
  await indexEndpoints(env, "skillA", [ep("e1", "list posts v2", "https://a.example/posts")], { domain: "a.example" });
  const docs = globalDocs(kv.store);
  expect(docs.length).toBe(2);                                            // still 2, not 3
  expect(docs.find((d) => d.id === "skillA:e1")!.text).toContain("list posts v2"); // newest kept
});

test("edge: undescribed endpoints → early return, nothing written", async () => {
  const kv = fakeKV();
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  await indexEndpoints(env, "skillX",
    [{ endpoint_id: "e1", method: "GET", url_template: "https://x.example/" }] as never,
    { domain: "x.example" });
  expect(kv.store.size).toBe(0);
});

test("edge: a malformed existing shard → recovers, writes clean", async () => {
  const kv = fakeKV();
  kv.store.set(shardKeyFor("skillA"), "{not valid json"); // corrupt the shard skillA lands in
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  await indexEndpoints(env, "skillA", [ep("e1", "list posts", "https://a.example/posts")], { domain: "a.example" });
  const docs = globalDocs(kv.store);
  expect(docs.length).toBe(1);
  expect(docs[0].id).toBe("skillA:e1");
});

test("degraded: graph insert throws AFTER the KV shard is already written", async () => {
  const kv = fakeKV();
  globalThis.fetch = (async () => { throw new Error("graph down"); }) as typeof fetch;
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  let threw = false;
  try {
    await indexEndpoints(env, "skillA", [ep("e1", "list posts", "https://a.example/posts")], { domain: "a.example" });
  } catch { threw = true; }
  expect(threw).toBe(true);                                  // graph failure surfaces
  expect(kv.store.has(shardKeyFor("skillA"))).toBe(true);    // but KV shard was written FIRST
  expect(globalDocs(kv.store)[0].id).toBe("skillA:e1");
});

test("adversarial: 50 publishes accumulate without loss, SPREAD across multiple shards", async () => {
  const kv = fakeKV();
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  for (let i = 0; i < 50; i++) {
    await indexEndpoints(env, `skill${i}`, [ep("e1", `task ${i}`, `https://d${i}.example/x`)], { domain: `d${i}.example` });
  }
  const docs = globalDocs(kv.store);
  expect(docs.length).toBe(50);                              // every publish present, none clobbered
  expect(new Set(docs.map((d) => d.id)).size).toBe(50);      // all distinct
  // THE SCALE WIN: 50 skills are distributed across MANY shards, not piled into one
  // 25MB-bound key. With 16 shards and 50 skills, distribution should touch several.
  expect(globalShardKeysUsed(kv.store).length).toBeGreaterThan(1);
});
