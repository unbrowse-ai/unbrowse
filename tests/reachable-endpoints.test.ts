import { describe, expect, it } from "bun:test";
import { buildSkillOperationGraph, computeReachableEndpoints, isRunnable } from "../src/lib/graph-core/index.js";
import type { EndpointDescriptor, SkillOperationGraph } from "../src/types/index.js";

/**
 * Helper to build a minimal EndpointDescriptor with semantic bindings.
 */
function endpoint(
  endpoint_id: string,
  opts: {
    requires?: { key: string; required: boolean; source?: string; semantic_type?: string }[];
    provides?: { key: string; source?: string; semantic_type?: string }[];
    observed_at?: string;
  } = {},
): EndpointDescriptor {
  return {
    endpoint_id,
    method: "GET",
    url_template: `https://api.example.com/${endpoint_id}`,
    description: `${endpoint_id} endpoint`,
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    response_schema: {
      type: "object",
      inferred_from_samples: 1,
      properties: { id: { type: "string", inferred_from_samples: 1 } },
    },
    semantic: {
      action_kind: "fetch",
      resource_kind: endpoint_id,
      description_in: `Requires bindings`,
      description_out: `Returns ${endpoint_id} data`,
      response_summary: "data",
      example_fields: ["id"],
      requires: opts.requires ?? [],
      provides: opts.provides ?? [],
      negative_tags: [],
      confidence: 0.9,
      observed_at: opts.observed_at ?? "2026-03-01T00:00:00.000Z",
    },
  };
}

describe("computeReachableEndpoints", () => {
  it("entry points with no requirements are always reachable", () => {
    const graph = buildSkillOperationGraph([
      endpoint("list-items"),
      endpoint("list-categories"),
    ]);

    const reachable = computeReachableEndpoints(graph, {});
    expect(reachable.size).toBe(2);
    expect(reachable.has("list-items")).toBe(true);
    expect(reachable.has("list-categories")).toBe(true);
  });

  it("operation with satisfied bindings is reachable", () => {
    const graph = buildSkillOperationGraph([
      endpoint("get-item", {
        requires: [{ key: "item_id", required: true, source: "path_params" }],
      }),
    ]);

    const reachable = computeReachableEndpoints(graph, { item_id: "123" });
    expect(reachable.has("get-item")).toBe(true);
  });

  it("operation with unsatisfied bindings is NOT reachable", () => {
    const graph = buildSkillOperationGraph([
      endpoint("get-item", {
        requires: [{ key: "item_id", required: true, source: "path_params" }],
      }),
    ]);

    const reachable = computeReachableEndpoints(graph, {});
    expect(reachable.has("get-item")).toBe(false);
  });

  it("transitive reachability: A provides x, B requires x, both reachable from A", () => {
    const graph = buildSkillOperationGraph([
      endpoint("search", {
        provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
        observed_at: "2026-03-01T00:00:00.000Z",
      }),
      endpoint("get-detail", {
        requires: [{ key: "item_id", required: true, source: "path_params", semantic_type: "item_identifier" }],
        observed_at: "2026-03-01T00:00:01.000Z",
      }),
    ]);

    // Neither requires external bindings for search, and search provides item_id for get-detail
    const reachable = computeReachableEndpoints(graph, {});
    expect(reachable.has("search")).toBe(true);
    expect(reachable.has("get-detail")).toBe(true);
  });

  it("fixpoint converges: A -> B -> C chain, all reachable from entry A", () => {
    const graph = buildSkillOperationGraph([
      endpoint("step-a", {
        provides: [{ key: "token_a", source: "response" }],
        observed_at: "2026-03-01T00:00:00.000Z",
      }),
      endpoint("step-b", {
        requires: [{ key: "token_a", required: true, source: "path_params" }],
        provides: [{ key: "token_b", source: "response" }],
        observed_at: "2026-03-01T00:00:01.000Z",
      }),
      endpoint("step-c", {
        requires: [{ key: "token_b", required: true, source: "path_params" }],
        observed_at: "2026-03-01T00:00:02.000Z",
      }),
    ]);

    const reachable = computeReachableEndpoints(graph, {});
    expect(reachable.has("step-a")).toBe(true);
    expect(reachable.has("step-b")).toBe(true);
    expect(reachable.has("step-c")).toBe(true);
  });

  it("circular dependencies do not cause infinite loop", () => {
    // Construct a graph manually with circular edges (shouldn't happen in DAG but be safe)
    const graph: SkillOperationGraph = {
      generated_at: new Date().toISOString(),
      entry_operation_ids: [],
      operations: [
        {
          operation_id: "op-x",
          endpoint_id: "op-x",
          method: "GET",
          url_template: "https://api.example.com/x",
          action_kind: "fetch",
          resource_kind: "x",
          requires: [{ key: "y_token", required: true, source: "path_params" }],
          provides: [{ key: "x_token", source: "response" }],
          negative_tags: [],
          example_fields: [],
          confidence: 0.9,
          auth_required: false,
        },
        {
          operation_id: "op-y",
          endpoint_id: "op-y",
          method: "GET",
          url_template: "https://api.example.com/y",
          action_kind: "fetch",
          resource_kind: "y",
          requires: [{ key: "x_token", required: true, source: "path_params" }],
          provides: [{ key: "y_token", source: "response" }],
          negative_tags: [],
          example_fields: [],
          confidence: 0.9,
          auth_required: false,
        },
      ],
      edges: [
        {
          edge_id: "op-x:op-y:x_token",
          from_operation_id: "op-x",
          to_operation_id: "op-y",
          binding_key: "x_token",
          kind: "dependency",
          confidence: 0.9,
        },
        {
          edge_id: "op-y:op-x:y_token",
          from_operation_id: "op-y",
          to_operation_id: "op-x",
          binding_key: "y_token",
          kind: "dependency",
          confidence: 0.9,
        },
      ],
    };

    // Neither should be reachable since they form a cycle with no entry point
    const reachable = computeReachableEndpoints(graph, {});
    expect(reachable.has("op-x")).toBe(false);
    expect(reachable.has("op-y")).toBe(false);
  });

  it("empty graph returns empty set", () => {
    const graph: SkillOperationGraph = {
      generated_at: new Date().toISOString(),
      entry_operation_ids: [],
      operations: [],
      edges: [],
    };

    const reachable = computeReachableEndpoints(graph, {});
    expect(reachable.size).toBe(0);
  });

  it("all operations reachable when none have required bindings", () => {
    const graph = buildSkillOperationGraph([
      endpoint("list-a"),
      endpoint("list-b"),
      endpoint("list-c"),
    ]);

    const reachable = computeReachableEndpoints(graph, {});
    expect(reachable.size).toBe(3);
    expect(reachable.has("list-a")).toBe(true);
    expect(reachable.has("list-b")).toBe(true);
    expect(reachable.has("list-c")).toBe(true);
  });

  it("mixed: entry points reachable, dependent with missing bindings not", () => {
    const graph = buildSkillOperationGraph([
      endpoint("search", {
        provides: [{ key: "item_id", source: "response" }],
        observed_at: "2026-03-01T00:00:00.000Z",
      }),
      endpoint("get-item", {
        requires: [{ key: "item_id", required: true, source: "path_params" }],
        observed_at: "2026-03-01T00:00:01.000Z",
      }),
      endpoint("admin-action", {
        requires: [{ key: "admin_token", required: true, source: "path_params" }],
        observed_at: "2026-03-01T00:00:02.000Z",
      }),
    ]);

    const reachable = computeReachableEndpoints(graph, {});
    expect(reachable.has("search")).toBe(true);
    expect(reachable.has("get-item")).toBe(true); // transitively reachable via search
    expect(reachable.has("admin-action")).toBe(false); // admin_token not provided anywhere
  });

  it("optional bindings do not block reachability", () => {
    const graph = buildSkillOperationGraph([
      endpoint("get-filtered", {
        requires: [
          { key: "category", required: false, source: "query" },
          { key: "auth_token", required: true, source: "path_params" },
        ],
      }),
    ]);

    // Only the required binding (auth_token) matters
    const reachable = computeReachableEndpoints(graph, { auth_token: "abc" });
    expect(reachable.has("get-filtered")).toBe(true);

    const unreachable = computeReachableEndpoints(graph, { category: "books" });
    expect(unreachable.has("get-filtered")).toBe(false);
  });
});

describe("isRunnable (exported)", () => {
  it("is exported and callable", () => {
    expect(typeof isRunnable).toBe("function");
  });

  it("returns true for operation with no required bindings", () => {
    const graph = buildSkillOperationGraph([endpoint("list")]);
    expect(isRunnable(graph.operations[0]!, {})).toBe(true);
  });

  it("returns false when required binding is missing", () => {
    const graph = buildSkillOperationGraph([
      endpoint("detail", {
        requires: [{ key: "id", required: true, source: "path_params" }],
      }),
    ]);
    expect(isRunnable(graph.operations[0]!, {})).toBe(false);
  });

  it("returns true when required binding is present", () => {
    const graph = buildSkillOperationGraph([
      endpoint("detail", {
        requires: [{ key: "id", required: true, source: "path_params" }],
      }),
    ]);
    expect(isRunnable(graph.operations[0]!, { id: "42" })).toBe(true);
  });
});
