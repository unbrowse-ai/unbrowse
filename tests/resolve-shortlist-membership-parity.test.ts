import { describe, expect, test } from "bun:test";
import {
  filterDagOperationsByRankedEndpoints,
} from "../src/graph/index";
import type { AgentWorkflowDagOperation } from "../src/types/index.js";

// Regression — huggingface.co/models, 2026-05-15. Resolve on a list intent
// surfaced a POST /api/event write endpoint inside `available_operations`
// while `available_endpoints` (the rankEndpoints + reachability-filtered
// view) only contained the 2 GET endpoints. The two shortlists must report
// the same membership: the calling LLM's picker reads available_operations,
// and a write-on-read endpoint inflates the wrong-pick rate on a list intent.

function makeOp(over: Partial<AgentWorkflowDagOperation>): AgentWorkflowDagOperation {
  return {
    operation_id: over.operation_id ?? "op",
    endpoint_id: over.endpoint_id ?? "ep",
    method: over.method ?? "GET",
    action_kind: over.action_kind ?? "list",
    resource_kind: over.resource_kind ?? "resource",
    title: over.title ?? "list resource",
    url_template: over.url_template ?? "https://example.com/",
    description_out: over.description_out ?? "page",
    requires: over.requires ?? [],
    yields: over.yields ?? [],
    proof_status: over.proof_status ?? "no_proof",
    runnable: over.runnable ?? true,
    prefetch_get_operations: over.prefetch_get_operations ?? [],
  } as AgentWorkflowDagOperation;
}

describe("resolve shortlist membership parity", () => {
  test("drops operations whose endpoint_id is not in the ranked-endpoint set", () => {
    const getList = makeOp({ operation_id: "op-list", endpoint_id: "ep-list", method: "GET" });
    const getDetail = makeOp({ operation_id: "op-detail", endpoint_id: "ep-detail", method: "GET" });
    const postEvent = makeOp({
      operation_id: "op-event",
      endpoint_id: "ep-event",
      method: "POST",
      action_kind: "create",
      resource_kind: "event",
      url_template: "https://example.com/api/event",
    });
    const operations = [getList, getDetail, postEvent];
    const rankedIds = new Set(["ep-list", "ep-detail"]);
    const filtered = filterDagOperationsByRankedEndpoints(operations, rankedIds);
    const ids = filtered.map((op) => op.endpoint_id);
    expect(ids).toEqual(["ep-list", "ep-detail"]);
    expect(ids).not.toContain("ep-event");
  });

  test("passes through unchanged when the ranked set is empty (no membership claim)", () => {
    const op = makeOp({ operation_id: "op-1", endpoint_id: "ep-1" });
    const operations = [op];
    const filtered = filterDagOperationsByRankedEndpoints(operations, new Set<string>());
    expect(filtered).toHaveLength(1);
    expect(filtered[0].endpoint_id).toBe("ep-1");
  });

  test("accepts an iterable (Map keys, generator) not just a Set", () => {
    const opA = makeOp({ operation_id: "op-a", endpoint_id: "ep-a" });
    const opB = makeOp({ operation_id: "op-b", endpoint_id: "ep-b" });
    const scoresByEndpoint = new Map<string, number>([["ep-a", 500]]);
    const filtered = filterDagOperationsByRankedEndpoints([opA, opB], scoresByEndpoint.keys());
    expect(filtered.map((o) => o.endpoint_id)).toEqual(["ep-a"]);
  });

  test("does not mutate the input array", () => {
    const opA = makeOp({ operation_id: "op-a", endpoint_id: "ep-a" });
    const opB = makeOp({ operation_id: "op-b", endpoint_id: "ep-b" });
    const input = [opA, opB];
    const inputBefore = [...input];
    filterDagOperationsByRankedEndpoints(input, new Set(["ep-a"]));
    expect(input).toEqual(inputBefore);
  });
});
