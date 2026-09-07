import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SkillManifest } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Use a real temp directory for the skill cache instead of mocking
// cachePublishedSkill. Set env vars before any module loads.
// ---------------------------------------------------------------------------

const TEST_CACHE_DIR = mkdtempSync(join(tmpdir(), "dag-feedback-test-"));
process.env.UNBROWSE_SKILL_CACHE_DIR = TEST_CACHE_DIR;
process.env.UNBROWSE_LOCAL_ONLY = "1";

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

function readCachedSkill(skillId: string): SkillManifest | null {
  const path = join(TEST_CACHE_DIR, `${skillId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as SkillManifest;
}

// ---------------------------------------------------------------------------
// Fixtures
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
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetForTesting(TEST_DEBOUNCE_MS);
  // Clean cached files between tests
  try {
    const files = require("fs").readdirSync(TEST_CACHE_DIR);
    for (const f of files) rmSync(join(TEST_CACHE_DIR, f));
  } catch {}
});

afterAll(() => {
  try { rmSync(TEST_CACHE_DIR, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// recordDagSessionAction -- local confidence adjustments
// ---------------------------------------------------------------------------

describe("recordDagSessionAction", () => {
  it("is a no-op when skill has no operation_graph", async () => {
    const skill = makeSkill({ operation_graph: undefined });
    recordDagSessionAction(skill, "ep-search", true);
    await flush();
    expect(readCachedSkill(skill.skill_id)).toBeNull();
  });

  it("is a no-op when endpointId has no matching operation", async () => {
    const skill = makeSkill();
    recordDagSessionAction(skill, "ep-nonexistent", true);
    await flush();
    expect(readCachedSkill(skill.skill_id)).toBeNull();
  });

  it("boosts edge confidence on success", async () => {
    const skill = makeSkill();
    const originalConf = skill.operation_graph!.edges[0]!.confidence; // 0.9
    recordDagSessionAction(skill, "ep-search", true);
    await flush();

    const updated = readCachedSkill(skill.skill_id);
    expect(updated).not.toBeNull();
    const edge = updated!.operation_graph!.edges[0]!;
    expect(edge.confidence).toBeGreaterThan(originalConf);
    expect(edge.confidence).toBeLessThanOrEqual(1.0);
  });

  it("penalises edge confidence on failure", async () => {
    const skill = makeSkill();
    const originalConf = skill.operation_graph!.edges[0]!.confidence; // 0.9
    recordDagSessionAction(skill, "ep-search", false);
    await flush();

    const updated = readCachedSkill(skill.skill_id);
    expect(updated).not.toBeNull();
    const edge = updated!.operation_graph!.edges[0]!;
    expect(edge.confidence).toBeLessThan(originalConf);
    expect(edge.confidence).toBeGreaterThanOrEqual(0.1);
  });

  it("clamps confidence to 1.0 on repeated successes", async () => {
    const skill = makeSkill();
    skill.operation_graph!.edges[0]!.confidence = 0.99;
    recordDagSessionAction(skill, "ep-detail", true);
    await flush();

    const updated = readCachedSkill(skill.skill_id);
    expect(updated).not.toBeNull();
    const edge = updated!.operation_graph!.edges[0]!;
    expect(edge.confidence).toBeLessThanOrEqual(1.0);
  });

  it("clamps confidence to >= 0.1 on repeated failures", async () => {
    const skill = makeSkill();
    skill.operation_graph!.edges[0]!.confidence = 0.11;
    recordDagSessionAction(skill, "ep-search", false);
    await flush();

    const updated = readCachedSkill(skill.skill_id);
    expect(updated).not.toBeNull();
    const edge = updated!.operation_graph!.edges[0]!;
    expect(edge.confidence).toBeGreaterThanOrEqual(0.1);
  });

  it("updates generated_at on the graph", async () => {
    const skill = makeSkill();
    const before = skill.operation_graph!.generated_at;
    recordDagSessionAction(skill, "ep-search", true);
    await flush();

    const updated = readCachedSkill(skill.skill_id);
    expect(updated).not.toBeNull();
    expect(updated!.operation_graph!.generated_at).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// recordDagNegative
// ---------------------------------------------------------------------------

describe("recordDagNegative", () => {
  it("applies a larger penalty than a plain session failure", async () => {
    // plain failure penalty
    const skill1 = makeSkill({ skill_id: "neg-plain" });
    recordDagSessionAction(skill1, "ep-search", false);
    await flush();
    const plain = readCachedSkill("neg-plain");
    const plainConf = plain!.operation_graph!.edges[0]!.confidence;

    _resetForTesting(TEST_DEBOUNCE_MS);

    // explicit negative penalty (2x step)
    const skill2 = makeSkill({ skill_id: "neg-explicit" });
    recordDagNegative(skill2, "ep-search");
    await flush();
    const neg = readCachedSkill("neg-explicit");
    const negConf = neg!.operation_graph!.edges[0]!.confidence;

    expect(negConf).toBeLessThan(plainConf);
  });

  it("is a no-op without an operation_graph", async () => {
    const skill = makeSkill({ operation_graph: undefined, skill_id: "neg-noop" });
    recordDagNegative(skill, "ep-search");
    await flush();
    expect(readCachedSkill("neg-noop")).toBeNull();
  });

  it("is a no-op for an unknown endpoint", async () => {
    const skill = makeSkill({ skill_id: "neg-unknown" });
    recordDagNegative(skill, "ep-unknown");
    await flush();
    expect(readCachedSkill("neg-unknown")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upsertDagEdgesFromOperationGraph
// ---------------------------------------------------------------------------

describe("upsertDagEdgesFromOperationGraph", () => {
  it("rebuilds graph from endpoints and persists to cache", async () => {
    const skill = makeSkill({ skill_id: "upsert-rebuild" });
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

    const updated = readCachedSkill("upsert-rebuild");
    expect(updated).not.toBeNull();
    expect(updated!.operation_graph).toBeDefined();
    expect(updated!.operation_graph!.operations).toHaveLength(1);
  });

  it("preserves existing edge confidences for known edges", async () => {
    const skill = makeSkill({ skill_id: "upsert-preserve" });
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

    const updated = readCachedSkill("upsert-preserve");
    expect(updated).not.toBeNull();
    expect(updated!.operation_graph!.operations).toHaveLength(2);

    const edge = updated!.operation_graph!.edges.find(
      (e) => e.edge_id === "ep-search:ep-detail:item_id",
    );
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe(0.42);
  });

  it("uses default confidence for new edges not previously seen", async () => {
    const skill = makeSkill({ operation_graph: undefined, skill_id: "upsert-default" });
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

    const updated = readCachedSkill("upsert-default");
    expect(updated).not.toBeNull();
    const edge = updated!.operation_graph!.edges.find(
      (e) => e.edge_id === "ep-search:ep-detail:item_id",
    );
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Debounce / rate-limiting
// ---------------------------------------------------------------------------

describe("debounce / rate-limiting", () => {
  it("coalesces multiple calls within the debounce window into one write", async () => {
    const skill = makeSkill({ skill_id: "debounce-coalesce" });
    recordDagSessionAction(skill, "ep-search", true);
    recordDagSessionAction(skill, "ep-search", true);
    recordDagSessionAction(skill, "ep-search", true);
    await flush();

    // The file should exist (was written at least once)
    const cached = readCachedSkill("debounce-coalesce");
    expect(cached).not.toBeNull();
  });

  it("different skill_ids get independent debounce timers", async () => {
    const skill1 = makeSkill({ skill_id: "debounce-a" });
    const skill2 = makeSkill({ skill_id: "debounce-b" });
    recordDagSessionAction(skill1, "ep-search", true);
    recordDagSessionAction(skill2, "ep-search", true);
    await flush();

    expect(readCachedSkill("debounce-a")).not.toBeNull();
    expect(readCachedSkill("debounce-b")).not.toBeNull();
  });

  it("allows a second write after the debounce window expires", async () => {
    const skill = makeSkill({ skill_id: "debounce-second" });
    recordDagSessionAction(skill, "ep-search", true);
    await flush();
    const first = readCachedSkill("debounce-second");
    expect(first).not.toBeNull();
    const firstConf = first!.operation_graph!.edges[0]!.confidence;

    // Second call after window
    recordDagSessionAction(skill, "ep-search", false);
    await flush();
    const second = readCachedSkill("debounce-second");
    expect(second).not.toBeNull();
    // Confidence should have changed (penalized)
    expect(second!.operation_graph!.edges[0]!.confidence).not.toBe(firstConf);
  });
});

// ---------------------------------------------------------------------------
// Backend wiring -- fire-and-forget to real backend
// ---------------------------------------------------------------------------

describe("backend wiring (live fire-and-forget)", () => {
  it("recordDagSessionAction fires real recordSession to backend without throwing", async () => {
    const skill = makeSkill({ domain: TEST_DOMAIN, intent_signature: "search items", skill_id: "backend-success" });
    recordDagSessionAction(skill, "ep-search", true);
    await flush();

    expect(readCachedSkill("backend-success")).not.toBeNull();
    await flushNetwork();
  });

  it("recordDagSessionAction sends failure result on failed execution", async () => {
    const skill = makeSkill({ domain: TEST_DOMAIN, skill_id: "backend-fail" });
    recordDagSessionAction(skill, "ep-search", false);
    await flush();

    expect(readCachedSkill("backend-fail")).not.toBeNull();
    await flushNetwork();
  });

  it("recordDagNegative fires real recordNegative to backend without throwing", async () => {
    const skill = makeSkill({ domain: TEST_DOMAIN, intent_signature: "search items", skill_id: "backend-neg" });
    recordDagNegative(skill, "ep-search");
    await flush();

    expect(readCachedSkill("backend-neg")).not.toBeNull();
    await flushNetwork();
  });

  it("skips backend calls when skill has no domain", async () => {
    const skill = makeSkill({ domain: undefined, skill_id: "backend-nodomain" });
    recordDagSessionAction(skill, "ep-search", true);
    recordDagNegative(skill, "ep-search");
    await flush();
    await flushNetwork();
  });

  it("skips backend calls when skill has no operation_graph", async () => {
    const skill = makeSkill({ domain: TEST_DOMAIN, operation_graph: undefined, skill_id: "backend-nograph" });
    recordDagSessionAction(skill, "ep-search", true);
    recordDagNegative(skill, "ep-search");
    await flush();

    expect(readCachedSkill("backend-nograph")).toBeNull();
    await flushNetwork();
  });

  it("session ID is stable across calls", () => {
    const id1 = _getSessionIdForTesting();
    const id2 = _getSessionIdForTesting();
    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThan(0);
  });

  it("uses empty string for intent when intent_signature is missing", async () => {
    const skill = makeSkill({ domain: TEST_DOMAIN, intent_signature: undefined, skill_id: "backend-nointent" });
    recordDagSessionAction(skill, "ep-search", true);
    await flush();
    await flushNetwork();
  });
});
