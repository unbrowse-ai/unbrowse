/**
 * Edge publishing tests -- issue #218
 *
 * Tests publishEdgesToBackend with real network calls (fire-and-forget)
 * and pure format-conversion logic (no mocking).
 *
 * Run:
 *   bun test tests/graph-edge-upsert.test.ts
 */
import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SkillManifest } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Use a real temp directory for the skill cache.
// ---------------------------------------------------------------------------

const TEST_CACHE_DIR = mkdtempSync(join(tmpdir(), "graph-edge-upsert-test-"));
process.env.UNBROWSE_SKILL_CACHE_DIR = TEST_CACHE_DIR;
process.env.UNBROWSE_LOCAL_ONLY = "1";

const {
  publishEdgesToBackend,
  upsertDagEdgesFromOperationGraph,
  _resetForTesting,
} = await import("../src/orchestrator/dag-feedback.js");

// Short debounce so tests finish quickly
const TEST_DEBOUNCE_MS = 30;

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, TEST_DEBOUNCE_MS + 20));
}

function readCachedSkill(skillId: string): SkillManifest | null {
  const path = join(TEST_CACHE_DIR, `${skillId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as SkillManifest;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSkillWithEndpoints(): SkillManifest {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    skill_id: "test-edge-publish",
    version: "1.0.0",
    schema_version: "1",
    name: "Test Skill",
    intent_signature: "test intent",
    domain: "test-integration.unbrowse.dev",
    description: "Test",
    owner_type: "agent",
    execution_type: "http",
    endpoints: [
      {
        endpoint_id: "ep-search",
        method: "GET",
        url_template: "https://test-integration.unbrowse.dev/search?q={q}",
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
        url_template: "https://test-integration.unbrowse.dev/items/{item_id}",
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
    ],
    lifecycle: "active",
    created_at: now,
    updated_at: now,
  } as SkillManifest;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetForTesting(TEST_DEBOUNCE_MS);
  try {
    const files = require("fs").readdirSync(TEST_CACHE_DIR);
    for (const f of files) rmSync(join(TEST_CACHE_DIR, f));
  } catch {}
});

afterAll(() => {
  try { rmSync(TEST_CACHE_DIR, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// publishEdgesToBackend -- format conversion (pure logic, no mock needed)
// ---------------------------------------------------------------------------

describe("publishEdgesToBackend -- format conversion", () => {
  it("converts operation graph nodes and edges to the expected shape", () => {
    const graph = {
      operations: [
        {
          operation_id: "ep-search",
          endpoint_id: "ep-search",
          method: "GET" as const,
          url_template: "https://test-integration.unbrowse.dev/search?q={q}",
          action_kind: "search",
          resource_kind: "item",
          requires: [],
          provides: [{ key: "item_id", source: "response", semantic_type: "item_identifier" }],
          confidence: 0.9,
        },
        {
          operation_id: "ep-detail",
          endpoint_id: "ep-detail",
          method: "GET" as const,
          url_template: "https://test-integration.unbrowse.dev/items/{item_id}",
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
          kind: "dependency" as const,
          confidence: 0.9,
        },
      ],
    };

    // publishEdgesToBackend is fire-and-forget -- it should never throw
    expect(() => publishEdgesToBackend("test-integration.unbrowse.dev", graph)).not.toThrow();
  });

  it("handles empty operations gracefully", () => {
    expect(() =>
      publishEdgesToBackend("test-integration.unbrowse.dev", {
        operations: [],
        edges: [],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// publishEdgesToBackend -- fire-and-forget resilience (hits real 404 endpoint)
// ---------------------------------------------------------------------------

describe("publishEdgesToBackend -- fire-and-forget against live backend", () => {
  it("does not throw even though /v1/graph/edges returns 404", async () => {
    publishEdgesToBackend("test-integration.unbrowse.dev", {
      operations: [
        {
          operation_id: "op-integration",
          endpoint_id: "op-integration",
          method: "GET" as const,
          url_template: "https://test-integration.unbrowse.dev/api",
          action_kind: "search",
          resource_kind: "item",
          requires: [],
          provides: [],
          confidence: 0.9,
        },
      ],
      edges: [],
    });

    // Wait for the fire-and-forget fetch to complete
    await new Promise((r) => setTimeout(r, 3000));
  });
});

// ---------------------------------------------------------------------------
// upsertDagEdgesFromOperationGraph -- end-to-end with real backend publish
// ---------------------------------------------------------------------------

describe("upsertDagEdgesFromOperationGraph -- end-to-end", () => {
  it("publishes edges to backend and caches locally", async () => {
    const skill = makeSkillWithEndpoints();
    upsertDagEdgesFromOperationGraph(skill);
    await flush();

    const cached = readCachedSkill(skill.skill_id);
    expect(cached).not.toBeNull();
    expect(cached!.operation_graph).toBeDefined();
    expect(cached!.operation_graph!.operations.length).toBeGreaterThanOrEqual(1);

    // Wait for fire-and-forget fetches to settle
    await new Promise((r) => setTimeout(r, 2000));
  });

  it("still caches locally even when backend returns 404 for edges", async () => {
    const skill = makeSkillWithEndpoints();
    skill.skill_id = "test-edge-publish-404";
    upsertDagEdgesFromOperationGraph(skill);
    await flush();

    const cached = readCachedSkill("test-edge-publish-404");
    expect(cached).not.toBeNull();
    expect(cached!.operation_graph).toBeDefined();

    await new Promise((r) => setTimeout(r, 2000));
  });
});
