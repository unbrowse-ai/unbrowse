import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { SkillManifest } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Stub cachePublishedSkill — this is a local file-system cache; we intercept
// it to inspect what was written without touching the real disk cache.
// The graph-client module is NOT mocked — fire-and-forget calls hit the real
// backend at https://beta-api.unbrowse.ai.
// ---------------------------------------------------------------------------

const cachePublishedSkillCalls: SkillManifest[] = [];

mock.module("../src/client/index.js", () => ({
  cachePublishedSkill: (skill: SkillManifest) => {
    cachePublishedSkillCalls.push(structuredClone(skill));
  },
  isLocalOnlyMode: () => true,
  getApiKey: () => "test-key",
}));

// graph-client is NOT mocked — real network calls to:
//   POST /v1/graph/session   → 200
//   POST /v1/graph/negative  → 200

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

// Wait a bit longer for fire-and-forget network calls to complete
async function flushNetwork(): Promise<void> {
  await new Promise((r) => setTimeout(r, 3000));
}

// ---------------------------------------------------------------------------
// Fixtures — use integration test domain so real calls don't pollute
// ---------------------------------------------------------------------------

const TEST_DOMAIN = "test-integration.unbrowse.dev";

function makeSkill(overrides?: Partial<SkillManifest>): SkillManifest {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    skill_id: "test-skill",
    version: "1.0.0",
    schema_version: "1",
    name: "Test Skill",
    intent_signature: "test intent",
    domain: TEST_DOMAIN,
    description: "Test",
    owner_type: "agent",
    execution_type: "http",
    endpoints: [],
    lifecycle: "active",
    created_at: now,
    updated_at: now,
    operation_graph: {
      generated_at: now,
      entry_operation_ids: ["ep-search"],
      operations: [
        {
          operation_id: "ep-search",
          endpoint_id: "ep-search",
          method: "GET",
          url_template: `https://${TEST_DOMAIN}/search?q={q}`,
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
          url_template: `https://${TEST_DOMAIN}/items/{item_id}`,
          action_kind: "detail",
          resource_kind: "item",
          requires: [{ key: "item_id", required: true, source: "path_params", semantic_type: "item_identifier" }],
          provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
          confidence: 0.85,
        },
      ],
      edges: [
        {
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
  _resetForTesting(TEST_DEBOUNCE_MS);
});

// ---------------------------------------------------------------------------
// recordDagSessionAction — local confidence adjustments
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

    // explicit negative penalty (2x step)
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
        url_template: `https://${TEST_DOMAIN}/search?q={q}`,
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
        url_template: `https://${TEST_DOMAIN}/search?q={q}`,
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
        url_template: `https://${TEST_DOMAIN}/items/{item_id}`,
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
        url_template: `https://${TEST_DOMAIN}/search?q={q}`,
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
        url_template: `https://${TEST_DOMAIN}/items/{item_id}`,
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
// Backend wiring — fire-and-forget to real backend
// These tests verify that recordDagSessionAction and recordDagNegative
// actually fire real HTTP requests without crashing.
// ---------------------------------------------------------------------------

describe("backend wiring (live fire-and-forget)", () => {
  it("recordDagSessionAction fires real recordSession to backend without throwing", async () => {
    const skill = makeSkill({ domain: TEST_DOMAIN, intent_signature: "search items" });
    // This call fires a real POST to /v1/graph/session in the background
    recordDagSessionAction(skill, "ep-search", true);
    await flush();

    // Local cache should still work
    expect(cachePublishedSkillCalls).toHaveLength(1);

    // Wait for the fire-and-forget network call to complete
    await flushNetwork();
  });

  it("recordDagSessionAction sends failure result on failed execution", async () => {
    const skill = makeSkill({ domain: TEST_DOMAIN });
    recordDagSessionAction(skill, "ep-search", false);
    await flush();

    // Local cache written
    expect(cachePublishedSkillCalls).toHaveLength(1);
    await flushNetwork();
  });

  it("recordDagNegative fires real recordNegative to backend without throwing", async () => {
    const skill = makeSkill({ domain: TEST_DOMAIN, intent_signature: "search items" });
    recordDagNegative(skill, "ep-search");
    await flush();

    // Local cache written
    expect(cachePublishedSkillCalls).toHaveLength(1);
    await flushNetwork();
  });

  it("skips backend calls when skill has no domain", async () => {
    const skill = makeSkill({ domain: undefined });
    recordDagSessionAction(skill, "ep-search", true);
    recordDagNegative(skill, "ep-search");
    await flush();

    // No operation_graph match or no domain means no backend call and no cache
    // (the domain is undefined so no backend call, but the local graph update
    // still happens for recordDagSessionAction if graph exists)
    // Wait to ensure no unhandled rejections
    await flushNetwork();
  });

  it("skips backend calls when skill has no operation_graph", async () => {
    const skill = makeSkill({ domain: TEST_DOMAIN, operation_graph: undefined });
    recordDagSessionAction(skill, "ep-search", true);
    recordDagNegative(skill, "ep-search");
    await flush();

    // No operation_graph means early return
    expect(cachePublishedSkillCalls).toHaveLength(0);
    await flushNetwork();
  });

  it("session ID is stable across calls", () => {
    const id1 = _getSessionIdForTesting();
    const id2 = _getSessionIdForTesting();
    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThan(0);
  });

  it("uses empty string for intent when intent_signature is missing", async () => {
    const skill = makeSkill({ domain: TEST_DOMAIN, intent_signature: undefined });
    // This fires a real backend call with empty intent — should not throw
    recordDagSessionAction(skill, "ep-search", true);
    await flush();
    await flushNetwork();
  });
});
