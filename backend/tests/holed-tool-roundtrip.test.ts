/**
 * Composition witness: the path-A primitives, built piecemeal across turns +
 * parallel agents, must actually FIT — emit → fill → seal round-trips.
 *
 *   1. endpointToHoledTool(skill, ep)  → the PII-censored tool-with-holes  (src/skillmd)
 *   2. fillHoledTool(tool, values)     → fill the public holes → an executable URL (src/skillmd)
 *   3. validateRecommendation(skill, {url})  → the seal ACCEPTS that URL    (backend/services)
 *
 * If the emitter and the seal disagree on host/path shape, a correctly-filled
 * holed-tool URL would be rejected — a real integration bug no unit test catches.
 * Red under HEAD — fillHoledTool does not yet exist in src/skillmd.
 */
import { test, expect } from "bun:test";
import { endpointToHoledTool, fillHoledTool } from "../../src/skillmd";
import { validateRecommendation } from "../src/services/recommend-command";
import type { SkillManifest } from "../src/types";

function skill(): SkillManifest {
  return {
    skill_id: "sk-hn", version: "1.0.0", schema_version: "1", name: "HN",
    intent_signature: "search hn", domain: "hn.algolia.com", description: "d",
    owner_type: "agent", execution_type: "http", lifecycle: "active",
    endpoints: [
      { endpoint_id: "ep-search", method: "GET", url_template: "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}", headers_template: { authorization: "Bearer SECRET" }, description: "search", idempotency: "safe", verification_status: "verified", reliability_score: 0.9 },
    ],
  } as SkillManifest;
}

test("emit → fill → seal round-trips: a filled holed tool is accepted by validateRecommendation", () => {
  const s = skill();
  const tool = endpointToHoledTool(s, s.endpoints[0]);
  const filled = fillHoledTool(tool, { query: "rust", tags: "story" });
  expect(filled.ok).toBe(true);
  if (!filled.ok) return;
  expect(filled.url).toBe("https://hn.algolia.com/api/v1/search?query=rust&tags=story");
  // the SEAL must accept the filled URL and resolve it to the same endpoint
  const sealed = validateRecommendation(s, { url: filled.url });
  expect(sealed.ok).toBe(true);
  if (sealed.ok) expect(sealed.endpoint_id).toBe("ep-search");
});

test("fillHoledTool rejects a missing public hole (and the seal never sees a half-URL)", () => {
  const s = skill();
  const tool = endpointToHoledTool(s, s.endpoints[0]);
  const filled = fillHoledTool(tool, { query: "rust" }); // tags missing
  expect(filled.ok).toBe(false);
});

test("a secret/vault hole needs no value at fill time (browser/vault supplies it)", () => {
  const s = skill();
  const tool = endpointToHoledTool(s, s.endpoints[0]);
  // authorization is a secret hole; only the public query/tags are required to fill
  const filled = fillHoledTool(tool, { query: "ai", tags: "front_page" });
  expect(filled.ok).toBe(true);
  if (filled.ok) expect(filled.url).not.toContain("SECRET");
});
