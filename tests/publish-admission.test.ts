import { describe, expect, test } from "bun:test";
import { formatMarketplacePublishSelection, selectMarketplacePublishClosure, selectMarketplacePublishEndpoints } from "../src/publish-admission.js";
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

    // canonical-doc is a dom-fallback page artifact; it must be dropped
    // when a real API endpoint exists alongside it. Publishing synthetic
    // page-as-endpoint entries poisons resolve with false cache hits.
    expect(selection.endpoints.map((endpoint) => endpoint.endpoint_id)).toEqual([
      "good-api",
    ]);
    expect(selection.stats.by_reason.dom_fallback_only).toBe(1);
    expect(selection.stats.by_reason.family_dedup).toBe(1);
    expect(selection.stats.by_reason.fragile_graphql).toBe(1);
    expect(selection.stats.by_reason.noise).toBe(1);
    expect(selection.stats.by_reason.verification_failed).toBe(1);
    expect(selection.stats.by_reason.ws).toBe(1);
    expect(selection.stats.by_reason.off_domain).toBe(1);
    expect(formatMarketplacePublishSelection(selection)).toContain("fragile_graphql=1");
  });

  test("rejects skills whose only admitted endpoints are dom-fallback page artifacts", () => {
    const skill = makeSkill({
      endpoints: [
        makeEndpoint({
          endpoint_id: "page-only",
          url_template: "https://www.example.com/company/acme",
          trigger_url: "https://www.example.com/company/acme",
          response_schema: undefined,
          semantic: undefined,
          description: "Captured page artifact",
          reliability_score: 0.8,
        }),
      ],
    });

    const selection = selectMarketplacePublishEndpoints(skill);
    expect(selection.endpoints).toHaveLength(0);
    expect(selection.stats.by_reason.dom_fallback_only).toBe(1);
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

  test("expands admitted roots into DAG-linked standalone publish steps", () => {
    const search = makeEndpoint({
      endpoint_id: "search-items",
      description: "Search items",
      url_template: "https://www.example.com/api/items/search?q={q}",
      semantic: { action_kind: "search", resource_kind: "item", example_fields: ["items[].id"] },
    });
    const detail = makeEndpoint({
      endpoint_id: "item-detail",
      description: "Get item detail",
      url_template: "https://www.example.com/api/items/{item_id}",
      semantic: { action_kind: "detail", resource_kind: "item", example_fields: ["id"] },
    });
    const submit = makeEndpoint({
      endpoint_id: "item-submit",
      method: "POST",
      description: "Submit item update",
      url_template: "https://www.example.com/api/items/{item_id}/submit",
      semantic: { action_kind: "update", resource_kind: "item", example_fields: ["ok"] },
    });
    const noise = makeEndpoint({
      endpoint_id: "analytics-noise",
      description: "Analytics beacon",
      url_template: "https://www.example.com/api/analytics/beacon",
    });
    const skill = makeSkill({
      endpoints: [search, detail, submit, noise],
      operation_graph: {
        generated_at: new Date().toISOString(),
        entry_operation_ids: ["search-items"],
        operations: [
          {
            operation_id: "search-items",
            endpoint_id: "search-items",
            method: "GET",
            url_template: search.url_template,
            action_kind: "search",
            resource_kind: "item",
            requires: [],
            provides: [],
            confidence: 0.99,
          },
          {
            operation_id: "item-detail",
            endpoint_id: "item-detail",
            method: "GET",
            url_template: detail.url_template,
            action_kind: "detail",
            resource_kind: "item",
            requires: [],
            provides: [],
            confidence: 0.99,
          },
          {
            operation_id: "item-submit",
            endpoint_id: "item-submit",
            method: "POST",
            url_template: submit.url_template,
            action_kind: "update",
            resource_kind: "item",
            requires: [],
            provides: [],
            confidence: 0.99,
          },
          {
            operation_id: "analytics-noise",
            endpoint_id: "analytics-noise",
            method: "GET",
            url_template: noise.url_template,
            action_kind: "fetch",
            resource_kind: "config",
            requires: [],
            provides: [],
            confidence: 0.5,
          },
        ],
        edges: [
          {
            edge_id: "search-items:item-detail:item_id",
            from_operation_id: "search-items",
            to_operation_id: "item-detail",
            binding_key: "item_id",
            kind: "dependency",
            confidence: 0.9,
          },
          {
            edge_id: "item-detail:item-submit:item_id",
            from_operation_id: "item-detail",
            to_operation_id: "item-submit",
            binding_key: "item_id",
            kind: "dependency",
            confidence: 0.9,
          },
          {
            edge_id: "analytics-noise:item-submit:beacon_id",
            from_operation_id: "analytics-noise",
            to_operation_id: "item-submit",
            binding_key: "beacon_id",
            kind: "hint",
            confidence: 0.2,
          },
        ],
      },
    });

    const selection = selectMarketplacePublishClosure(skill, { limit: 1 });

    expect(selection.root_endpoint_ids).toHaveLength(1);
    expect(selection.endpoints.map((endpoint) => endpoint.endpoint_id)).toEqual([
      "item-detail",
      "search-items",
      "item-submit",
    ]);
    expect(selection.closure_operation_ids.sort()).toEqual([
      "item-detail",
      "item-submit",
      "search-items",
    ]);
    expect(selection.closure_edge_count).toBe(2);
    expect(selection.endpoints.map((endpoint) => endpoint.endpoint_id)).not.toContain("analytics-noise");
  });
});

// G1 phantom-endpoint hallucination guard — added after lawnet.sg returned a
// fabricated "search" operation built from homepage marketing copy. The
// detector must reject DOM-extracted homepage replays that have no required
// user params and no array-of-items response shape, while still admitting
// legitimate DOM-extracted list/feed endpoints.
describe("G1 phantom-endpoint admission gate", () => {
  test("rejects DOM-extracted homepage with no params and no array shape", () => {
    const phantom = makeEndpoint({
      endpoint_id: "phantom-search",
      url_template: "https://www.lawnet.sg/lawnet/web/lawnet/home",
      trigger_url: "https://www.lawnet.sg/lawnet/web/lawnet/home",
      dom_extraction: { extraction_method: "dom-fallback" } as any,
      description: "Searches posts with titles, link, and url",
      response_schema: {
        type: "object",
        properties: {
          post_name: { type: "string" },
          status_name: { type: "string" },
          tweet_url: { type: "string" },
        },
      },
      semantic: {
        action_kind: "search",
        resource_kind: "form",
        requires: [],
        example_fields: ["post_name", "status_name", "tweet_url"],
      },
    });
    const skill = makeSkill({ domain: "lawnet.sg", endpoints: [phantom] });
    const selection = selectMarketplacePublishEndpoints(skill);
    expect(selection.endpoints).toHaveLength(0);
    expect(selection.stats.by_reason.phantom_endpoint).toBe(1);
  });

  test("admits a legit DOM-extracted list endpoint with array-of-items shape", () => {
    const legit = makeEndpoint({
      endpoint_id: "legit-list",
      url_template: "https://shop.example.com/products",
      trigger_url: "https://shop.example.com/products",
      dom_extraction: { extraction_method: "dom-fallback" } as any,
      description: "Product list page",
      response_schema: {
        type: "object",
        properties: {
          products: { type: "array" },
        },
      },
      semantic: {
        action_kind: "list",
        resource_kind: "product",
        requires: [],
        example_fields: ["products[].name", "products[].price"],
      },
    });
    const skill = makeSkill({ domain: "shop.example.com", endpoints: [legit] });
    const selection = selectMarketplacePublishEndpoints(skill);
    // The phantom gate must not fire — the existing dom-fallback-only
    // post-filter will still drop a single-endpoint dom skill, but that's a
    // separate path. We're only verifying G1 didn't kill it.
    expect(selection.stats.by_reason.phantom_endpoint).toBe(0);
  });

  test("admits a DOM-extracted endpoint that takes a required user param", () => {
    const inputDriven = makeEndpoint({
      endpoint_id: "input-driven",
      url_template: "https://www.lawnet.sg/lawnet/web/lawnet/home",
      trigger_url: "https://www.lawnet.sg/lawnet/web/lawnet/home",
      dom_extraction: { extraction_method: "dom-fallback" } as any,
      response_schema: { type: "object", properties: { result: { type: "string" } } },
      semantic: {
        action_kind: "search",
        resource_kind: "judgment",
        requires: [{ key: "q", required: true, semantic_type: "input", source: "url_template" } as any],
        example_fields: ["result"],
      },
    });
    const skill = makeSkill({ domain: "lawnet.sg", endpoints: [inputDriven] });
    const selection = selectMarketplacePublishEndpoints(skill);
    expect(selection.stats.by_reason.phantom_endpoint).toBe(0);
  });
});

// Captured-error-response guard — added 2026-04-30 after harness/recursive/
// drove instagram.com and surfaced shortlist endpoints whose captured
// "successful" response was actually the API's error envelope:
// {message:"useragent mismatch", status:"fail"} or
// {errors:[{severity:"CRITICAL"}], status:"fail"}.
describe("captured_error_response admission gate", () => {
  test("rejects endpoint whose captured sample is {status:fail, message:...}", () => {
    const errorish = makeEndpoint({
      endpoint_id: "ig-useragent-mismatch",
      url_template: "https://www.instagram.com/api/v1/users/web_profile_info/?username={username}",
      response_schema: {
        type: "object",
        properties: { message: { type: "string" }, status: { type: "string" } },
      },
      semantic: {
        action_kind: "fetch",
        resource_kind: "profile",
        requires: [],
        example_fields: ["message", "status"],
        example_response_compact: { message: "useragent mismatch", status: "fail" } as any,
      },
    });
    const skill = makeSkill({ domain: "instagram.com", endpoints: [errorish] });
    const selection = selectMarketplacePublishEndpoints(skill);
    expect(selection.endpoints).toHaveLength(0);
    expect(selection.stats.by_reason.captured_error_response).toBe(1);
  });

  test("rejects graphql endpoint with errors[].severity:CRITICAL captured", () => {
    const graphqlError = makeEndpoint({
      endpoint_id: "ig-graphql-critical",
      url_template: "https://www.instagram.com/graphql/safequery",
      response_schema: {
        type: "object",
        properties: {
          message: { type: "string" },
          errors: { type: "array" },
          status: { type: "string" },
        },
      },
      semantic: {
        action_kind: "fetch",
        resource_kind: "data",
        requires: [],
        example_response_compact: {
          message: "invalid request",
          errors: [{ message: "execution error", severity: "CRITICAL" }],
          status: "fail",
        } as any,
      },
    });
    const skill = makeSkill({ domain: "instagram.com", endpoints: [graphqlError] });
    const selection = selectMarketplacePublishEndpoints(skill);
    expect(selection.stats.by_reason.captured_error_response).toBe(1);
  });

  test("admits legit endpoint that happens to include a status:'success' field", () => {
    const legit = makeEndpoint({
      endpoint_id: "legit-with-status-ok",
      url_template: "https://api.example.com/items",
      response_schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          items: { type: "array" },
        },
      },
      semantic: {
        action_kind: "list",
        resource_kind: "item",
        requires: [],
        example_response_compact: { status: "ok", items: [{ id: 1 }] } as any,
      },
    });
    const skill = makeSkill({ domain: "api.example.com", endpoints: [legit] });
    const selection = selectMarketplacePublishEndpoints(skill);
    expect(selection.stats.by_reason.captured_error_response).toBe(0);
  });

  test("admits endpoint with status:'fail' in body but real content fields beyond error keys", () => {
    // E.g., a search returning {results: [...], status: "fail"} for a partial result.
    // Only the schema being purely error-shaped triggers the filter.
    const partialFail = makeEndpoint({
      endpoint_id: "partial-fail-with-content",
      url_template: "https://api.example.com/search",
      response_schema: {
        type: "object",
        properties: {
          results: { type: "array" },
          status: { type: "string" },
        },
      },
      semantic: {
        requires: [],
        example_response_compact: { results: [], status: "fail" } as any,
      },
    });
    const skill = makeSkill({ domain: "api.example.com", endpoints: [partialFail] });
    const selection = selectMarketplacePublishEndpoints(skill);
    expect(selection.stats.by_reason.captured_error_response).toBe(0);
  });
});
