import { describe, expect, it } from "bun:test";
import { resolveEndpointTemplateBindings } from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

function makeEndpoint(overrides: Partial<SkillManifest["endpoints"][number]> = {}): SkillManifest["endpoints"][number] {
  return {
    endpoint_id: "ep-1",
    method: "GET",
    url_template: "https://x.com/i/api/graphql/query/SearchTimeline?variables={variables}&features={features}",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    query: {
      variables: "{\"rawQuery\":\"openai\",\"count\":20,\"product\":\"Latest\"}",
      features: "{\"responsive_web_graphql_timeline_navigation_enabled\":true}",
    },
    semantic: {
      action_kind: "search",
      resource_kind: "post",
      description_in: "Requires variables, features",
      description_out: "Returns search timeline data",
    },
    ...overrides,
  };
}

describe("resolveEndpointTemplateBindings", () => {
  it("treats captured query defaults as satisfiable bindings", () => {
    const endpoint = makeEndpoint();
    const out = resolveEndpointTemplateBindings(
      endpoint,
      { q: "openai" },
      "https://x.com/search?q=openai&src=typed_query&f=live",
    );

    expect(out.variables).toContain("\"rawQuery\":\"openai\"");
    expect(out.features).toContain("responsive_web_graphql_timeline_navigation_enabled");
  });

  it("fills from semantic example_request when query defaults are absent", () => {
    const endpoint = makeEndpoint({
      query: undefined,
      semantic: {
        action_kind: "search",
        resource_kind: "person",
        description_in: "Requires keywords, type",
        description_out: "Returns people search rows",
        example_request: {
          keywords: "openai",
          type: "accounts",
        },
      },
      url_template: "https://www.linkedin.com/search/results/people/?keywords={keywords}&type={type}",
    });

    const out = resolveEndpointTemplateBindings(endpoint, {}, "https://www.linkedin.com/search/results/people/?keywords=openai");

    expect(out.keywords).toBe("openai");
    expect(out.type).toBe("accounts");
  });

  it("maps indexed raw query params onto normalized template bindings", () => {
    const endpoint = makeEndpoint({
      url_template:
        "https://example.com/jobs?filters%5B0%5D%5Bvalue%5D={filters_0_value}&filters%5B1%5D%5Bvalue%5D={filters_1_value}",
      query: {
        "filters[0][value]": "sf",
        "filters[1][value]": "eng",
      },
    });

    const out = resolveEndpointTemplateBindings(endpoint, {
      "filters[0][value]": "nyc",
      filters_1_value: "design",
    });

    expect(out.filters_0_value).toBe("nyc");
    expect(out["filters[0][value]"]).toBe("nyc");
    expect(out.filters_1_value).toBe("design");
    expect(out["filters[1][value]"]).toBe("design");
  });
});
