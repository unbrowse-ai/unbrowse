import { describe, expect, it } from "bun:test";
import { mergeEndpoints } from "../src/marketplace/index.js";
import type { EndpointDescriptor } from "../src/types/index.js";

function endpoint(overrides: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "endpoint-old",
    method: "GET",
    url_template: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.aaaaaaaaaaaaaaaa?variables={variables}&queryId={queryId}",
    description: "Returns details for Voyager",
    idempotency: "safe",
    verification_status: "unverified",
    reliability_score: 0.5,
    ...overrides,
  };
}

describe("mergeEndpoints", () => {
  it("refreshes duplicate endpoint metadata while preserving stable ids", () => {
    const existing = endpoint({
      endpoint_id: "stable-id",
      semantic: { action_kind: "timeline", resource_kind: "resource" } as any,
      response_schema: { type: "object", properties: { data: { type: "object" } } } as any,
    });
    const incoming = endpoint({
      endpoint_id: "new-id",
      url_template: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.bbbbbbbbbbbbbbbb?variables={variables}&queryId={queryId}",
      description: "Returns member feed posts",
      semantic: { action_kind: "timeline", resource_kind: "post" } as any,
      response_schema: { type: "object", properties: { included: { type: "array" } } } as any,
      query: { variables: "(start:0,count:3)", queryId: "voyagerFeedDashMainFeed.bbbbbbbbbbbbbbbb" },
      trigger_url: "https://www.linkedin.com/feed/",
    });

    const merged = mergeEndpoints([existing], [incoming]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.endpoint_id).toBe("stable-id");
    expect(merged[0]?.description).toBe("Returns member feed posts");
    expect(merged[0]?.semantic?.resource_kind).toBe("post");
    expect(merged[0]?.response_schema?.properties?.included?.type).toBe("array");
    expect(merged[0]?.query?.queryId).toBe("voyagerFeedDashMainFeed.bbbbbbbbbbbbbbbb");
  });

  it("preserves csrf_plan, oauth_plan, body_params, search_form, policy, graph_visibility, corroboration when incoming lacks them", () => {
    const existing = endpoint({
      csrf_plan: { token_source: "header", token_name: "x-csrf-token" } as any,
      oauth_plan: { flow: "authorization_code" } as any,
      body_params: { sort: "asc" },
      search_form: { form_selector: "form#search", submit_selector: "button", fields: [] } as any,
      policy: { third_party_terms: true } as any,
      graph_visibility: "public",
      corroboration: { agent_count: 3, last_corroborated_at: "2026-04-01" } as any,
    });
    const incoming = endpoint({
      endpoint_id: "new-id",
      description: "Updated description",
    });

    const merged = mergeEndpoints([existing], [incoming]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.csrf_plan).toEqual({ token_source: "header", token_name: "x-csrf-token" });
    expect(merged[0]?.oauth_plan).toEqual({ flow: "authorization_code" });
    expect(merged[0]?.body_params).toEqual({ sort: "asc" });
    expect(merged[0]?.search_form?.form_selector).toBe("form#search");
    expect(merged[0]?.policy).toEqual({ third_party_terms: true });
    expect(merged[0]?.graph_visibility).toBe("public");
    expect(merged[0]?.corroboration?.agent_count).toBe(3);
    // incoming wins for fields it does have
    expect(merged[0]?.description).toBe("Updated description");
    // stable id preserved
    expect(merged[0]?.endpoint_id).toBe("endpoint-old");
  });

  it("incoming overrides existing when both have the same optional field", () => {
    const existing = endpoint({
      csrf_plan: { token_source: "header", token_name: "old-csrf" } as any,
      policy: { third_party_terms: false } as any,
    });
    const incoming = endpoint({
      csrf_plan: { token_source: "meta", token_name: "new-csrf" } as any,
      policy: { third_party_terms: true } as any,
    });

    const merged = mergeEndpoints([existing], [incoming]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.csrf_plan).toEqual({ token_source: "meta", token_name: "new-csrf" });
    expect(merged[0]?.policy).toEqual({ third_party_terms: true });
  });

  it("preserves existing headers_template when incoming has empty object", () => {
    const existing = endpoint({
      headers_template: { "x-twitter-auth-type": "OAuth2Session", "authorization": "Bearer xyz" },
    });
    const incoming = endpoint({
      headers_template: {},
      description: "Updated",
    });

    const merged = mergeEndpoints([existing], [incoming]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.headers_template?.["x-twitter-auth-type"]).toBe("OAuth2Session");
    expect(merged[0]?.headers_template?.["authorization"]).toBe("Bearer xyz");
  });
});
