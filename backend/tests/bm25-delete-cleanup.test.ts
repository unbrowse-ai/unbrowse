import { test, expect, beforeEach, afterEach } from "bun:test";
import { indexEndpoints, removeSkillFromIndex, removeEndpointsFromIndex, purgeSkillVectors, searchIntent, __resetSearchCacheForTests } from "../src/services/discovery";

// Witness: deleting a skill must also remove its docs from the BM25 KV index, so
// /v1/search (searchIntent) no longer returns it. Before the fix the delete paths only
// touched the graph, leaving BM25 docs searchable forever. (John 15:2.)

function fakeKV() {
  const m = new Map<string, string>();
  return { store: m, get: async (k: string) => (m.has(k) ? m.get(k)! : null), put: async (k: string, v: string) => { m.set(k, v); } };
}
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (u: string) => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  __resetSearchCacheForTests();
});
afterEach(() => { globalThis.fetch = realFetch; __resetSearchCacheForTests(); });

const ep = (id: string, desc: string, url: string) => ({ endpoint_id: id, description: desc, method: "GET", url_template: url });
const env = () => ({ STATS_KV: fakeKV(), ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" }) as never;

test("removeSkillFromIndex makes the skill UNFINDABLE in search (was searchable forever)", async () => {
  const e = env();
  await indexEndpoints(e, "skillGone", [ep("e1", "list dog breeds catalog", "https://dog.example/breeds")], { domain: "dog.example" });
  __resetSearchCacheForTests();
  expect((await searchIntent(e, "dog breeds catalog", 5)).map((r) => String(r.id))).toContain("skillGone:e1"); // findable

  await removeSkillFromIndex(e, "skillGone", "dog.example");
  __resetSearchCacheForTests();
  expect((await searchIntent(e, "dog breeds catalog", 5)).map((r) => String(r.id))).not.toContain("skillGone:e1"); // gone
});

test("removeEndpointsFromIndex removes only the named endpoint, keeps the rest", async () => {
  const e = env();
  await indexEndpoints(e, "skillMulti", [
    ep("keep", "search flights between airports", "https://air.example/flights"),
    ep("drop", "rent a car at the airport", "https://air.example/cars"),
  ], { domain: "air.example" });
  __resetSearchCacheForTests();

  await removeEndpointsFromIndex(e, "skillMulti", ["drop"], "air.example");
  __resetSearchCacheForTests();
  const carIds = (await searchIntent(e, "rent a car airport", 5)).map((r) => String(r.id));
  expect(carIds).not.toContain("skillMulti:drop");   // removed endpoint gone
  const flightIds = (await searchIntent(e, "search flights between airports", 5)).map((r) => String(r.id));
  expect(flightIds).toContain("skillMulti:keep");     // kept endpoint still findable
});

test("purgeSkillVectors makes a skill UNFINDABLE — the mechanism the takedown route uses", async () => {
  const e = env();
  await indexEndpoints(e, "skillTaken", [ep("e1", "premium widget marketplace listing", "https://taken.example/x")], { domain: "taken.example" });
  __resetSearchCacheForTests();
  expect((await searchIntent(e, "premium widget marketplace", 5)).map((r) => String(r.id))).toContain("skillTaken:e1");
  await purgeSkillVectors(e, "skillTaken", ["e1"], "taken.example");
  __resetSearchCacheForTests();
  expect((await searchIntent(e, "premium widget marketplace", 5)).map((r) => String(r.id))).not.toContain("skillTaken:e1");
});
