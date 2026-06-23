import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { indexEndpoints, hashToInt } from "../src/services/discovery";
import { clearKVCacheForTests } from "../src/services/kv";

// Witness for the empty-/v1/search-index honest-status fix: indexEndpoints now RETURNS the
// count of docs actually indexed, and a publish whose endpoints carry NO description indexes
// ZERO + warns VISIBLY (instead of a silent early-return that let the marketplace record a
// fabricated "ok"). This is the diagnostic that reveals WHY a prod /v1/search index is empty.

function fakeKV() {
  const m = new Map<string, string>();
  const strip = (k: string): string => {
    for (const p of ["skills-v2:", "stats:", "staging-skills-v3:", "staging-stats:"]) {
      if (k.startsWith(p)) return k.slice(p.length);
    }
    return k;
  };
  return {
    store: m,
    get: async (k: string) => { const s = strip(k); return m.has(s) ? m.get(s)! : null; },
    put: async (k: string, v: string) => { m.set(strip(k), v); },
  };
}
function globalDocCount(store: Map<string, string>): number {
  let n = 0;
  for (const [k, v] of store) {
    if (k === "bm25-idx:v2-global" || k.startsWith("bm25-idx:v2-global:s")) {
      try { n += (JSON.parse(v) as unknown[]).length; } catch { /* skip */ }
    }
  }
  return n;
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  clearKVCacheForTests();
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const withDesc = (id: string, desc: string) => ({ endpoint_id: id, description: desc, method: "GET", url_template: `https://x.com/${id}` });
const noDesc = (id: string) => ({ endpoint_id: id, method: "GET", url_template: `https://x.com/${id}` });

test("indexEndpoints returns the COUNT actually indexed (not void) — description-bearing endpoints land", async () => {
  const kv = fakeKV();
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  const n = await indexEndpoints(env, "skillA", [withDesc("e1", "reddit hot posts listing"), withDesc("e2", "search subreddits")], { domain: "reddit.com" });
  expect(n).toBe(2);
  expect(globalDocCount(kv.store)).toBe(2); // round-trip: docs are in the global index, searchable
});

test("no-description publish indexes ZERO, returns 0, and WARNS visibly (the empty-index cause, surfaced)", async () => {
  const kv = fakeKV();
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const n = await indexEndpoints(env, "skillB", [noDesc("e1"), noDesc("e2")], { domain: "reddit.com" });
  expect(n).toBe(0);                       // nothing indexed
  expect(globalDocCount(kv.store)).toBe(0); // nothing landed in the index
  // The skip is no longer silent — it logs WHY /v1/search will not see this skill.
  expect(warn.mock.calls.some((c) => String(c[0]).includes("0 with descriptions"))).toBe(true);
  warn.mockRestore();
});

test("partial publish indexes only the described endpoints + warns about the dropped ones", async () => {
  const kv = fakeKV();
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const n = await indexEndpoints(env, "skillC", [withDesc("e1", "get user profile"), noDesc("e2")], { domain: "github.com" });
  expect(n).toBe(1);
  expect(warn.mock.calls.some((c) => String(c[0]).includes("dropped (no description)"))).toBe(true);
  warn.mockRestore();
});
