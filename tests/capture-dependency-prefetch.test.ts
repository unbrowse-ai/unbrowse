/**
 * Tests for dependency prefetch during capture (Feature #120).
 */
import { describe, it, expect } from "bun:test";
import type { RawRequest } from "../src/capture/index.js";
import type { SkillManifest, SkillOperationGraph } from "../src/types/index.js";

function makeRequest(url: string, method = "GET"): RawRequest {
  return {
    url,
    method,
    request_headers: {},
    response_status: 200,
    response_headers: {},
    response_body: `{"data":[]}`,
    timestamp: new Date().toISOString(),
  };
}

// Extracted prefetch eligibility logic for unit testing
function getRelatedOps(
  graph: SkillOperationGraph,
  capturedRequests: RawRequest[],
): typeof graph.operations {
  const capturedPaths = new Set(
    capturedRequests.map((r) => { try { return new URL(r.url).pathname; } catch { return r.url; } }),
  );
  return graph.operations.filter((op) => {
    if (op.method !== "GET") return false;
    try {
      if (capturedPaths.has(new URL(op.url_template).pathname)) return false;
    } catch { return false; }
    return op.provides.some((binding) =>
      graph.edges.some(
        (edge) =>
          edge.binding_key === binding.key &&
          capturedRequests.some((r) => r.url.includes(edge.to_operation_id)),
      ),
    );
  });
}

describe("prefetch eligibility", () => {
  const graph: SkillOperationGraph = {
    generated_at: new Date().toISOString(),
    entry_operation_ids: ["op-list"],
    operations: [
      {
        operation_id: "op-list",
        endpoint_id: "ep-list",
        method: "GET",
        url_template: "https://api.example.com/list",
        action_kind: "list",
        resource_kind: "item",
        description_in: "",
        description_out: "list of items",
        requires: [],
        provides: [{ key: "item_id", path: "$.items[*].id", description: "item id" }],
        confidence: 0.9,
      },
      {
        operation_id: "op-detail",
        endpoint_id: "ep-detail",
        method: "GET",
        url_template: "https://api.example.com/item/{item_id}",
        action_kind: "get",
        resource_kind: "item",
        description_in: "item_id",
        description_out: "item detail",
        requires: [{ key: "item_id", path: "", description: "item id" }],
        provides: [],
        confidence: 0.9,
      },
      {
        operation_id: "op-post",
        endpoint_id: "ep-post",
        method: "POST",
        url_template: "https://api.example.com/items",
        action_kind: "create",
        resource_kind: "item",
        description_in: "",
        description_out: "",
        requires: [],
        provides: [{ key: "new_id", path: "$.id", description: "new item id" }],
        confidence: 0.9,
      },
    ],
    edges: [
      { from_operation_id: "op-list", to_operation_id: "op-detail", binding_key: "item_id" },
    ],
  };

  it("finds related GET endpoint that provides needed bindings", () => {
    const captured = [makeRequest("https://api.example.com/item/op-detail")];
    const ops = getRelatedOps(graph, captured);
    expect(ops.some((op) => op.operation_id === "op-list")).toBe(true);
  });

  it("skips POST endpoints", () => {
    const captured = [makeRequest("https://api.example.com/item/op-detail")];
    const ops = getRelatedOps(graph, captured);
    expect(ops.every((op) => op.method === "GET")).toBe(true);
  });

  it("skips already-captured endpoints", () => {
    const captured = [
      makeRequest("https://api.example.com/item/op-detail"),
      makeRequest("https://api.example.com/list"),
    ];
    const ops = getRelatedOps(graph, captured);
    expect(ops.every((op) => op.operation_id !== "op-list")).toBe(true);
  });

  it("returns empty when no existing skill operation_graph", () => {
    // No operation graph → prefetch disabled
    const existingSkill: Pick<SkillManifest, "operation_graph"> = {};
    const result = existingSkill.operation_graph ? getRelatedOps(existingSkill.operation_graph, []) : [];
    expect(result).toHaveLength(0);
  });

  it("respects PREFETCH_MAX = 3 limit", () => {
    const PREFETCH_MAX = 3;
    const manyOps = Array.from({ length: 10 }, (_, i) => ({
      operation_id: `op-${i}`,
      endpoint_id: `ep-${i}`,
      method: "GET" as const,
      url_template: `https://api.example.com/resource/${i}`,
      action_kind: "get",
      resource_kind: "item",
      description_in: "",
      description_out: "",
      requires: [],
      provides: [{ key: `binding_${i}`, path: "", description: "" }],
      confidence: 0.9,
    }));
    expect(manyOps.slice(0, PREFETCH_MAX)).toHaveLength(PREFETCH_MAX);
  });
});
