import { describe, expect, it } from "bun:test";
import { canUseTriggerIntercept, resolveTriggerInterceptTargetUrl } from "../src/execution/index.js";
import type { EndpointDescriptor } from "../src/types/index.js";

function makeEndpoint(overrides: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://example.com/api",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    ...overrides,
  };
}

describe("trigger-intercept strategy", () => {
  it("allows safe POST endpoints with a trigger page", () => {
    expect(
      canUseTriggerIntercept(
        makeEndpoint({
          method: "POST",
          trigger_url: "https://example.com/search",
          idempotency: "safe",
        }),
      ),
    ).toBe(true);
  });

  it("rejects unsafe POST endpoints even with a trigger page", () => {
    expect(
      canUseTriggerIntercept(
        makeEndpoint({
          method: "POST",
          trigger_url: "https://example.com/search",
          idempotency: "unsafe",
        }),
      ),
    ).toBe(false);
  });

  it("uses the resolved URL for trigger-intercept instead of the raw template", () => {
    expect(
      resolveTriggerInterceptTargetUrl(
        "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
        "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
        false,
      ),
    ).toBe("https://www.lawnet.sg/lawnet/group/lawnet/result-page");
  });

  it("uses the structured replay URL when available", () => {
    expect(
      resolveTriggerInterceptTargetUrl(
        "https://www.example.com/page",
        "https://www.example.com/api/search?q=test",
        true,
      ),
    ).toBe("https://www.example.com/api/search?q=test");
  });
});
