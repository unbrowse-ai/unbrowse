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
  it("refreshes duplicate endpoint metadata while preserving stable ids and learned strategy", () => {
    const existing = endpoint({
      endpoint_id: "stable-id",
      exec_strategy: "browser",
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
    expect(merged[0]?.exec_strategy).toBe("browser");
    expect(merged[0]?.description).toBe("Returns member feed posts");
    expect(merged[0]?.semantic?.resource_kind).toBe("post");
    expect(merged[0]?.response_schema?.properties?.included?.type).toBe("array");
    expect(merged[0]?.query?.queryId).toBe("voyagerFeedDashMainFeed.bbbbbbbbbbbbbbbb");
  });
});
