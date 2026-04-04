import { describe, expect, it, mock } from "bun:test";
import type { SkillManifest } from "../src/types/index.js";

mock.module("nanoid", () => ({
  nanoid: () => "test-nanoid",
}));

mock.module("cheerio", () => ({
  load: () => (() => []),
}));

mock.module("bs58", () => ({
  default: {
    encode: () => "",
    decode: () => new Uint8Array(),
  },
  encode: () => "",
  decode: () => new Uint8Array(),
}));

const { isCachedSkillRelevantForIntent } = await import("../src/orchestrator/index.js");

function makeSkill(
  endpoints: SkillManifest["endpoints"],
): SkillManifest {
  const now = new Date().toISOString();
  return {
    skill_id: "beatsaver-skill",
    version: "1.0.0",
    schema_version: "1",
    name: "BeatSaver",
    intent_signature: "search beat saber maps",
    domain: "beatsaver.com",
    description: "BeatSaver search skill",
    owner_type: "marketplace",
    execution_type: "http",
    endpoints,
    lifecycle: "active",
    created_at: now,
    updated_at: now,
  };
}

describe("isCachedSkillRelevantForIntent", () => {
  it("rejects cached search skills that do not expose the search binding from context url", () => {
    const skill = makeSkill([
      {
        endpoint_id: "map-detail",
        method: "GET",
        url_template: "https://beatsaver.com/api/maps/id/{id}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.98,
        description: "Get map detail",
        response_schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
        semantic: {
          action_kind: "detail",
          resource_kind: "map",
          example_fields: ["id", "name"],
        },
      },
    ]);

    expect(
      isCachedSkillRelevantForIntent(
        skill,
        "search beat saber maps",
        "https://beatsaver.com/?q=camellia",
      ),
    ).toBe(false);
  });

  it("accepts cached search skills when an endpoint matches the explicit search binding", () => {
    const skill = makeSkill([
      {
        endpoint_id: "search-maps",
        method: "GET",
        url_template: "https://beatsaver.com/api/search/text/0?q={q}",
        query: { q: "camellia" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.98,
        description: "Search maps",
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        semantic: {
          action_kind: "search",
          resource_kind: "map",
          description_in: "Requires q",
          description_out: "Returns matching BeatSaver maps",
          example_fields: ["[].id", "[].name"],
        },
      },
    ]);

    expect(
      isCachedSkillRelevantForIntent(
        skill,
        "search beat saber maps",
        "https://beatsaver.com/?q=camellia",
      ),
    ).toBe(true);
  });

  it("rejects public feed skills whose top replay endpoint points at a local runtime host", () => {
    const skill = makeSkill([
      {
        endpoint_id: "linkedin-feed",
        method: "GET",
        url_template: "http://127.0.0.1:52235/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.abc",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
        description: "LinkedIn feed",
        response_schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
        },
        semantic: {
          action_kind: "timeline",
          resource_kind: "post",
          description_out: "LinkedIn feed",
        },
      },
      {
        endpoint_id: "voyager-helper",
        method: "GET",
        url_template: "https://platform.linkedin.com/litms/allowlist/voyager-web-feed",
        idempotency: "safe",
        verification_status: "unverified",
        reliability_score: 0.5,
        description: "Returns posts timeline with pagekey and controlurn",
        response_schema: {
          type: "object",
          properties: {
            pageKey: { type: "array", items: { type: "string" } },
            controlUrn: { type: "array", items: { type: "string" } },
          },
        },
        semantic: {
          action_kind: "timeline",
          resource_kind: "post",
          description_out: "Returns posts timeline with pagekey and controlurn",
          negative_tags: ["helper"],
        },
      },
    ]);

    expect(
      isCachedSkillRelevantForIntent(
        skill,
        "get linkedin feed posts",
        "https://www.linkedin.com/feed/",
      ),
    ).toBe(false);
  });

});
