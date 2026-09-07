import { describe, expect, it } from "bun:test";
import { buildSkillOperationGraph } from "../src/lib/graph-core/index.js";
import type { EndpointDescriptor } from "../src/types/index.js";

describe("graph provides inference", () => {
  it("infers repository and profile identifiers from real-ish response fields", () => {
    const endpoints: EndpointDescriptor[] = [
      {
        endpoint_id: "github-search",
        method: "GET",
        url_template: "https://api.github.com/search/repositories?q={q}",
        description: "Searches repositories and returns repository full names",
        query: { q: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        response_schema: {
          type: "object",
          inferred_from_samples: 1,
          properties: {
            items: {
              type: "array",
              inferred_from_samples: 1,
              items: {
                type: "object",
                inferred_from_samples: 1,
                properties: {
                  full_name: { type: "string", inferred_from_samples: 1 },
                  owner: { type: "string", inferred_from_samples: 1 },
                },
              },
            },
          },
        },
      },
      {
        endpoint_id: "linkedin-search",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/search/people?q={q}",
        description: "Searches people and returns public identifiers",
        query: { q: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        response_schema: {
          type: "object",
          inferred_from_samples: 1,
          properties: {
            profiles: {
              type: "array",
              inferred_from_samples: 1,
              items: {
                type: "object",
                inferred_from_samples: 1,
                properties: {
                  public_identifier: { type: "string", inferred_from_samples: 1 },
                  name: { type: "string", inferred_from_samples: 1 },
                },
              },
            },
          },
        },
      },
    ];

    const graph = buildSkillOperationGraph(endpoints);
    const github = graph.operations.find((operation) => operation.operation_id === "github-search");
    const linkedin = graph.operations.find((operation) => operation.operation_id === "linkedin-search");

    expect(github?.provides.some((binding) => binding.key === "repo")).toBe(true);
    expect(github?.provides.some((binding) => binding.key === "repository_name")).toBe(true);
    expect(github?.provides.some((binding) => binding.key === "repository_name" && binding.semantic_type === "repository_name")).toBe(true);

    expect(linkedin?.provides.some((binding) => binding.key === "public_identifier")).toBe(true);
    expect(linkedin?.provides.some((binding) => binding.key === "profile_id")).toBe(true);
    expect(linkedin?.provides.some((binding) => binding.key === "profile_name")).toBe(true);
  });
});
