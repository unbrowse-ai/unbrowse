/**
 * POST /v1/graph/augment-semantic + augmentEndpointsSemantic service.
 *
 * The endpoint-skeleton enrichment prompt + model orchestration moved
 * server-side here (was src/graph/agent-augment.ts client-side). These
 * tests assert the best-effort, non-blocking contract: any failure
 * (empty input, no model key, augment disabled, bad JSON) returns 200
 * with `{ endpoints: [] }` so the client falls back to its local
 * heuristic. No mocks: the only network path (live LLM) is opt-in via
 * SEMANTIC_AUGMENT_TEST_RUN=1.
 *
 * Run: bun test backend/tests/semantic-augment-route.test.ts
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../src/types.js";
import { graphRoutes } from "../src/routes/graph.js";
import { augmentEndpointsSemantic } from "../src/services/semantic-augment.js";

const app = new Hono<{ Bindings: Env }>();
app.route("/v1", graphRoutes);

const TEST_API_KEY = "test-admin-key";

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    API_KEY: TEST_API_KEY,
    EMERGENTDB_API_KEY: "test-key",
    ENVIRONMENT: "staging",
    NEBIUS_API_KEY: "",
    ...overrides,
  } as unknown as Env;
}

async function postAugment(body: unknown, env: Env) {
  const req = new Request("http://localhost/v1/graph/augment-semantic", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_API_KEY}` },
    body: JSON.stringify(body),
  });
  return app.fetch(req, env);
}

const SKELETON = {
  endpoint_id: "ep-1",
  method: "GET",
  url_template: "https://api.example.com/search?q={q}",
  description: "Returns resource details",
  current_semantic: {
    action_kind: "detail",
    resource_kind: "resource",
    description_out: "Returns resource details",
    requires: [{ key: "q", required: false, source: "query", semantic_type: "input" }],
    provides: [],
    negative_tags: [],
  },
  sample_request: { q: "openai" },
  sample_response: { items: [{ id: 1 }] },
  example_fields: ["items[].id"],
};

describe("POST /v1/graph/augment-semantic: best-effort contract", () => {
  it("returns 200 {endpoints:[]} when endpoints is empty", async () => {
    const res = await postAugment({ intent: "x", domain: "example.com", endpoints: [] }, envWith());
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ endpoints: [] });
  });

  it("returns 200 {endpoints:[]} when endpoints is missing", async () => {
    const res = await postAugment({ intent: "x", domain: "example.com" }, envWith());
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ endpoints: [] });
  });

  it("returns 200 {endpoints:[]} when NEBIUS_API_KEY is unset (no model)", async () => {
    const res = await postAugment(
      { intent: "search", domain: "example.com", endpoints: [SKELETON] },
      envWith({ NEBIUS_API_KEY: "" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ endpoints: [] });
  });

  it("returns 200 {endpoints:[]} when augmentation is disabled by env", async () => {
    const res = await postAugment(
      { intent: "search", domain: "example.com", endpoints: [SKELETON] },
      envWith({ NEBIUS_API_KEY: "would-not-be-used", UNBROWSE_AGENT_SEMANTIC_AUGMENT: "0" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ endpoints: [] });
  });

  it("never 4xx/5xx on a malformed JSON body: degrades to {endpoints:[]}", async () => {
    const req = new Request("http://localhost/v1/graph/augment-semantic", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_API_KEY}` },
      body: "{ not json",
    });
    const res = await app.fetch(req, envWith());
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ endpoints: [] });
  });
});

describe("augmentEndpointsSemantic: service unit (no network)", () => {
  it("returns {endpoints:[]} when disabled, regardless of key/input", async () => {
    const out = await augmentEndpointsSemantic(
      envWith({ NEBIUS_API_KEY: "set", UNBROWSE_AGENT_SEMANTIC_AUGMENT: "0" }),
      { intent: "search", domain: "example.com", endpoints: [SKELETON] },
    );
    expect(out).toEqual({ endpoints: [] });
  });

  it("returns {endpoints:[]} when no model key is configured", async () => {
    const out = await augmentEndpointsSemantic(
      envWith({ NEBIUS_API_KEY: "" }),
      { intent: "search", domain: "example.com", endpoints: [SKELETON] },
    );
    expect(out).toEqual({ endpoints: [] });
  });

  it("returns {endpoints:[]} for empty input even with a key set", async () => {
    const out = await augmentEndpointsSemantic(
      envWith({ NEBIUS_API_KEY: "set" }),
      { intent: "search", domain: "example.com", endpoints: [] },
    );
    expect(out).toEqual({ endpoints: [] });
  });
});

// Live LLM round-trip: opt-in. Requires a real NEBIUS_API_KEY in env.
const liveIt =
  process.env.SEMANTIC_AUGMENT_TEST_RUN === "1" && process.env.NEBIUS_API_KEY ? it : it.skip;

describe("augmentEndpointsSemantic: live model (opt-in)", () => {
  liveIt(
    "enriches a real skeleton via the configured semantic model",
    async () => {
      const out = await augmentEndpointsSemantic(
        envWith({ NEBIUS_API_KEY: process.env.NEBIUS_API_KEY ?? "" }),
        {
          intent: "search repositories",
          domain: "example.com",
          endpoints: [{
            ...SKELETON,
            url_template: "https://api.github.com/search/repositories?q={q}",
          }],
        },
      );
      expect(Array.isArray(out.endpoints)).toBe(true);
      for (const e of out.endpoints) {
        expect(typeof e).toBe("object");
      }
    },
    30_000,
  );
});
