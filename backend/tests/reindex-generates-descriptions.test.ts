import { test, expect, beforeEach, afterEach } from "bun:test";
import { reindexSkill } from "../src/services/discovery";
import { clearKVCacheForTests } from "../src/services/kv";

// Witness for "/contract it properly": the standalone reindex path (reindexSkill, fired by the
// CLI `index` command + the reindex sweeper) now GENERATES descriptions before indexing — exactly
// like the publish path (marketplace.ts) — so a re-index POPULATES /v1/search instead of dropping
// description-less endpoints (which indexEndpoints skips post-#908). Without the fix this indexed 0.

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
  // 200 {ok:true} for every call: the LLM description call gets no `choices` → generateDescriptions
  // falls to the heuristic (always non-empty); the /graph/batch_insert enrichment also 200s.
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test("reindexSkill GENERATES descriptions → description-less endpoints now land in /v1/search index", async () => {
  const kv = fakeKV();
  const env = { STATS_KV: kv, ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" } as never;
  const skill = {
    skill_id: "reddit-hot",
    intent_signature: "reddit hot posts",
    domain: "reddit.com",
    name: "reddit",
    description: "reddit skill",
    updated_at: new Date(0).toISOString(),
    endpoints: [
      // NO description on either — the publish path would generate them; the OLD reindex dropped them.
      { endpoint_id: "e1", method: "GET", url_template: "https://reddit.com/r/{sub}/hot.json", reliability_score: 0.9, verification_status: "verified" },
      { endpoint_id: "e2", method: "GET", url_template: "https://reddit.com/search.json", reliability_score: 0.8, verification_status: "verified" },
    ],
  };
  await reindexSkill(env, skill);
  // Both endpoints now carry a (heuristic) description AND landed in the global index.
  expect(skill.endpoints.every((e) => !!e.description)).toBe(true);
  expect(globalDocCount(kv.store)).toBe(2);
});
