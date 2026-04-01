import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { SkillManifest } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Stub cachePublishedSkill before importing dag-feedback
// ---------------------------------------------------------------------------

const cachePublishedSkillCalls: SkillManifest[] = [];

mock.module("../src/client/index.js", () => ({
  cachePublishedSkill: (skill: SkillManifest) => {
    cachePublishedSkillCalls.push(structuredClone(skill));
  },
  isLocalOnlyMode: () => true,
  getApiKey: () => "test-key",
}));

// Stub graph-client backend calls so fire-and-forget doesn't hit the network
const recordSessionCalls: unknown[] = [];
const recordNegativeCalls: unknown[] = [];

mock.module("../src/client/graph-client.js", () => ({
  recordSession: async (...args: unknown[]) => { recordSessionCalls.push(args); },
  recordNegative: async (...args: unknown[]) => { recordNegativeCalls.push(args); },
}));


const {
  recordDagSessionAction,
  recordDagNegative,
  upsertDagEdgesFromOperationGraph,
  _resetForTesting,
  _getSessionIdForTesting,
} = await import("../src/orchestrator/dag-feedback.js");

// Short debounce so tests finish quickly
const TEST_DEBOUNCE_MS = 30;

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, TEST_DEBOUNCE_MS + 20));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSkill(overrides?: Partial<SkillManifest>): SkillManifest {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    skill_id: "test-skill",
    version: "1.0.0",
    schema_version: "1",
    name: "Test Skill",
    intent_signature: "test intent",
    domain: "example.com",
    description: "Test",
    owner_type: "agent",
    execution_type: "http",
    endpoints: [],
    lifecycle: "active",
    created_at: now,
    updated_at: now,
    operation_graph: {
      generated_at: now,
      // buildOperationNode uses endpoint_id as operation_id
      entry_operation_ids: ["ep-search"],
      operations: [
        {
          operation_id: "ep-search",
          endpoint_id: "ep-search",
          method: "GET",
          url_template: "https://example.com/search?q={q}",
          action_kind: "search",
          resource_kind: "item",
          requires: [],
          provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
          confidence: 0.9,
        },
        {
          operation_id: "ep-detail",
          endpoint_id: "ep-detail",
          method: "GET",
          url_template: "https://example.com/items/{item_id}",
          action_kind: "detail",
          resource_kind: "item",
          requires: [{ key: "item_id", required: true, source: "path_params", semantic_type: "item_identifier" }],
          provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
          confidence: 0.85,
        },
      ],
      edges: [
        {
          // edge_id format: from_op_id:to_op_id:binding_key
          edge_id: "ep-search:ep-detail:item_id",
          from_operation_id: "ep-search",
          to_operation_id: "ep-detail",
          binding_key: "item_id",
          kind: "dependency",
          confidence: 0.9,
        },
      ],
    },
    ...overrides,
  } as SkillManifest;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  cachePublishedSkillCalls.length = 0;
  recordSessionCalls.length = 0;
  recordNegativeCalls.length = 0;
  _resetForTesting(TEST_DEBOUNCE_MS);
});

// ---------------------------------------------------------------------------
// recordDagSessionAction
// ---------------------------------------------------------------------------

describe("recordDagSessionAction", () => {
  it("is a no-op when skill has no operation_graph", async () => {
    const skill = makeSkill({ operation_graph: undefined });
    recordDagSessionAction(skill, "ep-search", true);
    await flush();
    expect(cachePublishedSkillCalls).toHaveLength(0);
  });

  it("is a no-op when endpointId has no matching operation", async () => {
    const skill = makeSkill();
    recordDagSessionAction(skill, "ep-nonexistent", true);
    await flush();
    expect(cachePublishedSkillCalls).toHaveLength(0);
  });

  it("boosts edge confidence on success", async () => {
    const skill = makeSkill();
    const originalConf = skill.operation_graph!.edges[0]!.confidence; // 0.9
    recordDagSessionAction(skill, "ep-search", true);
    await flush();

    expect(cachePublishedSkillCalls).toHaveLength(1);
    const updated = cachePublishedSkillCalls[0]!;
    const edge = updated.operation_graph!.edges[0]!;
    expect(edge.confidence).toBeGreaterThan(originalConf);
    expect(edge.confidence).toBeLessThanOrEqual(1.0);
  });

  it("penalises edge confidence on failure", async () => {
    const skill = makeSkill();
    const originalConf = skill.operation_graph!.edges[0]!.confidence; // 0.9
    recordDagSessionAction(skill, "ep-search", false);
    await flush();

    expect(cachePublishedSkillCalls).toHaveLength(1);
    const updated = cachePublishedSkillCalls[0]!;
    const edge = updated.operation_graph!.edges[0]!;
    expect(edge.confidence).toBeLessThan(originalConf);
    expect(edge.confidence).toBeGreaterThanOrEqual(0.1);
  });

  it("clamps confidence to 1.0 on repeated successes", async () => {
    const skill = makeSkill();
    skill.operation_graph!.edges[0]!.confidence = 0.99;
    recordDagSessionAction(skill, "ep-detail", true);
    await flush();

    const updated = cachePublishedSkillCalls.at(-1)!;
    const edge = updated.operation_graph!.edges[0]!;
    expect(edge.confidence).toBeLessThanOrEqual(1.0);
  });

  it("clamps confidence to >= 0.1 on repeated failures", async () => {
    const skill = makeSkill();
    skill.operation_graph!.edges[0]!.confidence = 0.11;
    recordDagSessionAction(skill, "ep-search", false);
    await flush();

    const updated = cachePublishedSkillCalls.at(-1)!;
    const edge = updated.operation_graph!.edges[0]!;
    expect(edge.confidence).toBeGreaterThanOrEqual(0.1);
  });

  it("updates generated_at on the graph", async () => {
    const skill = makeSkill();
    const before = skill.operation_graph!.generated_at;
    recordDagSessionAction(skill, "ep-search", true);
    await flush();

    const updated = cachePublishedSkillCalls[0]!;
    expect(updated.operation_graph!.generated_at).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// recordDagNegative
// ---------------------------------------------------------------------------

describe("recordDagNegative", () => {
  it("applies a larger penalty than a plain session failure", async () => {
    // plain failure penalty
    const skill1 = makeSkill();
    recordDagSessionAction(skill1, "ep-search", false);
    await flush();
    const plainConf = cachePublishedSkillCalls[0]!.operation_graph!.edges[0]!.confidence;

    cachePublishedSkillCalls.length = 0;
    _resetForTesting(TEST_DEBOUNCE_MS);

    // explicit negative penalty (2× step)
    const skill2 = makeSkill();
    recordDagNegative(skill2, "ep-search");
    await flush();
    const negConf = cachePublishedSkillCalls[0]!.operation_graph!.edges[0]!.confidence;

    expect(negConf).toBeLessThan(plainConf);
  });

  it("is a no-op without an operation_graph", async () => {
    const skill = makeSkill({ operation_graph: undefined });
    recordDagNegative(skill, "ep-search");
    await flush();
    expect(cachePublishedSkillCalls).toHaveLength(0);
  });

  it("is a no-op for an unknown endpoint", async () => {
    const skill = makeSkill();
    recordDagNegative(skill, "ep-unknown");
    await flush();
    expect(cachePublishedSkillCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// upsertDagEdgesFromOperationGraph
// ---------------------------------------------------------------------------

describe("upsertDagEdgesFromOperationGraph", () => {
  it("rebuilds graph from endpoints and persists to cache", async () => {
    const skill = makeSkill();
    skill.endpoints = [
      {
        endpoint_id: "ep-search",
        method: "GET",
        url_template: "https://example.com/search?q={q}",
        description: "Search items",
        query: { q: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
    ];
    upsertDagEdgesFromOperationGraph(skill);
    await flush();

    expect(cachePublishedSkillCalls).toHaveLength(1);
    const updated = cachePublishedSkillCalls[0]!;
    expect(updated.operation_graph).toBeDefined();
    expect(updated.operation_graph!.operations).toHaveLength(1);
  });

  it("preserves existing edge confidences for known edges", async () => {
    const skill = makeSkill();
    skill.operation_graph!.edges[0]!.confidence = 0.42;
    skill.endpoints = [
      {
        endpoint_id: "ep-search",
        method: "GET",
        url_template: "https://example.com/search?q={q}",
        description: "Search items",
        query: { q: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: {
          action_kind: "search",
          resource_kind: "item",
          description_in: "q",
          description_out: "item_id",
          response_summary: "item_id",
          example_fields: ["item_id"],
          requires: [],
          provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
          negative_tags: [],
          confidence: 0.9,
          observed_at: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        endpoint_id: "ep-detail",
        method: "GET",
        url_template: "https://example.com/items/{item_id}",
        description: "Get item detail",
        path_params: { item_id: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: {
          action_kind: "detail",
          resource_kind: "item",
          description_in: "item_id",
          description_out: "item details",
          response_summary: "item fields",
          example_fields: ["id"],
          requires: [{ key: "item_id", required: true, source: "path_params", semantic_type: "item_identifier" }],
          provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
          negative_tags: [],
          confidence: 0.9,
          observed_at: "2026-01-01T00:00:01.000Z",
        },
      },
    ];
    upsertDagEdgesFromOperationGraph(skill);
    await flush();

    expect(cachePublishedSkillCalls).toHaveLength(1);
    const updated = cachePublishedSkillCalls[0]!;
    expect(updated.operation_graph!.operations).toHaveLength(2);

    // The edge ep-search:ep-detail:item_id should preserve the learned confidence
    const edge = updated.operation_graph!.edges.find(
      (e) => e.edge_id === "ep-search:ep-detail:item_id",
    );
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe(0.42);
  });

  it("uses default confidence for new edges not previously seen", async () => {
    const skill = makeSkill({ operation_graph: undefined });
    skill.endpoints = [
      {
        endpoint_id: "ep-search",
        method: "GET",
        url_template: "https://example.com/search?q={q}",
        description: "Search items",
        query: { q: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: {
          action_kind: "search",
          resource_kind: "item",
          description_in: "q",
          description_out: "item_id",
          response_summary: "item_id",
          example_fields: ["item_id"],
          requires: [],
          provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
          negative_tags: [],
          confidence: 0.9,
          observed_at: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        endpoint_id: "ep-detail",
        method: "GET",
        url_template: "https://example.com/items/{item_id}",
        description: "Get item detail",
        path_params: { item_id: "" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        semantic: {
          action_kind: "detail",
          resource_kind: "item",
          description_in: "item_id",
          description_out: "item details",
          response_summary: "item fields",
          example_fields: ["id"],
          requires: [{ key: "item_id", required: true, source: "path_params", semantic_type: "item_identifier" }],
          provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
          negative_tags: [],
          confidence: 0.9,
          observed_at: "2026-01-01T00:00:01.000Z",
        },
      },
    ];
    upsertDagEdgesFromOperationGraph(skill);
    await flush();

    const updated = cachePublishedSkillCalls[0]!;
    const edge = updated.operation_graph!.edges.find(
      (e) => e.edge_id === "ep-search:ep-detail:item_id",
    );
    expect(edge).toBeDefined();
    // Default confidence from buildSkillOperationGraph for exact key match is 0.9
    expect(edge!.confidence).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Debounce / rate-limiting
// ---------------------------------------------------------------------------

describe("debounce / rate-limiting", () => {
  it("coalesces multiple calls within the debounce window into one write", async () => {
    const skill = makeSkill();
    recordDagSessionAction(skill, "ep-search", true);
    recordDagSessionAction(skill, "ep-search", true);
    recordDagSessionAction(skill, "ep-search", true);
    await flush();

    expect(cachePublishedSkillCalls).toHaveLength(1);
  });

  it("different skill_ids get independent debounce timers", async () => {
    const skill1 = makeSkill({ skill_id: "skill-a" });
    const skill2 = makeSkill({ skill_id: "skill-b" });
    recordDagSessionAction(skill1, "ep-search", true);
    recordDagSessionAction(skill2, "ep-search", true);
    await flush();

    const ids = cachePublishedSkillCalls.map((s) => s.skill_id);
    expect(ids).toContain("skill-a");
    expect(ids).toContain("skill-b");
  });

  it("allows a second write after the debounce window expires", async () => {
    const skill = makeSkill();
    recordDagSessionAction(skill, "ep-search", true);
    await flush();
    expect(cachePublishedSkillCalls).toHaveLength(1);

    // Second call after window
    recordDagSessionAction(skill, "ep-search", false);
    await flush();
    expect(cachePublishedSkillCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Backend wiring (fire-and-forget)
// ---------------------------------------------------------------------------

describe("backend wiring", () => {
  it("recordDagSessionAction fires recordSession to backend", async () => {
    const skill = makeSkill({ domain: "example.com", intent_signature: "search items" });
    recordDagSessionAction(skill, "ep-search", true);
    await flush();

    expect(recordSessionCalls).toHaveLength(1);
    const [domain, sessionId, endpointId, intent, result] = recordSessionCalls[0] as string[];
    expect(domain).toBe("example.com");
    expect(sessionId).toBe(_getSessionIdForTesting());
    expect(endpointId).toBe("ep-search");
    expect(intent).toBe("search items");
    expect(result).toBe("success");
  });

  it("recordDagSessionAction sends failure result on failed execution", async () => {
    const skill = makeSkill({ domain: "example.com" });
    recordDagSessionAction(skill, "ep-search", false);
    await flush();

    expect(recordSessionCalls).toHaveLength(1);
    const [, , , , result] = recordSessionCalls[0] as string[];
    expect(result).toBe("failure");
  });

  it("recordDagNegative fires recordNegative to backend", async () => {
    const skill = makeSkill({ domain: "example.com", intent_signature: "search items" });
    recordDagNegative(skill, "ep-search");
    await flush();

    expect(recordNegativeCalls).toHaveLength(1);
    const [domain, intentPattern, endpointId] = recordNegativeCalls[0] as string[];
    expect(domain).toBe("example.com");
    expect(intentPattern).toBe("search items");
    expect(endpointId).toBe("ep-search");
  });

  it("skips backend calls when skill has no domain", async () => {
    const skill = makeSkill({ domain: undefined });
    recordDagSessionAction(skill, "ep-search", true);
    recordDagNegative(skill, "ep-search");
    await flush();

    expect(recordSessionCalls).toHaveLength(0);
    expect(recordNegativeCalls).toHaveLength(0);
  });

  it("skips backend calls when skill has no operation_graph", async () => {
    const skill = makeSkill({ domain: "example.com", operation_graph: undefined });
    recordDagSessionAction(skill, "ep-search", true);
    recordDagNegative(skill, "ep-search");
    await flush();

    // No operation_graph means early return before backend call
    expect(recordSessionCalls).toHaveLength(0);
    expect(recordNegativeCalls).toHaveLength(0);
  });

  it("session ID is stable across calls", () => {
    const id1 = _getSessionIdForTesting();
    const id2 = _getSessionIdForTesting();
    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThan(0);
  });

  it("uses empty string for intent when intent_signature is missing", async () => {
    const skill = makeSkill({ domain: "example.com", intent_signature: undefined });
    recordDagSessionAction(skill, "ep-search", true);
    await flush();

    const [, , , intent] = recordSessionCalls[0] as string[];
    expect(intent).toBe("");
  });
});
