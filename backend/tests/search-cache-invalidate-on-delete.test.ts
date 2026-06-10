import { test, expect, beforeEach, afterEach } from "bun:test";
import { indexEndpoints, removeSkillFromIndex, searchIntent } from "../src/services/discovery";

// Witness for the cache-invalidation-on-delete fix: after a skill is removed, /v1/search
// must NOT keep serving it from the search cache. We deliberately do NOT call any manual
// cache reset — removeSkillFromIndex must invalidate the cache itself (epoch bump).

function fakeKV() {
  const m = new Map<string, string>();
  return { store: m, get: async (k: string) => (m.has(k) ? m.get(k)! : null), put: async (k: string, v: string) => { m.set(k, v); } };
}
const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = (async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch; });
afterEach(() => { globalThis.fetch = realFetch; });
const ep = (id: string, desc: string, url: string) => ({ endpoint_id: id, description: desc, method: "GET", url_template: url });
const env = () => ({ STATS_KV: fakeKV(), ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" }) as never;

test("delete invalidates the search cache — the removed skill is NOT served from a stale cache", async () => {
  const e = env();
  await indexEndpoints(e, "skillCached", [ep("e1", "cached widget catalog search", "https://w.example/widgets")], { domain: "w.example" });
  // Warm the cache with a search that finds the skill.
  expect((await searchIntent(e, "widget catalog search", 5)).map((r) => String(r.id))).toContain("skillCached:e1");

  // Delete it — NO manual cache reset. The next identical search must reflect the delete.
  await removeSkillFromIndex(e, "skillCached", "w.example");
  expect((await searchIntent(e, "widget catalog search", 5)).map((r) => String(r.id))).not.toContain("skillCached:e1");
});
