import { describe, expect, test } from "bun:test";
import { isCachedSkillRelevantForIntent } from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

function makeSkill(
  endpoint: SkillManifest["endpoints"][number],
  overrides: Partial<SkillManifest> = {},
): SkillManifest {
  return {
    skill_id: "linkedin-skill",
    domain: "www.linkedin.com",
    execution_type: "http",
    endpoints: [endpoint],
    auth_type: "cookie",
    auth_profile_ref: "linkedin.com-session",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("isCachedSkillRelevantForIntent", () => {
  test("rejects linkedin people-search cache for feed intents", () => {
    const skill = makeSkill({
      endpoint_id: "people-page",
      method: "GET",
      url_template: "https://www.linkedin.com/search/results/people/?keywords={keywords}",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
      description: "Captured page artifact for search people",
      trigger_url: "https://www.linkedin.com/search/results/people/?keywords=openai",
      dom_extraction: { extraction_method: "repeated-elements", confidence: 0.95 },
      response_schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            url: { type: "string" },
            public_identifier: { type: "string" },
            headline: { type: "string" },
          },
        },
      },
      semantic: { action_kind: "search", resource_kind: "person" },
    } as SkillManifest["endpoints"][number]);

    expect(
      isCachedSkillRelevantForIntent(
        skill,
        "get linkedin feed posts",
        "https://www.linkedin.com/feed/",
      ),
    ).toBe(false);
  });

  test("keeps linkedin people-search cache for people intents", () => {
    const skill = makeSkill({
      endpoint_id: "people-page",
      method: "GET",
      url_template: "https://www.linkedin.com/search/results/people/?keywords={keywords}",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
      description: "Captured page artifact for search people",
      trigger_url: "https://www.linkedin.com/search/results/people/?keywords=openai",
      dom_extraction: { extraction_method: "repeated-elements", confidence: 0.95 },
      response_schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            url: { type: "string" },
            public_identifier: { type: "string" },
            headline: { type: "string" },
          },
        },
      },
      semantic: { action_kind: "search", resource_kind: "person" },
    } as SkillManifest["endpoints"][number]);

    expect(
      isCachedSkillRelevantForIntent(
        skill,
        "search people linkedin",
        "https://www.linkedin.com/search/results/people/?keywords=openai",
      ),
    ).toBe(true);
  });

  test("rejects homepage page-artifact cache for module timetable intents", () => {
    const skill = makeSkill({
      endpoint_id: "nusmods-home",
      method: "GET",
      url_template: "https://nusmods.com/",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.92,
      description: "Captured page artifact for retrieve module and timetable information",
      trigger_url: "https://nusmods.com/",
      dom_extraction: { extraction_method: "repeated-elements", confidence: 0.92 },
      response_schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        },
      },
    } as SkillManifest["endpoints"][number], {
      domain: "nusmods.com",
    });

    expect(
      isCachedSkillRelevantForIntent(
        skill,
        "retrieve module and timetable information",
        "https://nusmods.com/",
      ),
    ).toBe(false);
  });
});
