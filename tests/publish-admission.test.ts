import { describe, expect, test } from "bun:test";
import { formatMarketplacePublishSelection, selectMarketplacePublishEndpoints } from "../src/publish-admission.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

function makeEndpoint(overrides: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "ep-1",
    method: "GET",
    url_template: "https://www.example.com/api/items?page={page}",
    description: "List items",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.95,
    response_schema: {
      type: "object",
      properties: {
        items: { type: "array" },
      },
    },
    semantic: {
      action_kind: "list",
      resource_kind: "item",
      example_fields: ["items[].id"],
    },
    ...overrides,
  } as EndpointDescriptor;
}

function makeSkill(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: "skill-1",
    version: "1.0.0",
    schema_version: "1",
    name: "Example",
    intent_signature: "list items",
    domain: "www.example.com",
    description: "Example skill",
    owner_type: "marketplace",
    execution_type: "http",
    endpoints: [makeEndpoint()],
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("selectMarketplacePublishEndpoints", () => {
  test("drops stale, noisy, fragile, duplicate, and over-limit endpoints", () => {
    const skill = makeSkill({
      endpoints: [
        makeEndpoint({ endpoint_id: "good-api" }),
        makeEndpoint({
          endpoint_id: "dup-lower",
          reliability_score: 0.45,
          verification_status: "unverified",
        }),
        makeEndpoint({
          endpoint_id: "canonical-doc",
          url_template: "https://www.example.com/company/acme",
          trigger_url: "https://www.example.com/company/acme?trk=feed",
          response_schema: undefined,
          semantic: undefined,
          description: "Captured page artifact",
          reliability_score: 0.8,
        }),
        makeEndpoint({
          endpoint_id: "fragile-graphql",
          url_template: "https://www.example.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.3f8416d6f4c842cfb515",
          trigger_url: "https://www.example.com/feed/",
          reliability_score: 0.72,
        }),
        makeEndpoint({
          endpoint_id: "noise-auth",
          url_template: "https://www.example.com/api/auth/refresh",
        }),
        makeEndpoint({
          endpoint_id: "failed",
          url_template: "https://www.example.com/api/items/{id}",
          verification_status: "failed",
        }),
        makeEndpoint({
          endpoint_id: "ws",
          method: "WS",
          url_template: "wss://www.example.com/ws",
          response_schema: undefined,
          semantic: undefined,
        }),
        makeEndpoint({
          endpoint_id: "off-domain",
          url_template: "https://analytics.vendor.com/beacon",
        }),
      ],
    });

    const selection = selectMarketplacePublishEndpoints(skill, { limit: 2 });

    expect(selection.endpoints.map((endpoint) => endpoint.endpoint_id)).toEqual([
      "good-api",
      "canonical-doc",
    ]);
    expect(selection.stats.by_reason.family_dedup).toBe(1);
    expect(selection.stats.by_reason.fragile_graphql).toBe(1);
    expect(selection.stats.by_reason.noise).toBe(1);
    expect(selection.stats.by_reason.verification_failed).toBe(1);
    expect(selection.stats.by_reason.ws).toBe(1);
    expect(selection.stats.by_reason.off_domain).toBe(1);
    expect(formatMarketplacePublishSelection(selection)).toContain("fragile_graphql=1");
  });

  test("keeps verified graphql endpoints only when they look durable", () => {
    const skill = makeSkill({
      endpoints: [
        makeEndpoint({
          endpoint_id: "durable-graphql",
          url_template: "https://www.example.com/voyager/api/graphql?queryId=feedDashMain.abcdef1234567890",
          reliability_score: 0.94,
        }),
      ],
    });

    const selection = selectMarketplacePublishEndpoints(skill);

    expect(selection.endpoints.map((endpoint) => endpoint.endpoint_id)).toEqual([
      "durable-graphql",
    ]);
    expect(selection.stats.by_reason.fragile_graphql).toBe(0);
  });
});
