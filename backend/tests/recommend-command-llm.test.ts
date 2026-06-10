/**
 * recommendCommand — the structured recommender (path-A brick 1). It asks the
 * (injectable) LLM to PROPOSE a command for a skill+prompt, then runs every
 * proposal through validateRecommendation (the seal), retrying once with the
 * rejection reason when the model hallucinates. The output is a validated,
 * client-executable command — or an honest rejection. This is what makes
 * "the LLM recommends, the client executes" a real, safe path: the validator
 * is now USED inside a recommender, not a standalone primitive.
 *
 * Deterministic: the LLM is injected as `propose`, so no live model/network.
 * Red under HEAD — recommendCommand does not exist.
 */
import { test, expect } from "bun:test";
import type { SkillManifest } from "../src/types";
import { recommendCommand, type ProposeFn } from "../src/services/recommend-command";

function skill(): SkillManifest {
  return {
    skill_id: "sk1", version: "1.0.0", schema_version: "1", name: "HN search",
    intent_signature: "search hacker news", domain: "hn.algolia.com", description: "d",
    owner_type: "agent", execution_type: "http", lifecycle: "active",
    endpoints: [
      { endpoint_id: "ep-search", method: "GET", url_template: "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}", description: "search", idempotency: "safe", verification_status: "verified", reliability_score: 0.9 },
    ],
  } as SkillManifest;
}

test("returns a validated command when the model proposes a real endpoint", async () => {
  const propose: ProposeFn = async () => ({ endpoint_id: "ep-search", params: { query: "rust", tags: "story" } });
  const r = await recommendCommand(skill(), "find rust stories", propose);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.endpoint_id).toBe("ep-search");
    expect(r.url).toBe("https://hn.algolia.com/api/v1/search?query=rust&tags=story");
  }
});

test("retries once with the rejection reason when the model first hallucinates", async () => {
  let calls = 0;
  const reasons: string[] = [];
  const propose: ProposeFn = async (_s, prompt) => {
    calls++;
    reasons.push(prompt);
    if (calls === 1) return { endpoint_id: "ep-invented", params: {} }; // hallucination
    return { endpoint_id: "ep-search", params: { query: "ai", tags: "front_page" } }; // corrected
  };
  const r = await recommendCommand(skill(), "top ai stories", propose, { maxAttempts: 2 });
  expect(calls).toBe(2);
  expect(r.ok).toBe(true);
  // the retry prompt must carry the rejection reason so the model can self-correct
  expect(reasons[1]).toContain("ep-invented");
});

test("rejects honestly when the model keeps hallucinating past maxAttempts", async () => {
  let calls = 0;
  const propose: ProposeFn = async () => { calls++; return { endpoint_id: "still-fake", params: {} }; };
  const r = await recommendCommand(skill(), "x", propose, { maxAttempts: 2 });
  expect(calls).toBe(2);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("endpoint");
});

test("rejects when the model proposes nothing", async () => {
  const propose: ProposeFn = async () => null;
  const r = await recommendCommand(skill(), "x", propose);
  expect(r.ok).toBe(false);
});
