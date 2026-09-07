/**
 * validateRecommendation — the safety keystone of path-A ("the LLM recommends
 * the command, the client executes"). When the LLM is the ONLY chooser, its
 * proposed command MUST be constrained to the resolved skill's REAL endpoints
 * and the skill's own domain — never a hallucinated endpoint, never a URL that
 * exfiltrates to an off-skill host. This validator is what makes the single LLM
 * path safe to execute client-side.
 *
 * Pure + deterministic (no LLM, no network): the LLM proposes, this validates.
 * Red under HEAD — the function does not exist.
 */
import { test, expect } from "bun:test";
import type { SkillManifest } from "../src/types";
import { validateRecommendation } from "../src/services/recommend-command";

function skill(): SkillManifest {
  return {
    skill_id: "sk1",
    version: "1.0.0",
    schema_version: "1",
    name: "HN search",
    intent_signature: "search hacker news",
    domain: "hn.algolia.com",
    description: "d",
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    endpoints: [
      { endpoint_id: "ep-search", method: "GET", url_template: "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}", description: "search", idempotency: "safe", verification_status: "verified", reliability_score: 0.9 },
    ],
  } as SkillManifest;
}

test("accepts a real endpoint + fills the URL template from params", () => {
  const r = validateRecommendation(skill(), { endpoint_id: "ep-search", params: { query: "rust", tags: "story" } });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.endpoint_id).toBe("ep-search");
    expect(r.method).toBe("GET");
    expect(r.url).toBe("https://hn.algolia.com/api/v1/search?query=rust&tags=story");
  }
});

test("rejects a hallucinated endpoint_id not in the skill", () => {
  const r = validateRecommendation(skill(), { endpoint_id: "ep-invented", params: {} });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("endpoint");
});

test("rejects a proposed URL whose host is not the skill's domain (anti-exfil)", () => {
  const r = validateRecommendation(skill(), { url: "https://evil.example.com/api/v1/search?query=x" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason.toLowerCase()).toContain("host");
});

test("accepts a proposed full URL when it matches a real endpoint's host+path", () => {
  const r = validateRecommendation(skill(), { url: "https://hn.algolia.com/api/v1/search?query=ai&tags=front_page" });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.endpoint_id).toBe("ep-search");
    expect(r.url).toContain("query=ai");
  }
});

test("rejects an unresolved template placeholder (incomplete fill)", () => {
  const r = validateRecommendation(skill(), { endpoint_id: "ep-search", params: { query: "rust" } });
  // {tags} left unfilled — a half-filled URL must not be executed
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("unfilled");
});
