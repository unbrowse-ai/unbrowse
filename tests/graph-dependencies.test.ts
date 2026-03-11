import { describe, expect, it } from "bun:test";
import { buildSkillOperationGraph, inferEndpointSemantic } from "../src/graph/index.js";
import type { EndpointDescriptor } from "../src/types/index.js";

describe("graph dependency inference", () => {
  it("creates dependency edges when one operation provides the binding another requires", () => {
    const endpoints: EndpointDescriptor[] = [
      {
        endpoint_id: "repo-search",
        method: "GET",
        url_template: "https://api.example.com/search/repositories?q={q}",
        description: "Search repositories",
        query: { q: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: {
          action_kind: "search",
          resource_kind: "repository",
          description_in: "Requires q",
          description_out: "Returns repositories",
          response_summary: "repository_name, repo_id",
          example_fields: ["items[].full_name", "items[].id"],
          requires: [{ key: "q", required: false, source: "query", semantic_type: "query_text" }],
          provides: [
            { key: "repo_id", source: "response", semantic_type: "repository_identifier" },
            { key: "repository_name", source: "response", semantic_type: "repository_name" },
          ],
          negative_tags: [],
          confidence: 0.9,
          observed_at: "2026-03-07T10:00:00.000Z",
        },
      },
      {
        endpoint_id: "repo-detail",
        method: "GET",
        url_template: "https://api.example.com/repositories/{repo_id}",
        description: "Get repository details",
        path_params: { repo_id: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: {
          action_kind: "detail",
          resource_kind: "repository",
          description_in: "Requires repo_id",
          description_out: "Returns repository details",
          response_summary: "repository fields",
          example_fields: ["id", "full_name"],
          requires: [{ key: "repo_id", required: true, source: "path_params", semantic_type: "repository_identifier" }],
          provides: [{ key: "repo_id", source: "response", semantic_type: "repository_identifier" }],
          negative_tags: [],
          confidence: 0.9,
          observed_at: "2026-03-07T10:00:01.000Z",
        },
      },
    ];

    const graph = buildSkillOperationGraph(endpoints);
    const edge = graph.edges.find((candidate) => candidate.edge_id === "repo-search:repo-detail:repo_id");

    expect(edge).toBeDefined();
    expect(edge?.kind).toBe("dependency");
    expect(edge?.binding_key).toBe("repo_id");
    expect(graph.entry_operation_ids).toContain("repo-search");
    expect(graph.entry_operation_ids).not.toContain("repo-detail");
  });

  it("creates hint edges on semantic-type matches and rejects reverse-time edges", () => {
    const endpoints: EndpointDescriptor[] = [
      {
        endpoint_id: "profile-search",
        method: "GET",
        url_template: "https://api.example.com/search/people?q={q}",
        description: "Search people",
        query: { q: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: {
          action_kind: "search",
          resource_kind: "person",
          description_in: "Requires q",
          description_out: "Returns people",
          response_summary: "public_identifier",
          example_fields: ["elements[].public_identifier", "elements[].name"],
          requires: [{ key: "q", required: false, source: "query", semantic_type: "query_text" }],
          provides: [{ key: "public_identifier", source: "response", semantic_type: "profile_identifier" }],
          negative_tags: [],
          confidence: 0.9,
          observed_at: "2026-03-07T10:00:00.000Z",
        },
      },
      {
        endpoint_id: "profile-detail",
        method: "GET",
        url_template: "https://api.example.com/profile/{profile_id}",
        description: "Get profile",
        path_params: { profile_id: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: {
          action_kind: "detail",
          resource_kind: "person",
          description_in: "Requires profile_id",
          description_out: "Returns profile",
          response_summary: "profile fields",
          example_fields: ["id", "name"],
          requires: [{ key: "profile_id", required: true, source: "path_params", semantic_type: "profile_identifier" }],
          provides: [{ key: "profile_id", source: "response", semantic_type: "profile_identifier" }],
          negative_tags: [],
          confidence: 0.9,
          observed_at: "2026-03-07T10:00:01.000Z",
        },
      },
      {
        endpoint_id: "late-search",
        method: "GET",
        url_template: "https://api.example.com/search/people?q={q}",
        description: "Late search",
        query: { q: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: {
          action_kind: "search",
          resource_kind: "person",
          description_in: "Requires q",
          description_out: "Returns people",
          response_summary: "public_identifier",
          example_fields: ["elements[].public_identifier"],
          requires: [{ key: "q", required: false, source: "query", semantic_type: "query_text" }],
          provides: [{ key: "public_identifier", source: "response", semantic_type: "profile_identifier" }],
          negative_tags: [],
          confidence: 0.9,
          observed_at: "2026-03-07T10:00:02.000Z",
        },
      },
      {
        endpoint_id: "early-detail",
        method: "GET",
        url_template: "https://api.example.com/profile/{profile_id}",
        description: "Early profile",
        path_params: { profile_id: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: {
          action_kind: "detail",
          resource_kind: "person",
          description_in: "Requires profile_id",
          description_out: "Returns profile",
          response_summary: "profile fields",
          example_fields: ["id", "name"],
          requires: [{ key: "profile_id", required: true, source: "path_params", semantic_type: "profile_identifier" }],
          provides: [{ key: "profile_id", source: "response", semantic_type: "profile_identifier" }],
          negative_tags: [],
          confidence: 0.9,
          observed_at: "2026-03-07T10:00:01.000Z",
        },
      },
    ];

    const graph = buildSkillOperationGraph(endpoints);
    const hintEdge = graph.edges.find((candidate) => candidate.edge_id === "profile-search:profile-detail:profile_id");
    const reverseTimeEdge = graph.edges.find((candidate) => candidate.edge_id === "late-search:early-detail:profile_id");

    expect(hintEdge).toBeDefined();
    expect(hintEdge?.kind).toBe("hint");
    expect(hintEdge?.confidence).toBe(0.6);
    expect(reverseTimeEdge).toBeUndefined();
  });

  it("infers dropdown bindings from DOM-extracted form nodes and links them into downstream api steps", () => {
    const formEndpoint: EndpointDescriptor = {
      endpoint_id: "jobs-form-options",
      method: "GET",
      url_template: "https://jobs.example.com/roles",
      description: "Job search form with department and location dropdowns",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      dom_extraction: {
        extraction_method: "form-options",
        confidence: 0.95,
        selector: "form[data-role='job-search']",
      },
      semantic: inferEndpointSemantic({
        endpoint_id: "jobs-form-options",
        method: "GET",
        url_template: "https://jobs.example.com/roles",
        description: "Job search form with department and location dropdowns",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        dom_extraction: {
          extraction_method: "form-options",
          confidence: 0.95,
          selector: "form[data-role='job-search']",
        },
      }, {
        sampleResponse: {
          department_options: [{ label: "Engineering", value: "eng" }],
          location_options: [{ label: "Remote", value: "remote" }],
        },
        sampleRequestUrl: "https://jobs.example.com/roles",
        observedAt: "2026-03-09T10:00:00.000Z",
      }),
    };

    const searchEndpoint: EndpointDescriptor = {
      endpoint_id: "jobs-search",
      method: "GET",
      url_template: "https://jobs.example.com/api/jobs?department={department}&location={location}",
      description: "Search jobs",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
      semantic: {
        action_kind: "search",
        resource_kind: "job",
        description_in: "Requires department and location",
        description_out: "Searches jobs using selected filters",
        response_summary: "jobs[].job_id, jobs[].title",
        example_fields: ["jobs[].job_id", "jobs[].title"],
        requires: [
          { key: "department", required: true, source: "query", semantic_type: "department_option" },
          { key: "location", required: true, source: "query", semantic_type: "location_option" },
        ],
        provides: [{ key: "job_id", source: "response", semantic_type: "job_identifier" }],
        negative_tags: [],
        confidence: 0.95,
        observed_at: "2026-03-09T10:00:01.000Z",
      },
    };

    expect(formEndpoint.semantic?.resource_kind).toBe("form");
    expect(formEndpoint.semantic?.provides?.map((binding) => binding.key)).toContain("department");
    expect(formEndpoint.semantic?.provides?.map((binding) => binding.key)).toContain("location");

    const graph = buildSkillOperationGraph([formEndpoint, searchEndpoint]);
    expect(graph.entry_operation_ids).toContain("jobs-form-options");
    expect(graph.edges.some((edge) => edge.edge_id === "jobs-form-options:jobs-search:department")).toBe(true);
    expect(graph.edges.some((edge) => edge.edge_id === "jobs-form-options:jobs-search:location")).toBe(true);
    expect(graph.edges).toHaveLength(2);
  });
});
