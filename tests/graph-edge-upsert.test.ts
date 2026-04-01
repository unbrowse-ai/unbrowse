/**
 * Edge publishing tests — issue #218
 *
 * Tests the publishEdgesToBackend function:
 * - Converts SkillOperationGraph format to backend GraphNode/GraphEdge format
 * - Fire-and-forget semantics (never throws on network failure)
 * - Correct POST bodies per operation node
 *
 * Run:
 *   bun test tests/graph-edge-upsert.test.ts
 */
import { describe, expect, it, beforeEach, mock, afterEach } from "bun:test";
import type { SkillManifest } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Stub cachePublishedSkill + fetch before importing dag-feedback
// ---------------------------------------------------------------------------

const cachePublishedSkillCalls: SkillManifest[] = [];

mock.module("../src/client/index.js", () => ({
  cachePublishedSkill: (skill: SkillManifest) => {
    cachePublishedSkillCalls.push(structuredClone(skill));
  },
  isLocalOnlyMode: () => true,
  getApiKey: () => "test-key",
}));

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

// ---------------------------------------------------------------------------
// Fetch spy
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> };
let fetchCalls: FetchCall[] = [];
let fetchShouldFail = false;
const originalFetch = globalThis.fetch;

function installFetchSpy() {
  fetchCalls = [];
  (globalThis as any).fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/v1/graph/edges")) {
      const body = JSON.parse(init?.body as string);
      fetchCalls.push({ url: urlStr, init: init!, body });
      if (fetchShouldFail) throw new Error("network failure");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return originalFetch(url as any, init);
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
  fetchShouldFail = false;
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
    domain: "example.com",
    description: "Test",
    owner_type: "agent",
    execution_type: "http",
    endpoints: [
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
    ],
    lifecycle: "active",
    created_at: now,
    updated_at: now,
  } as SkillManifest;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  cachePublishedSkillCalls.length = 0;
  _resetForTesting(TEST_DEBOUNCE_MS);
  installFetchSpy();
});

afterEach(() => {
  restoreFetch();
});

// ---------------------------------------------------------------------------
// publishEdgesToBackend — format conversion
// ---------------------------------------------------------------------------

describe("publishEdgesToBackend", () => {
  it("converts operation graph to backend format correctly", () => {
    const graph = {
      operations: [
        {
          operation_id: "ep-search",
          endpoint_id: "ep-search",
          method: "GET" as const,
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
          method: "GET" as const,
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
          edge_id: "ep-search:ep-detail:item_id",
          from_operation_id: "ep-search",
          to_operation_id: "ep-detail",
          binding_key: "item_id",
          kind: "dependency" as const,
          confidence: 0.9,
        },
      ],
    };

    publishEdgesToBackend("example.com", graph);

    // Should send one POST per operation node
    expect(fetchCalls).toHaveLength(2);

    // First call: ep-search node (has outgoing edge)
    const searchCall = fetchCalls.find((c) => c.body.node?.endpoint_id === "ep-search")!;
    expect(searchCall).toBeDefined();
    expect(searchCall.body.domain).toBe("example.com");
    expect(searchCall.body.node).toEqual({
      endpoint_id: "ep-search",
      requires: [],
      provides: ["item_id"],
      action_kind: "search",
      resource_kind: "item",
    });
    expect(searchCall.body.edges).toEqual([{ to: "ep-detail", binding: "item_id" }]);

    // Second call: ep-detail node (no outgoing edges)
    const detailCall = fetchCalls.find((c) => c.body.node?.endpoint_id === "ep-detail")!;
    expect(detailCall).toBeDefined();
    expect(detailCall.body.node).toEqual({
      endpoint_id: "ep-detail",
      requires: ["item_id"],
      provides: ["item_id"],
      action_kind: "detail",
      resource_kind: "item",
    });
    expect(detailCall.body.edges).toEqual([]);
  });

  it("uses UNBROWSE_API_URL env var when set", () => {
    process.env.UNBROWSE_API_URL = "https://custom-api.example.com";
    try {
      publishEdgesToBackend("test.com", {
        operations: [{
          operation_id: "op1",
          endpoint_id: "op1",
          method: "GET" as const,
          url_template: "https://test.com/api",
          action_kind: "search",
          resource_kind: "item",
          requires: [],
          provides: [],
          confidence: 0.9,
        }],
        edges: [],
      });
      expect(fetchCalls[0]!.url).toBe("https://custom-api.example.com/v1/graph/edges");
    } finally {
      delete process.env.UNBROWSE_API_URL;
    }
  });

  it("does not throw on network failure (fire-and-forget)", async () => {
    fetchShouldFail = true;
    // Should not throw
    publishEdgesToBackend("example.com", {
      operations: [{
        operation_id: "op1",
        endpoint_id: "op1",
        method: "GET" as const,
        url_template: "https://example.com/api",
        action_kind: "search",
        resource_kind: "item",
        requires: [],
        provides: [],
        confidence: 0.9,
      }],
      edges: [],
    });

    // Wait for promises to settle
    await new Promise((r) => setTimeout(r, 50));
    // If we got here without throwing, the test passes
    expect(fetchCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// upsertDagEdgesFromOperationGraph — end-to-end with backend publish
// ---------------------------------------------------------------------------

describe("upsertDagEdgesFromOperationGraph — backend publishing", () => {
  it("publishes edges to backend after rebuilding operation graph", async () => {
    const skill = makeSkillWithEndpoints();
    upsertDagEdgesFromOperationGraph(skill);
    await flush();

    // Should have cached the skill locally
    expect(cachePublishedSkillCalls).toHaveLength(1);

    // Should have published edges to backend (one per operation node)
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);

    // Verify at least one call has the domain
    const domains = fetchCalls.map((c) => c.body.domain);
    expect(domains).toContain("example.com");
  });

  it("still caches locally even when backend publish fails", async () => {
    fetchShouldFail = true;
    const skill = makeSkillWithEndpoints();
    upsertDagEdgesFromOperationGraph(skill);
    await flush();

    // Local cache should still work
    expect(cachePublishedSkillCalls).toHaveLength(1);
    expect(cachePublishedSkillCalls[0]!.operation_graph).toBeDefined();
  });
});
