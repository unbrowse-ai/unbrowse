import { describe, expect, it, beforeEach } from "bun:test";
import {
  buildExecutionPlan,
  fetchDagAdvisoryPlan,
  applyDagAdvisoryBoosts,
  recordDagNegative,
  recordDagSessionAction,
  getDagSessionTrace,
  isDagNegative,
  clearDagSessionState,
} from "../src/lib/graph-core/planner.js";
import type {
  SkillOperationGraph,
  SkillOperationNode,
  SkillOperationEdge,
  EndpointDescriptor,
  SkillManifest,
} from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(
  overrides: Partial<SkillOperationNode> & {
    operation_id: string;
    endpoint_id: string;
  },
): SkillOperationNode {
  return {
    method: "GET",
    url_template: `https://api.example.com/${overrides.endpoint_id}`,
    action_kind: "detail",
    resource_kind: "item",
    requires: [],
    provides: [],
    confidence: 0.9,
    ...overrides,
  };
}

function makeEdge(
  from: string,
  to: string,
  bindingKey: string,
  kind: "dependency" | "hint" = "dependency",
): SkillOperationEdge {
  return {
    edge_id: `${from}:${to}:${bindingKey}`,
    from_operation_id: from,
    to_operation_id: to,
    binding_key: bindingKey,
    kind,
    confidence: kind === "dependency" ? 0.9 : 0.6,
  };
}

function makeGraph(
  operations: SkillOperationNode[],
  edges: SkillOperationEdge[],
  entryIds?: string[],
): SkillOperationGraph {
  return {
    generated_at: new Date().toISOString(),
    entry_operation_ids:
      entryIds ?? operations.filter((o) => o.requires.length === 0).map((o) => o.operation_id),
    operations,
    edges,
  };
}

function makeSkill(endpoints: EndpointDescriptor[]): SkillManifest {
  return {
    skill_id: "test-skill",
    version: "1.0.0",
    schema_version: "1",
    name: "Test Skill",
    intent_signature: "test",
    domain: "example.com",
    description: "A test skill",
    owner_type: "community",
    execution_type: "server",
    endpoints,
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as SkillManifest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DAG execution planner", () => {
  beforeEach(() => {
    clearDagSessionState();
  });

  // 1. Topological sort produces correct order for a chain: A -> B -> C
  describe("buildExecutionPlan", () => {
    it("produces correct topological order for a linear chain A -> B -> C", () => {
      const opA = makeOp({
        operation_id: "A",
        endpoint_id: "ep-a",
        provides: [{ key: "item_id", source: "response" }],
      });
      const opB = makeOp({
        operation_id: "B",
        endpoint_id: "ep-b",
        requires: [{ key: "item_id", required: true, source: "path_params" }],
        provides: [{ key: "detail_token", source: "response" }],
      });
      const opC = makeOp({
        operation_id: "C",
        endpoint_id: "ep-c",
        requires: [{ key: "detail_token", required: true, source: "path_params" }],
        provides: [{ key: "final_result", source: "response" }],
      });

      const graph = makeGraph(
        [opA, opB, opC],
        [makeEdge("A", "B", "item_id"), makeEdge("B", "C", "detail_token")],
        ["A"],
      );

      const plan = buildExecutionPlan(graph, "C", new Set());

      const order = plan.steps.map((s) => s.operation_id);
      expect(order).toEqual(["A", "B", "C"]);
    });

    // 2. chain_ready is true when known bindings satisfy all prerequisites
    it("reports chain_ready=true when known bindings satisfy all prerequisites", () => {
      const opA = makeOp({
        operation_id: "A",
        endpoint_id: "ep-a",
        requires: [{ key: "user_id", required: true, source: "path_params" }],
        provides: [{ key: "data", source: "response" }],
      });

      const graph = makeGraph([opA], [], ["A"]);

      const plan = buildExecutionPlan(graph, "A", new Set(["user_id"]));
      expect(plan.chain_ready).toBe(true);
    });

    // 3. chain_ready is false when bindings are missing
    it("reports chain_ready=false when required bindings are missing", () => {
      const opA = makeOp({
        operation_id: "A",
        endpoint_id: "ep-a",
        provides: [{ key: "item_id", source: "response" }],
      });
      const opB = makeOp({
        operation_id: "B",
        endpoint_id: "ep-b",
        requires: [
          { key: "item_id", required: true, source: "path_params" },
          { key: "auth_token", required: true, source: "header" },
        ],
        provides: [],
      });

      const graph = makeGraph(
        [opA, opB],
        [makeEdge("A", "B", "item_id")],
        ["A"],
      );

      // item_id will be produced by A, but auth_token is missing
      const plan = buildExecutionPlan(graph, "B", new Set());
      expect(plan.chain_ready).toBe(false);
    });

    // 4. Mutable operations get requires_confirmation=true
    it("flags mutable operations with requires_confirmation=true", () => {
      const opGet = makeOp({
        operation_id: "get-items",
        endpoint_id: "ep-get",
        method: "GET",
        provides: [{ key: "item_id", source: "response" }],
      });
      const opPost = makeOp({
        operation_id: "create-item",
        endpoint_id: "ep-post",
        method: "POST",
        requires: [{ key: "item_id", required: true, source: "body" }],
      });
      const opDelete = makeOp({
        operation_id: "delete-item",
        endpoint_id: "ep-delete",
        method: "DELETE",
        requires: [{ key: "item_id", required: true, source: "path_params" }],
      });
      const opPatch = makeOp({
        operation_id: "update-item",
        endpoint_id: "ep-patch",
        method: "PATCH",
        requires: [{ key: "item_id", required: true, source: "path_params" }],
      });

      const graph = makeGraph(
        [opGet, opPost, opDelete, opPatch],
        [
          makeEdge("get-items", "create-item", "item_id"),
          makeEdge("get-items", "delete-item", "item_id"),
          makeEdge("get-items", "update-item", "item_id"),
        ],
        ["get-items"],
      );

      // Target create-item to include get-items -> create-item
      const plan = buildExecutionPlan(graph, "create-item", new Set());

      const getStep = plan.steps.find((s) => s.operation_id === "get-items");
      const postStep = plan.steps.find((s) => s.operation_id === "create-item");
      expect(getStep?.requires_confirmation).toBe(false);
      expect(postStep?.requires_confirmation).toBe(true);
    });

    // 8. Single-node graph (no dependencies) works
    it("handles a single-node graph with no dependencies", () => {
      const opA = makeOp({
        operation_id: "A",
        endpoint_id: "ep-a",
        provides: [{ key: "data", source: "response" }],
      });

      const graph = makeGraph([opA], [], ["A"]);
      const plan = buildExecutionPlan(graph, "A", new Set());

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].operation_id).toBe("A");
      expect(plan.chain_ready).toBe(true);
    });

    // 9. Unreachable nodes are excluded from plan
    it("excludes unreachable nodes from the plan", () => {
      const opA = makeOp({
        operation_id: "A",
        endpoint_id: "ep-a",
        provides: [{ key: "item_id", source: "response" }],
      });
      const opB = makeOp({
        operation_id: "B",
        endpoint_id: "ep-b",
        requires: [{ key: "item_id", required: true, source: "path_params" }],
      });
      const opOrphan = makeOp({
        operation_id: "orphan",
        endpoint_id: "ep-orphan",
        provides: [{ key: "unrelated", source: "response" }],
      });

      const graph = makeGraph(
        [opA, opB, opOrphan],
        [makeEdge("A", "B", "item_id")],
        ["A", "orphan"],
      );

      const plan = buildExecutionPlan(graph, "B", new Set());

      const opIds = plan.steps.map((s) => s.operation_id);
      expect(opIds).toContain("A");
      expect(opIds).toContain("B");
      expect(opIds).not.toContain("orphan");
      expect(plan.unreachable).toContain("orphan");
    });
  });

  // 5. predicted_next includes operations unlocked after target
  describe("fetchDagAdvisoryPlan", () => {
    it("includes operations unlocked after target in predicted_next", () => {
      const endpoints: EndpointDescriptor[] = [
        {
          endpoint_id: "search",
          method: "GET",
          url_template: "https://api.example.com/search?q={q}",
          description: "Search items",
          query: { q: "" },
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
          semantic: {
            action_kind: "search",
            resource_kind: "item",
            description_in: "Requires q",
            description_out: "Returns items",
            response_summary: "item_id, item_name",
            example_fields: ["items[].id", "items[].name"],
            requires: [{ key: "q", required: false, source: "query", semantic_type: "query_text" }],
            provides: [
              { key: "item_id", source: "response", semantic_type: "item_identifier" },
            ],
            negative_tags: [],
            confidence: 0.9,
            observed_at: "2026-03-07T10:00:00.000Z",
          },
        },
        {
          endpoint_id: "detail",
          method: "GET",
          url_template: "https://api.example.com/items/{item_id}",
          description: "Get item details",
          path_params: { item_id: "" },
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
          semantic: {
            action_kind: "detail",
            resource_kind: "item",
            description_in: "Requires item_id",
            description_out: "Returns item details",
            response_summary: "item fields",
            example_fields: ["id", "name", "description"],
            requires: [
              { key: "item_id", required: true, source: "path_params", semantic_type: "item_identifier" },
            ],
            provides: [
              { key: "item_detail", source: "response", semantic_type: "item_detail" },
            ],
            negative_tags: [],
            confidence: 0.9,
            observed_at: "2026-03-07T10:00:01.000Z",
          },
        },
      ];

      const skill = makeSkill(endpoints);
      const plan = fetchDagAdvisoryPlan(skill, "search", []);

      // After search completes it provides item_id, which unlocks detail.
      expect(plan.predicted_next).toContain("detail");
      expect(plan.chain_ready).toBe(true);
    });

    it("returns chain_ready=false when prerequisites are missing", () => {
      const endpoints: EndpointDescriptor[] = [
        {
          endpoint_id: "detail",
          method: "GET",
          url_template: "https://api.example.com/items/{item_id}",
          description: "Get item details",
          path_params: { item_id: "" },
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
          semantic: {
            action_kind: "detail",
            resource_kind: "item",
            requires: [
              { key: "item_id", required: true, source: "path_params" },
            ],
            provides: [],
            confidence: 0.9,
            observed_at: "2026-03-07T10:00:00.000Z",
          },
        },
      ];

      const skill = makeSkill(endpoints);
      const plan = fetchDagAdvisoryPlan(skill, "detail", []);

      // item_id is required but not provided
      expect(plan.chain_ready).toBe(false);
    });
  });

  // 6. applyDagAdvisoryBoosts re-ranks correctly
  describe("applyDagAdvisoryBoosts", () => {
    it("boosts prerequisite endpoints and penalizes skippable ones", () => {
      const ranked = [
        { endpoint_id: "skippable-ep", score: 0.8 },
        { endpoint_id: "prereq-ep", score: 0.5 },
        { endpoint_id: "next-ep", score: 0.6 },
        { endpoint_id: "neutral-ep", score: 0.7 },
      ];

      const dagPlan = {
        chain_ready: true,
        predicted_next: ["next-ep"],
        prerequisite_order: ["prereq-ep"],
        skippable: ["skippable-ep"],
      };

      const result = applyDagAdvisoryBoosts(ranked, dagPlan);

      // Verify the actual score adjustments
      const scores = Object.fromEntries(result.map((r) => [r.endpoint_id, r.score]));
      expect(scores["prereq-ep"]).toBeCloseTo(0.65, 5);   // 0.5 + 0.15
      expect(scores["next-ep"]).toBeCloseTo(0.65, 5);      // 0.6 + 0.05
      expect(scores["skippable-ep"]).toBeCloseTo(0.7, 5);  // 0.8 - 0.1
      expect(scores["neutral-ep"]).toBeCloseTo(0.7, 5);    // unchanged

      // Top two should be the 0.7 items, bottom two should be the 0.65 items
      const topTwo = result.slice(0, 2).map((r) => r.endpoint_id);
      expect(topTwo).toContain("neutral-ep");
      expect(topTwo).toContain("skippable-ep");
      const bottomTwo = result.slice(2).map((r) => r.endpoint_id);
      expect(bottomTwo).toContain("prereq-ep");
      expect(bottomTwo).toContain("next-ep");
    });

    // 7. recordDagNegative prevents re-boosting failed endpoints
    it("penalizes endpoints that have been recorded as negative", () => {
      const skill = { skill_id: "test-skill" };
      recordDagNegative(skill, "failed-ep");

      const ranked = [
        { endpoint_id: "failed-ep", score: 0.9 },
        { endpoint_id: "good-ep", score: 0.5 },
      ];

      const dagPlan = {
        chain_ready: true,
        predicted_next: [],
        prerequisite_order: ["failed-ep"], // Would normally boost
        skippable: [],
      };

      const result = applyDagAdvisoryBoosts(ranked, dagPlan);

      // failed-ep should be penalized (0.9 - 0.1 = 0.8) instead of boosted
      const failedEp = result.find((r) => r.endpoint_id === "failed-ep");
      const goodEp = result.find((r) => r.endpoint_id === "good-ep");
      expect(failedEp!.score).toBe(0.8);
      expect(goodEp!.score).toBe(0.5);
    });
  });

  describe("recordDagNegative", () => {
    it("records and checks negative status", () => {
      const skill = { skill_id: "my-skill" };
      expect(isDagNegative(skill, "ep-1")).toBe(false);

      recordDagNegative(skill, "ep-1");
      expect(isDagNegative(skill, "ep-1")).toBe(true);
      expect(isDagNegative(skill, "ep-2")).toBe(false);
    });
  });

  describe("recordDagSessionAction", () => {
    it("accumulates ordered session trace", () => {
      const skill = { skill_id: "trace-skill" };

      recordDagSessionAction(skill, "ep-1", true);
      recordDagSessionAction(skill, "ep-2", false);
      recordDagSessionAction(skill, "ep-3", true);

      const trace = getDagSessionTrace(skill);
      expect(trace).toHaveLength(3);
      expect(trace[0].endpoint_id).toBe("ep-1");
      expect(trace[0].success).toBe(true);
      expect(trace[1].endpoint_id).toBe("ep-2");
      expect(trace[1].success).toBe(false);
      expect(trace[2].endpoint_id).toBe("ep-3");
      expect(trace[2].success).toBe(true);

      // Timestamps should be in order
      expect(trace[0].timestamp).toBeLessThanOrEqual(trace[1].timestamp);
      expect(trace[1].timestamp).toBeLessThanOrEqual(trace[2].timestamp);
    });
  });
});
