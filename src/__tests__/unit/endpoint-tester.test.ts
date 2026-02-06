/**
 * Unit tests for endpoint-tester.ts
 *
 * Tests the exported function:
 *   - testGetEndpoints()
 *
 * Uses a local Bun HTTP server to test real fetch behavior
 * without mocking.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { testGetEndpoints } from "../../endpoint-tester.js";

// ── Local test server ────────────────────────────────────────────────────────

let server: { port: number; stop(closeActiveConnections?: boolean): void };
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0, // random available port
    fetch(req: Request) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/api/items") {
        return Response.json([{ id: 1, name: "Item A" }, { id: 2, name: "Item B" }]);
      }
      if (path === "/api/users") {
        return Response.json({ users: [{ id: 1 }], total: 1 });
      }
      if (path === "/api/empty") {
        return new Response("", { status: 200 });
      }
      if (path === "/api/html") {
        const body = "<html><body>" + "x".repeat(300) + "</body></html>";
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (path === "/api/short-text") {
        return new Response("OK", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      if (path === "/api/scalar") {
        return new Response("42", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/api/null-json") {
        return Response.json(null);
      }
      if (path === "/api/protected") {
        const auth = req.headers.get("Authorization");
        if (auth === "Bearer test-token") {
          return Response.json({ secret: "data" });
        }
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (path === "/api/cookie-check") {
        const cookie = req.headers.get("Cookie") ?? "";
        if (cookie.includes("session=abc")) {
          return Response.json({ authed: true });
        }
        return Response.json({ authed: false }, { status: 403 });
      }
      if (path === "/api/slow") {
        // Delay 5 seconds (should timeout in tests)
        return new Promise<Response>((resolve) =>
          setTimeout(() => resolve(Response.json({ ok: true })), 5000),
        );
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

// ── testGetEndpoints ─────────────────────────────────────────────────────────

describe("testGetEndpoints", () => {
  it("tests GET endpoints and returns results", async () => {
    const endpoints = {
      "items": [{ method: "GET", path: "/api/items" }],
      "users": [{ method: "GET", path: "/api/users" }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    expect(summary.total).toBe(2);
    expect(summary.results).toHaveLength(2);

    const itemsResult = summary.results.find(r => r.path === "/api/items");
    expect(itemsResult).toBeDefined();
    expect(itemsResult!.ok).toBe(true);
    expect(itemsResult!.hasData).toBe(true);
    expect(itemsResult!.responseShape).toBe("array[2]");
    expect(itemsResult!.status).toBe(200);

    const usersResult = summary.results.find(r => r.path === "/api/users");
    expect(usersResult).toBeDefined();
    expect(usersResult!.ok).toBe(true);
    expect(usersResult!.responseShape).toMatch(/^object\{/);
  });

  it("skips non-GET endpoints", async () => {
    const endpoints = {
      "get-items": [{ method: "GET", path: "/api/items" }],
      "post-items": [{ method: "POST", path: "/api/items" }],
      "put-users": [{ method: "PUT", path: "/api/users/1" }],
      "delete-users": [{ method: "DELETE", path: "/api/users/1" }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    expect(summary.total).toBe(1);
    expect(summary.skipped).toBe(3);
    expect(summary.results[0].path).toBe("/api/items");
  });

  it("skips paths with template variables", async () => {
    const endpoints = {
      "items": [{ method: "GET", path: "/api/items" }],
      "item-by-id": [{ method: "GET", path: "/api/items/{itemId}" }],
      "user-profile": [{ method: "GET", path: "/api/users/{userId}/profile" }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    expect(summary.total).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.results[0].path).toBe("/api/items");
  });

  it("deduplicates endpoints by path", async () => {
    const endpoints = {
      "items-a": [{ method: "GET", path: "/api/items" }],
      "items-b": [{ method: "GET", path: "/api/items" }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    expect(summary.total).toBe(1);
  });

  it("respects maxEndpoints limit", async () => {
    const endpoints: Record<string, Array<{ method: string; path: string }>> = {};
    for (let i = 0; i < 10; i++) {
      endpoints[`ep-${i}`] = [{ method: "GET", path: `/api/e${i}` }];
    }

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      maxEndpoints: 3,
      timeoutMs: 5000,
    });

    expect(summary.total).toBe(3);
    expect(summary.results).toHaveLength(3);
  });

  it("sends auth headers to endpoints", async () => {
    const endpoints = {
      "protected": [{ method: "GET", path: "/api/protected" }],
    };

    const summary = await testGetEndpoints(
      baseUrl,
      endpoints,
      { Authorization: "Bearer test-token" },
      {},
      { timeoutMs: 5000 },
    );

    expect(summary.results[0].ok).toBe(true);
    expect(summary.results[0].status).toBe(200);
    expect(summary.verified).toBe(1);
  });

  it("sends cookies as Cookie header", async () => {
    const endpoints = {
      "cookie-check": [{ method: "GET", path: "/api/cookie-check" }],
    };

    const summary = await testGetEndpoints(
      baseUrl,
      endpoints,
      {},
      { session: "abc", user: "bob" },
      { timeoutMs: 5000 },
    );

    expect(summary.results[0].ok).toBe(true);
    expect(summary.results[0].status).toBe(200);
  });

  it("classifies empty responses correctly", async () => {
    const endpoints = {
      "empty": [{ method: "GET", path: "/api/empty" }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    expect(summary.results[0].responseShape).toBe("empty");
    expect(summary.results[0].hasData).toBe(false);
  });

  it("classifies long non-JSON as html/text", async () => {
    const endpoints = {
      "html": [{ method: "GET", path: "/api/html" }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    expect(summary.results[0].responseShape).toBe("html/text");
    expect(summary.results[0].hasData).toBe(true);
  });

  it("classifies short non-JSON as non-json", async () => {
    const endpoints = {
      "short": [{ method: "GET", path: "/api/short-text" }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    expect(summary.results[0].responseShape).toBe("non-json");
  });

  it("classifies scalar JSON responses", async () => {
    const endpoints = {
      "scalar": [{ method: "GET", path: "/api/scalar" }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    expect(summary.results[0].responseShape).toBe("number");
    expect(summary.results[0].hasData).toBe(true);
  });

  it("handles timeout with error shape", async () => {
    const endpoints = {
      "slow": [{ method: "GET", path: "/api/slow" }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 100, // Very short timeout
    });

    expect(summary.results[0].ok).toBe(false);
    expect(summary.results[0].status).toBe(0);
    expect(summary.results[0].responseShape).toBe("error");
    expect(summary.failed).toBe(1);
  });

  it("counts verified and failed correctly", async () => {
    const endpoints = {
      "good": [{ method: "GET", path: "/api/items" }],
      "bad": [{ method: "GET", path: "/api/protected" }], // 401 without auth
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    expect(summary.total).toBe(2);
    // items returns ok+hasData => verified
    expect(summary.verified).toBe(1);
    // protected returns 401 => failed
    expect(summary.failed).toBe(1);
  });

  it("handles empty endpoints map", async () => {
    const summary = await testGetEndpoints(baseUrl, {}, {}, {});

    expect(summary.total).toBe(0);
    expect(summary.verified).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.results).toEqual([]);
  });

  it("records latency for each result", async () => {
    const endpoints = {
      "items": [{ method: "GET", path: "/api/items" }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    expect(summary.results[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("uses endpoint url when provided", async () => {
    const endpoints = {
      "items": [{ method: "GET", path: "/api/items", url: `${baseUrl}/api/users` }],
    };

    const summary = await testGetEndpoints(baseUrl, endpoints, {}, {}, {
      timeoutMs: 5000,
    });

    // Should have fetched /api/users (from url) not /api/items (from path)
    expect(summary.results[0].url).toBe(`${baseUrl}/api/users`);
    expect(summary.results[0].ok).toBe(true);
    expect(summary.results[0].responseShape).toMatch(/^object\{/);
  });
});
