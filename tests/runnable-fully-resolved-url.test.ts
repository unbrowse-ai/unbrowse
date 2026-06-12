import { describe, expect, test } from "bun:test";
import { toAgentWorkflowDagView } from "../src/lib/graph-core/index";
import type { SkillChunk, SkillOperationGraph, SkillOperationNode } from "../src/types/index.js";

// C7 fix — operations with no required bindings AND a fully-resolved
// url_template (no {param} slots) must surface as runnable:true.
// Real-world friction (walmart.com): the homepage DOM-extraction endpoint
// was reaching the agent as runnable:false even though `unbrowse execute`
// successfully re-fetched and re-parsed the SSR payload.
//
// Cause: isOperationHardExcluded filters operations from
// chunk.available_operation_ids based on the full-graph view, but the
// operation IS in chunk.operations and its URL is directly executable.

function makeNode(over: Partial<SkillOperationNode>): SkillOperationNode {
  return {
    operation_id: "op-1",
    endpoint_id: "ep-1",
    method: "GET",
    url_template: "https://www.example.com/",
    trigger_url: "https://www.example.com/",
    action_kind: "fetch",
    resource_kind: "page",
    description_in: "",
    description_out: "",
    requires: [],
    provides: [],
    negative_tags: [],
    ...over,
  } as SkillOperationNode;
}

function makeGraph(ops: SkillOperationNode[]): SkillOperationGraph {
  return {
    generated_at: new Date().toISOString(),
    entry_operation_ids: ops.map((o) => o.operation_id),
    operations: ops,
    edges: [],
  } as SkillOperationGraph;
}

function makeChunk(ops: SkillOperationNode[], availableIds: string[] = []): SkillChunk {
  return {
    skill_id: "skill-1",
    intent: "fetch data",
    available_operation_ids: availableIds,
    missing_bindings: [],
    operations: ops,
    edges: [],
  } as SkillChunk;
}

describe("C7 — runnable flag for fully-resolved URL with no requires", () => {
  test("op with requires:[] and no {param} surfaces runnable:true even when not in available_operation_ids", () => {
    const op = makeNode({
      operation_id: "walmart-home",
      url_template: "https://www.walmart.com/",
    });
    const view = toAgentWorkflowDagView(
      makeChunk([op], []), // empty available_operation_ids → was runnable:false
      makeGraph([op]),
    );
    expect(view.operations).toHaveLength(1);
    expect(view.operations[0].runnable).toBe(true);
  });

  test("op with unresolved {param} slot stays runnable:false when not pre-bound", () => {
    const op = makeNode({
      operation_id: "search",
      url_template: "https://www.example.com/search?q={q}",
    });
    const view = toAgentWorkflowDagView(makeChunk([op], []), makeGraph([op]));
    // {q} slot is unresolved AND no known_bindings — must NOT auto-mark runnable
    expect(view.operations[0].runnable).toBe(false);
  });

  test("op with required binding stays runnable:false until bindings supplied", () => {
    const op = makeNode({
      operation_id: "detail",
      url_template: "https://api.example.com/items/{id}",
      requires: [{ key: "id", required: true, semantic_type: "input", source: "url_template" } as any],
    });
    const view = toAgentWorkflowDagView(makeChunk([op], []), makeGraph([op]));
    expect(view.operations[0].runnable).toBe(false);
  });

  test("op already in available_operation_ids stays runnable:true (no regression)", () => {
    const op = makeNode({ operation_id: "cached", url_template: "https://api.example.com/v1/items" });
    const view = toAgentWorkflowDagView(
      makeChunk([op], ["cached"]),
      makeGraph([op]),
    );
    expect(view.operations[0].runnable).toBe(true);
  });
});
