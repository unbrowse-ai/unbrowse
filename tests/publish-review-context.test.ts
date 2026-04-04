import { describe, expect, test } from "bun:test";
import { buildEndpointReviewContext } from "../src/publish/review-context.js";
import { mergeAgentReview } from "../src/indexer/index.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/skill.js";

function endpoint(overrides: Partial<EndpointDescriptor> & { endpoint_id: string; url_template: string }): EndpointDescriptor {
  return {
    method: "GET",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    ...overrides,
  };
}

function skill(endpoints: EndpointDescriptor[]): SkillManifest {
  return {
    skill_id: "skill-test",
    version: "1.0.0",
    schema_version: "1",
    name: "example.com",
    intent_signature: "search items",
    domain: "example.com",
    description: "test skill",
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    endpoints,
  };
}

describe("publish review context", () => {
  test("includes dependency and unlock context for endpoint review", () => {
    const s = skill([
      endpoint({
        endpoint_id: "search",
        url_template: "https://api.example.com/search?q={q}",
        trigger_url: "https://example.com/search?q=openai",
        description: "Search items",
        semantic: {
          action_kind: "search",
          resource_kind: "item",
          description_out: "Search items",
          requires: [],
          provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
        } as any,
      }),
      endpoint({
        endpoint_id: "detail",
        url_template: "https://api.example.com/items/{item_id}",
        trigger_url: "https://example.com/search?q=openai",
        description: "Get item detail",
        semantic: {
          action_kind: "detail",
          resource_kind: "item",
          description_out: "Get item detail",
          requires: [{ key: "item_id", required: true, source: "url_template", semantic_type: "item_identifier" }],
          provides: [{ key: "seller_id", source: "response", semantic_type: "seller_identifier" }],
        } as any,
      }),
      endpoint({
        endpoint_id: "seller",
        url_template: "https://api.example.com/sellers/{seller_id}",
        trigger_url: "https://example.com/search?q=openai",
        description: "Get seller detail",
        semantic: {
          action_kind: "detail",
          resource_kind: "seller",
          description_out: "Get seller detail",
          requires: [{ key: "seller_id", required: true, source: "url_template", semantic_type: "seller_identifier" }],
          provides: [],
        } as any,
      }),
    ]);

    const ctx = buildEndpointReviewContext(s, "detail");

    expect(ctx).toBeTruthy();
    expect(ctx?.provenance).toBe("http_replay");
    expect(ctx?.trigger_url).toBe("https://example.com/search?q=openai");
    expect(Array.isArray(ctx?.dependencies)).toBe(true);
    expect(Array.isArray(ctx?.unlocks)).toBe(true);
    expect((ctx?.dependencies as Array<Record<string, unknown>>)[0]?.endpoint_id).toBe("search");
    expect((ctx?.unlocks as Array<Record<string, unknown>>)[0]?.endpoint_id).toBe("seller");
    expect((ctx?.trigger_siblings as Array<Record<string, unknown>>).length).toBe(2);
  });

  test("mergeAgentReview stamps reviewed descriptions as agent-authored", () => {
    const endpoints = [
      endpoint({
        endpoint_id: "feed",
        url_template: "https://example.com/feed",
        description: "Captured page artifact for get feed posts",
        semantic: {
          action_kind: "search",
          resource_kind: "post",
          description_out: "Returns posts timeline",
          description_source: "auto",
          description_needs_review: true,
          description_warning: "Auto-generated description. Review before trusting or publishing.",
        } as any,
      }),
    ];

    const updated = mergeAgentReview(endpoints, [
      {
        endpoint_id: "feed",
        description: "Returns the main feed posts for the signed-in member",
        action_kind: "timeline",
        resource_kind: "post",
      },
    ]);

    expect(updated[0]?.description).toBe("Returns the main feed posts for the signed-in member");
    expect(updated[0]?.semantic?.description_out).toBe("Returns the main feed posts for the signed-in member");
    expect(updated[0]?.semantic?.description_source).toBe("agent");
    expect(updated[0]?.semantic?.description_needs_review).toBe(false);
    expect(updated[0]?.semantic?.description_warning).toBeUndefined();
  });

  test("review context includes hint edges from potential binding linkages", () => {
    const s = skill([
      endpoint({
        endpoint_id: "people-dom-search",
        url_template: "https://www.linkedin.com/search/results/people/?keywords={keywords}",
        trigger_url: "https://www.linkedin.com/search/results/people/?keywords=openai",
        description: "Captured page artifact for search people",
        semantic: {
          action_kind: "search",
          resource_kind: "profile",
          description_out: "Returns people search rows",
          requires: [],
          provides: [{ key: "public_identifier", source: "response", semantic_type: "profile_identifier" }],
        } as any,
      }),
      endpoint({
        endpoint_id: "member-api-detail",
        url_template: "https://www.linkedin.com/voyager/api/identity/profiles/{member_id}",
        trigger_url: "https://www.linkedin.com/search/results/people/?keywords=openai",
        description: "Returns member detail",
        semantic: {
          action_kind: "detail",
          resource_kind: "member",
          description_out: "Returns member detail",
          requires: [{ key: "member_id", required: true, source: "path_params", semantic_type: "member_identifier" }],
          provides: [],
        } as any,
      }),
    ]);

    const ctx = buildEndpointReviewContext(s, "member-api-detail");
    const deps = ctx?.dependencies as Array<Record<string, unknown>>;

    expect(deps.length).toBe(1);
    expect(deps[0]?.endpoint_id).toBe("people-dom-search");
    expect(deps[0]?.kind).toBe("hint");
  });
});
