import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEndpointReviewContext } from "../src/publish/review-context.js";
import { mergeAgentReview } from "../src/lib/indexer-core/index.js";
import { applyWorkflowSchemaReviews } from "../src/publish/schema-review.js";
import { writeWorkflowArtifact } from "../src/workflow/artifact.js";
import type { EndpointDescriptor, SkillManifest, WorkflowArtifact } from "../src/types/skill.js";

function endpoint(overrides: Partial<EndpointDescriptor> & { endpoint_id: string; url_template: string }): EndpointDescriptor {
  return {
    method: "GET",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    ...overrides,
  };
}

function skill(endpoints: EndpointDescriptor[]): SkillManifest {
  return {
    skill_id: "skill-test",
    version: "1.0.0",
    schema_version: "1",
    name: "example.com",
    intent_signature: "search items",
    domain: "example.com",
    description: "test skill",
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    endpoints,
  };
}

const originalConfigDir = process.env.UNBROWSE_CONFIG_DIR;

afterEach(() => {
  process.env.UNBROWSE_CONFIG_DIR = originalConfigDir;
});

describe("publish review context", () => {
  test("includes dependency and unlock context for endpoint review", () => {
    const s = skill([
      endpoint({
        endpoint_id: "search",
        url_template: "https://api.example.com/search?q={q}",
        trigger_url: "https://example.com/search?q=openai",
        description: "Search items",
        semantic: {
          action_kind: "search",
          resource_kind: "item",
          description_out: "Search items",
          requires: [],
          provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
        } as any,
      }),
      endpoint({
        endpoint_id: "detail",
        url_template: "https://api.example.com/items/{item_id}",
        trigger_url: "https://example.com/search?q=openai",
        description: "Get item detail",
        semantic: {
          action_kind: "detail",
          resource_kind: "item",
          description_out: "Get item detail",
          requires: [{ key: "item_id", required: true, source: "url_template", semantic_type: "item_identifier" }],
          provides: [{ key: "seller_id", source: "response", semantic_type: "seller_identifier" }],
        } as any,
      }),
      endpoint({
        endpoint_id: "seller",
        url_template: "https://api.example.com/sellers/{seller_id}",
        trigger_url: "https://example.com/search?q=openai",
        description: "Get seller detail",
        semantic: {
          action_kind: "detail",
          resource_kind: "seller",
          description_out: "Get seller detail",
          requires: [{ key: "seller_id", required: true, source: "url_template", semantic_type: "seller_identifier" }],
          provides: [],
        } as any,
      }),
    ]);

    const ctx = buildEndpointReviewContext(s, "detail");

    expect(ctx).toBeTruthy();
    expect(ctx?.provenance).toBe("http_replay");
    expect(ctx?.trigger_url).toBe("https://example.com/search?q=openai");
    expect(Array.isArray(ctx?.dependencies)).toBe(true);
    expect(Array.isArray(ctx?.unlocks)).toBe(true);
    expect((ctx?.dependencies as Array<Record<string, unknown>>)[0]?.endpoint_id).toBe("search");
    expect((ctx?.unlocks as Array<Record<string, unknown>>)[0]?.endpoint_id).toBe("seller");
    expect((ctx?.trigger_siblings as Array<Record<string, unknown>>).length).toBe(2);
  });

  test("includes raw path binding candidate evidence for review", () => {
    const s = skill([
      endpoint({
        endpoint_id: "module-detail",
        url_template: "https://api.nusmods.com/v2/{academic_year}/modules/{module_code}.json",
        path_params: { academic_year: "2025-2026", module_code: "ABM5001" },
        _path_binding_candidates: [
          {
            placeholder: "path_2",
            observed_value: "2025-2026",
            segment_index: 2,
            source: "segment_pattern",
            preceding_segment: "v2",
          },
          {
            placeholder: "path_4",
            observed_value: "ABM5001",
            segment_index: 4,
            source: "file_basename",
            preceding_segment: "modules",
            filename_suffix: ".json",
          },
        ],
        semantic: {
          action_kind: "detail",
          resource_kind: "module",
          description_out: "Returns module details",
          requires: [
            { key: "academic_year", required: false, source: "path_params", semantic_type: "academic_year" },
            { key: "module_code", required: false, source: "path_params", semantic_type: "module_code" },
          ],
          provides: [],
        } as any,
      }),
    ]);

    const ctx = buildEndpointReviewContext(s, "module-detail");
    expect((ctx?.path_binding_candidates as Array<Record<string, unknown>>)[0]?.observed_value).toBe("2025-2026");
    expect((ctx?.path_binding_candidates as Array<Record<string, unknown>>)[1]?.preceding_segment).toBe("modules");
  });

  test("mergeAgentReview stamps reviewed descriptions as agent-authored", () => {
    const endpoints = [
      endpoint({
        endpoint_id: "feed",
        url_template: "https://example.com/feed",
        description: "Captured page artifact for get feed posts",
        semantic: {
          action_kind: "search",
          resource_kind: "post",
          description_out: "Returns posts timeline",
          description_source: "auto",
          description_needs_review: true,
          description_warning: "Auto-generated description. Review before trusting or publishing.",
        } as any,
      }),
    ];

    const updated = mergeAgentReview(endpoints, [
      {
        endpoint_id: "feed",
        description: "Returns the main feed posts for the signed-in member",
        action_kind: "timeline",
        resource_kind: "post",
      },
    ]);

    expect(updated[0]?.description).toBe("Returns the main feed posts for the signed-in member");
    expect(updated[0]?.semantic?.description_out).toBe("Returns the main feed posts for the signed-in member");
    expect(updated[0]?.semantic?.description_source).toBe("agent");
    expect(updated[0]?.semantic?.description_needs_review).toBe(false);
    expect(updated[0]?.semantic?.description_warning).toBeUndefined();
  });

  test("mergeAgentReview patches response schema fields from review input", () => {
    const endpoints = [
      endpoint({
        endpoint_id: "feed",
        url_template: "https://example.com/feed",
        description: "Captured page artifact for get feed posts",
        response_schema: {
          type: "array",
          inferred_from_samples: 1,
          items: {
            type: "object",
            inferred_from_samples: 1,
            properties: {
              status: { type: "string", inferred_from_samples: 1 },
              title: { type: "string", inferred_from_samples: 1 },
            },
          },
        },
      }),
    ];

    const updated = mergeAgentReview(endpoints, [
      {
        endpoint_id: "feed",
        response_reviews: [
          { path: "[].status", description: "Lifecycle status of the feed item", enum_values: ["draft", "published"] },
        ],
      },
    ]);

    expect(updated[0]?.response_schema?.items?.properties?.status?.description).toBe("Lifecycle status of the feed item");
    expect(updated[0]?.response_schema?.items?.properties?.status?.enum_values).toEqual(["draft", "published"]);
  });

  test("review context includes request and response schema details", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unbrowse-review-context-"));
    process.env.UNBROWSE_CONFIG_DIR = tmp;

    const s = skill([
      endpoint({
        endpoint_id: "submit",
        method: "POST",
        url_template: "https://example.com/api/checkout",
        trigger_url: "https://example.com/checkout",
        description: "Submit checkout",
        response_schema: {
          type: "object",
          inferred_from_samples: 1,
          properties: {
            order_id: { type: "string", inferred_from_samples: 1, description: "Created order id" },
            status: { type: "string", inferred_from_samples: 1, enum_values: ["pending", "paid"] },
          },
          required: ["order_id"],
        },
        semantic: {
          action_kind: "create",
          resource_kind: "checkout",
          description_out: "Create checkout",
          requires: [{ key: "item_id", required: true }],
          provides: [{ key: "order_id", source: "response" }],
        } as any,
      }),
    ]);

    const artifact: WorkflowArtifact = {
      artifact_version: "1",
      skill_id: s.skill_id,
      domain: s.domain,
      intent_signature: s.intent_signature,
      captured_at: new Date().toISOString(),
      final_url: "https://example.com/review",
      auth_state: { cookie_names: ["csrftoken"], header_names: ["x-csrf-token"], authenticated: true },
      evidence: {
        observed_request_count: 1,
        observed_request_urls: ["https://example.com/api/checkout"],
        har_lineage_ids: ["har-1"],
        trigger_urls: ["https://example.com/checkout"],
        js_bundle_urls: [],
        dom_form_hints: [],
        dom_option_hints: [],
        meta_hints: [],
        bootstrap_hints: [],
      },
      recipes: [
        {
          recipe_id: "recipe-1",
          endpoint_id: "submit",
          preferred: true,
          provenance_backed: true,
          steps: [],
          token_bindings: [
            {
              binding_id: "binding-1",
              target_location: "header",
              target_name: "x-csrf-token",
              refresh_on_statuses: [401, 403],
              candidates: [{ source_kind: "cookie", source_name: "csrftoken", confidence: 0.99 }],
            },
          ],
          mutation_guard: {
            confirm_unsafe_required: true,
            provenance_backed: true,
            auth_required: true,
            parameter_mapping_confident: true,
          },
          replay_contract: {
            explicit_replay_only: true,
            exposure_stage: "publish",
            dependency_bindings: ["item_id", "x-csrf-token"],
            search_terms: ["checkout"],
            parameter_specs: [
              {
                name: "item_id",
                location: "body",
                description: "Checkout item id",
                type: "string",
                required: true,
                user_supplied: true,
                example_value: "sku_1",
                source_hints: [{ source_kind: "body_default", source_name: "item_id", confidence: 0.95 }],
              },
              {
                name: "x-csrf-token",
                location: "header",
                description: "Derived csrf header",
                type: "string",
                required: true,
                user_supplied: false,
                derived_from: ["cookie:csrftoken"],
                source_hints: [{ source_kind: "cookie", source_name: "csrftoken", confidence: 0.99 }],
              },
            ],
            prerequisite_specs: [],
            next_state: [{ kind: "response_schema", value: "order_id,status" }],
            payment_requirement: { status: "free", wallet_required: false },
          },
        },
      ],
    };
    writeWorkflowArtifact(artifact);

    const ctx = buildEndpointReviewContext(s, "submit");
    const requestSchema = ctx?.request_schema as Array<Record<string, unknown>>;
    const responseSchema = ctx?.response_schema as Array<Record<string, unknown>>;

    expect(requestSchema[0]?.name).toBe("item_id");
    expect(requestSchema[1]?.derived_from).toEqual(["cookie:csrftoken"]);
    expect(responseSchema.some((field) => field.path === "order_id" && field.required === true)).toBe(true);
    expect(responseSchema.some((field) => field.path === "status" && Array.isArray(field.enum_values))).toBe(true);
    expect(Array.isArray(ctx?.token_bindings)).toBe(true);
  });

  test("workflow schema reviews patch parameter specs in workflow artifacts", () => {
    const artifact: WorkflowArtifact = {
      artifact_version: "1",
      skill_id: "skill-test",
      domain: "example.com",
      intent_signature: "search items",
      captured_at: new Date().toISOString(),
      final_url: "https://example.com/search",
      auth_state: { cookie_names: [], header_names: [], authenticated: false },
      evidence: {
        observed_request_count: 1,
        observed_request_urls: ["https://example.com/search"],
        har_lineage_ids: ["har-1"],
        trigger_urls: [],
        js_bundle_urls: [],
        dom_form_hints: [],
        dom_option_hints: [],
        meta_hints: [],
        bootstrap_hints: [],
      },
      recipes: [
        {
          recipe_id: "recipe-1",
          endpoint_id: "feed",
          preferred: true,
          provenance_backed: true,
          steps: [],
          token_bindings: [],
          mutation_guard: {
            confirm_unsafe_required: false,
            provenance_backed: true,
            auth_required: false,
            parameter_mapping_confident: true,
          },
          replay_contract: {
            explicit_replay_only: true,
            exposure_stage: "publish",
            dependency_bindings: ["audience"],
            search_terms: ["feed"],
            parameter_specs: [
              {
                name: "audience",
                location: "query",
                type: "string",
                required: false,
                user_supplied: true,
                source_hints: [{ source_kind: "query_default", source_name: "audience", confidence: 0.9 }],
              },
            ],
            prerequisite_specs: [],
            next_state: [],
            payment_requirement: { status: "free", wallet_required: false },
          },
        },
      ],
    };

    const updated = applyWorkflowSchemaReviews(artifact, [
      {
        endpoint_id: "feed",
        parameter_reviews: [
          {
            name: "audience",
            location: "query",
            description: "Filter audience scope",
            enum_values: ["all", "connections"],
            required: true,
          },
        ],
      },
    ]);

    expect(updated?.recipes[0]?.replay_contract.parameter_specs[0]?.description).toBe("Filter audience scope");
    expect(updated?.recipes[0]?.replay_contract.parameter_specs[0]?.enum_values).toEqual(["all", "connections"]);
    expect(updated?.recipes[0]?.replay_contract.parameter_specs[0]?.required).toBe(true);
  });

  test("review context includes hint edges from potential binding linkages", () => {
    const s = skill([
      endpoint({
        endpoint_id: "people-dom-search",
        url_template: "https://www.linkedin.com/search/results/people/?keywords={keywords}",
        trigger_url: "https://www.linkedin.com/search/results/people/?keywords=openai",
        description: "Captured page artifact for search people",
        semantic: {
          action_kind: "search",
          resource_kind: "profile",
          description_out: "Returns people search rows",
          requires: [],
          provides: [{ key: "public_identifier", source: "response", semantic_type: "profile_identifier" }],
        } as any,
      }),
      endpoint({
        endpoint_id: "member-api-detail",
        url_template: "https://www.linkedin.com/voyager/api/identity/profiles/{member_id}",
        trigger_url: "https://www.linkedin.com/search/results/people/?keywords=openai",
        description: "Returns member detail",
        semantic: {
          action_kind: "detail",
          resource_kind: "member",
          description_out: "Returns member detail",
          requires: [{ key: "member_id", required: true, source: "path_params", semantic_type: "member_identifier" }],
          provides: [],
        } as any,
      }),
    ]);

    const ctx = buildEndpointReviewContext(s, "member-api-detail");
    const deps = ctx?.dependencies as Array<Record<string, unknown>>;

    expect(deps.length).toBe(1);
    expect(deps[0]?.endpoint_id).toBe("people-dom-search");
    expect(deps[0]?.kind).toBe("hint");
  });
});
