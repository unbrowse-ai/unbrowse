/**
 * Regression test for issue #404:
 * resolve fails to find freshly captured YouTube/X.com endpoints.
 *
 * Root cause: hasUsableEndpoints only accepts endpoints with:
 *   - response_schema (not present on fresh captures), OR
 *   - /api/ in the path (YouTube uses /youtubei/v1/, X uses /i/api/graphql), OR
 *   - dom_extraction
 *
 * Fresh captures from close/sync have none of these yet — the background
 * indexer adds response_schema asynchronously. So hasUsableEndpoints returns
 * false for freshly captured YouTube/X.com skills, causing isCachedSkillRelevantForIntent
 * to return false, and resolve falls through to 0 endpoints.
 */

import { describe, expect, it } from "bun:test";
import { hasUsableEndpoints, isCachedSkillRelevantForIntent } from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

function makeSkill(domain: string, endpoints: SkillManifest["endpoints"]): SkillManifest {
  return {
    skill_id: "test-skill",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: domain,
    domain,
    description: `Test skill for ${domain}`,
    owner_type: "agent",
    endpoints,
  };
}

describe("hasUsableEndpoints — fresh capture from browse close", () => {
  it("accepts a fresh YouTube youtubei endpoint without response_schema", () => {
    // YouTube uses /youtubei/v1/ paths, not /api/
    const skill = makeSkill("www.youtube.com", [
      {
        endpoint_id: "ep1",
        method: "POST",
        url_template: "https://www.youtube.com/youtubei/v1/browse",
        idempotency: "safe",
        // No response_schema — freshly captured, background indexer hasn't run yet
        // No dom_extraction
      },
    ]);
    expect(hasUsableEndpoints(skill)).toBe(true);
  });

  it("accepts a fresh X.com graphql endpoint without response_schema", () => {
    // X uses /i/api/graphql/ paths (has /api/ but behind /i/ prefix on some clients)
    // or https://api.twitter.com/2/... — test the non-/api/ case
    const skill = makeSkill("x.com", [
      {
        endpoint_id: "ep1",
        method: "GET",
        url_template: "https://x.com/i/api/graphql/abc123/HomeTimeline",
        idempotency: "safe",
        // No response_schema
      },
    ]);
    expect(hasUsableEndpoints(skill)).toBe(true);
  });

  it("accepts a fresh endpoint with a versioned path like /v1/ or /v2/", () => {
    const skill = makeSkill("api.example.com", [
      {
        endpoint_id: "ep1",
        method: "GET",
        url_template: "https://api.example.com/v1/users",
        idempotency: "safe",
      },
    ]);
    expect(hasUsableEndpoints(skill)).toBe(true);
  });

  it("rejects a plain HTML page endpoint with no response_schema or dom_extraction", () => {
    const skill = makeSkill("example.com", [
      {
        endpoint_id: "ep1",
        method: "GET",
        url_template: "https://example.com/some-html-page",
        idempotency: "safe",
      },
    ]);
    expect(hasUsableEndpoints(skill)).toBe(false);
  });

  it("isCachedSkillRelevantForIntent returns true for fresh YouTube capture", () => {
    const skill = makeSkill("www.youtube.com", [
      {
        endpoint_id: "ep1",
        method: "POST",
        url_template: "https://www.youtube.com/youtubei/v1/browse",
        idempotency: "safe",
        description: "YouTube browse endpoint for channel videos",
      },
    ]);
    expect(isCachedSkillRelevantForIntent(skill, "get channel videos", "https://www.youtube.com/@MrBeast")).toBe(true);
  });
});
