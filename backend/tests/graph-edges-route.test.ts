/**
 * POST /v1/graph/edges route tests — issue #218
 *
 * Tests the edge upsert route validation and service integration.
 * These are unit-level tests that verify request validation without hitting
 * EmergentDB. Integration tests are opt-in via GRAPH_TEST_RUN=1.
 *
 * Run:
 *   bun test backend/tests/graph-edges-route.test.ts
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../src/types.js";

// Build a minimal app with just the graph routes for testing
// We import the routes to verify they compile and register correctly.
import { graphRoutes } from "../src/routes/graph.js";

const app = new Hono<{ Bindings: Env }>();
app.route("/v1", graphRoutes);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postEdges(body: unknown) {
  const req = new Request("http://localhost/v1/graph/edges", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // We need to provide bindings — use minimal stubs
  const env = {
    EMERGENTDB_API_KEY: "test-key",
    ENVIRONMENT: "staging",
  } as unknown as Env;
  return app.fetch(req, env);
}

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("POST /v1/graph/edges — validation", () => {
  it("returns 400 when domain is missing", async () => {
    const res = await postEdges({
      node: { endpoint_id: "ep-1" },
      edges: [],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("domain");
  });

  it("returns 400 when node is missing", async () => {
    const res = await postEdges({
      domain: "example.com",
      edges: [],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("endpoint_id");
  });

  it("returns 400 when node.endpoint_id is missing", async () => {
    const res = await postEdges({
      domain: "example.com",
      node: {},
      edges: [],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("endpoint_id");
  });

  it("returns 400 when domain is empty string", async () => {
    const res = await postEdges({
      domain: "",
      node: { endpoint_id: "ep-1" },
      edges: [],
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Integration tests (opt-in)
// ---------------------------------------------------------------------------

const GRAPH_TEST_RUN = process.env.GRAPH_TEST_RUN === "1";
const API_URL = process.env.GRAPH_TEST_API_URL ?? "https://beta-api.unbrowse.ai";
const API_KEY = process.env.GRAPH_TEST_API_KEY ?? "";
const TIMEOUT = 30_000;
const integrationDescribe = GRAPH_TEST_RUN ? describe : describe.skip;

integrationDescribe("POST /v1/graph/edges — integration", () => {
  it("upserts edges for a test node", async () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
    const res = await fetch(`${API_URL}/v1/graph/edges`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        domain: "test-integration.example.com",
        node: {
          endpoint_id: "ep-search",
          requires: [],
          provides: ["item_id"],
          action_kind: "search",
          resource_kind: "item",
        },
        edges: [{ to: "ep-detail", binding: "item_id" }],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  }, TIMEOUT);
});
