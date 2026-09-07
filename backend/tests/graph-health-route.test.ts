import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../src/types.js";
import { graphRoutes } from "../src/routes/graph.js";

const app = new Hono<{ Bindings: Env }>();
app.route("/v1", graphRoutes);

const env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test-key",
  EMERGENTDB_TIMEOUT_MS: "50",
  ENVIRONMENT: "staging",
} as unknown as Env;

function graphRequest(path: string) {
  return app.fetch(new Request(`http://local.test${path}`), env);
}

describe("graph health and credits", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reports EmergentDB graph health without treating credits as a gate", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      expect(url.hostname).toBe("api.emergentdb.com");
      expect(url.pathname).toBe("/health");
      return Response.json({
        status: "ok",
        services: {
          bolt: { status: "healthy", shards: 3 },
          qdkv: { status: "healthy" },
        },
      });
    }) as typeof fetch;

    const res = await graphRequest("/v1/graph/health");
    expect(res.status).toBe(200);
    const data = await res.json() as {
      backend: string;
      available: boolean;
      credit_balance_gates_graph: boolean;
    };
    expect(data.backend).toBe("emergentdb");
    expect(data.available).toBe(true);
    expect(data.credit_balance_gates_graph).toBe(false);
  });

  it("returns zero credits as observability, not graph disablement", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      expect(url.pathname).toBe("/graph/credits");
      return Response.json({ balance_micro: 0, balance_usd: "$0.000000" });
    }) as typeof fetch;

    const res = await graphRequest("/v1/graph/credits");
    expect(res.status).toBe(200);
    const data = await res.json() as {
      balance_micro: number;
      credit_balance_gates_graph: boolean;
    };
    expect(data.balance_micro).toBe(0);
    expect(data.credit_balance_gates_graph).toBe(false);
  });

  it("keeps credit lookup failures non-blocking", async () => {
    globalThis.fetch = (async () => {
      return Response.json({ error: "QDKV unavailable" }, { status: 503 });
    }) as typeof fetch;

    const res = await graphRequest("/v1/graph/credits");
    expect(res.status).toBe(200);
    const data = await res.json() as {
      available: boolean;
      credit_balance_gates_graph: boolean;
      error: string;
    };
    expect(data.available).toBe(false);
    expect(data.credit_balance_gates_graph).toBe(false);
    expect(data.error).toContain("QDKV unavailable");
  });
});
