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

  it("keeps captured url_template when it carries template placeholders", () => {
    // Regression: executor-drops-url-template-and-params.
    // beatsaver capture observed: url_template = "https://beatsaver.com/?q={q}"
    // (an SSR search endpoint with a meaningful template var). When the agent
    // calls execute with contextUrl "https://beatsaver.com/" (no querystring),
    // swapping the captured template for the bare contextUrl discards the
    // {q} placeholder, interpolate() can no longer substitute params with
    // q=camellia, and the request collapses to the homepage. Three distinct
    // templated endpoints all probe the same 5514B homepage in that mode.
    expect(
      resolveExecutionUrlTemplate(
        endpoint({ url_template: "https://beatsaver.com/?q={q}" }),
        "https://beatsaver.com/",
      ),
    ).toBe("https://beatsaver.com/?q={q}");
  });

  it("keeps captured url_template when it carries a non-trivial querystring", () => {
    // Companion case: capture observed a concrete search URL (no placeholder
    // yet, before templatification). The querystring is the intent-bearing
    // signal. Overwriting with a bare contextUrl loses that signal.
    expect(
      resolveExecutionUrlTemplate(
        endpoint({ url_template: "https://beatsaver.com/?q=camellia" }),
        "https://beatsaver.com/",
      ),
    ).toBe("https://beatsaver.com/?q=camellia");
  });

  it("keeps captured url_template path when it has segments beyond root", () => {
    // Same root regression: url_template "/maps/{id}" must not be flattened
    // to the bare contextUrl "/", the templated path IS what distinguishes
    // this endpoint from sibling endpoints in the same skill.
    expect(
      resolveExecutionUrlTemplate(
        endpoint({ url_template: "https://beatsaver.com/maps/{id}" }),
        "https://beatsaver.com/",
      ),
    ).toBe("https://beatsaver.com/maps/{id}");
  });

  it("still prefers a richer contextUrl when url_template is bare root", () => {
    // Guard against regression of the original document-replay behavior:
    // when url_template is truly bare (no template vars, no querystring,
    // no path beyond root), the contextUrl IS the more specific target.
    expect(
      resolveExecutionUrlTemplate(
        endpoint({ url_template: "https://beatsaver.com/" }),
        "https://beatsaver.com/maps/abc123",
      ),
    ).toBe("https://beatsaver.com/maps/abc123");
  });
});
