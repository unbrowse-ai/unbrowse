import { describe, expect, it } from "bun:test";
import { resolveExecutionUrlTemplate } from "../src/execution/index.js";
import type { EndpointDescriptor } from "../src/types/index.js";

function endpoint(overrides: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://x.com/",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 1,
    description: "Captured page artifact",
    ...overrides,
  };
}

describe("resolveExecutionUrlTemplate", () => {
  it("prefers context url for document replay endpoints", () => {
    expect(
      resolveExecutionUrlTemplate(
        endpoint({ url_template: "https://x.com/" }),
        "https://x.com/OpenAI",
      ),
    ).toBe("https://x.com/OpenAI");
  });

  it("keeps api endpoints on their captured url", () => {
    expect(
      resolveExecutionUrlTemplate(
        endpoint({ url_template: "https://x.com/i/api/graphql/UserByScreenName" }),
        "https://x.com/OpenAI",
      ),
    ).toBe("https://x.com/i/api/graphql/UserByScreenName");
  });

  it("keeps document endpoint when method is not get", () => {
    expect(
      resolveExecutionUrlTemplate(
        endpoint({ method: "POST", url_template: "https://x.com/" }),
        "https://x.com/OpenAI",
      ),
    ).toBe("https://x.com/");
  });
});
