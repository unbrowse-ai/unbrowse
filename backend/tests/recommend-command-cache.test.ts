/**
 * recommendCommandCached — path-A brick 2, the cost reconciliation.
 *
 * Path-A makes the LLM the only chooser; left raw, that bills an LLM round on
 * every request and breaks the paper's adoption condition f_route < c_rediscovery
 * (an LLM-per-call costs more than driving a browser). The fix is NOT a separate
 * deterministic path — it's a CACHE WITHIN the one path: memoise the validated
 * recommendation by (skill identity, normalized intent), so a recurring intent
 * returns instantly without touching the model. The fast path returns as a cache,
 * not a second code path — A stays true to the economics.
 *
 * Deterministic: cache + propose are injected (Map-backed, call-counted). No LLM.
 * Red under HEAD — recommendCommandCached + recommendationCacheKey do not exist.
 */
import { test, expect } from "bun:test";
import type { SkillManifest } from "../src/types";
import {
  recommendCommandCached,
  recommendationCacheKey,
  type ProposeFn,
  type ValidatedCommand,
  type RecommendationCache,
} from "../src/services/recommend-command";

function skill(updated = "2026-06-01T00:00:00Z"): SkillManifest {
  return {
    skill_id: "sk1", version: "1.0.0", schema_version: "1", name: "HN search",
    intent_signature: "search hacker news", domain: "hn.algolia.com", description: "d",
    owner_type: "agent", execution_type: "http", lifecycle: "active", updated_at: updated,
    endpoints: [
      { endpoint_id: "ep-search", method: "GET", url_template: "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}", description: "search", idempotency: "safe", verification_status: "verified", reliability_score: 0.9 },
    ],
  } as SkillManifest;
}

function mapCache(): RecommendationCache & { store: Map<string, ValidatedCommand> } {
  const store = new Map<string, ValidatedCommand>();
  return {
    store,
    async get(k) { return store.get(k) ?? null; },
    async set(k, v) { store.set(k, v); },
  };
}

const goodPropose: ProposeFn = async () => ({ endpoint_id: "ep-search", params: { query: "rust", tags: "story" } });

test("first call hits the model; the validated command is cached", async () => {
  let calls = 0;
  const propose: ProposeFn = async (s, p) => { calls++; return goodPropose(s, p); };
  const cache = mapCache();
  const r = await recommendCommandCached(skill(), "find rust stories", propose, cache);
  expect(r.ok).toBe(true);
  expect(calls).toBe(1);
  expect(cache.store.size).toBe(1);
});

test("a recurring intent returns from cache WITHOUT calling the model", async () => {
  let calls = 0;
  const propose: ProposeFn = async (s, p) => { calls++; return goodPropose(s, p); };
  const cache = mapCache();
  await recommendCommandCached(skill(), "find rust stories", propose, cache);
  const r2 = await recommendCommandCached(skill(), "  Find Rust Stories  ", propose, cache); // case/space variant
  expect(r2.ok).toBe(true);
  expect(calls).toBe(1); // second call served from cache — no LLM
});

test("a different intent is a cache miss (model called again)", async () => {
  let calls = 0;
  const propose: ProposeFn = async (s, p) => { calls++; return goodPropose(s, p); };
  const cache = mapCache();
  await recommendCommandCached(skill(), "rust stories", propose, cache);
  await recommendCommandCached(skill(), "python stories", propose, cache);
  expect(calls).toBe(2);
});

test("a skill update invalidates the cache (endpoints may have changed)", async () => {
  let calls = 0;
  const propose: ProposeFn = async (s, p) => { calls++; return goodPropose(s, p); };
  const cache = mapCache();
  await recommendCommandCached(skill("2026-06-01T00:00:00Z"), "rust stories", propose, cache);
  await recommendCommandCached(skill("2026-06-09T00:00:00Z"), "rust stories", propose, cache); // newer skill
  expect(calls).toBe(2);
  // distinct keys for distinct skill versions
  expect(recommendationCacheKey(skill("2026-06-01T00:00:00Z"), "rust stories"))
    .not.toBe(recommendationCacheKey(skill("2026-06-09T00:00:00Z"), "rust stories"));
});

test("a rejected recommendation is NOT cached (retry fresh next time)", async () => {
  let calls = 0;
  const propose: ProposeFn = async () => { calls++; return { endpoint_id: "ghost", params: {} }; }; // always hallucinates
  const cache = mapCache();
  const r1 = await recommendCommandCached(skill(), "x", propose, cache, { maxAttempts: 1 });
  expect(r1.ok).toBe(false);
  expect(cache.store.size).toBe(0); // failures are not memoised
  await recommendCommandCached(skill(), "x", propose, cache, { maxAttempts: 1 });
  expect(calls).toBe(2); // second attempt re-ran the model, did not serve a cached failure
});
