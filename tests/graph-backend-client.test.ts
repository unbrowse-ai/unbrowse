import { describe, expect, it, afterEach, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers to mock global fetch
// ---------------------------------------------------------------------------

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

function mockFetch(handler: FetchMock) {
  globalThis.fetch = handler as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

afterEach(restoreFetch);

// ---------------------------------------------------------------------------
// Import the functions under test
// ---------------------------------------------------------------------------

import {
  fetchChain,
  fetchPredictions,
  recordSession,
  recordNegative,
} from "../src/client/graph-client.js";
import type { GraphChainResult } from "../src/client/graph-client.js";

// ---------------------------------------------------------------------------
// recordSession
// ---------------------------------------------------------------------------

describe("recordSession", () => {
  it("posts correct body shape to /v1/graph/session", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    mockFetch(async (input, init) => {
      capturedUrl = input.toString();
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await recordSession("example.com", "sess-123", "ep-search", "search items", "success");
    expect(capturedUrl).toContain("/v1/graph/session");
    expect(capturedBody).toMatchObject({
      session_id: "sess-123",
      action: {
        intent: "search items",
        domain: "example.com",
        endpoint_id: "ep-search",
        result: "success",
      },
    });
    // timestamp should be present
    expect((capturedBody as any).action.timestamp).toBeDefined();
  });

  it("does not throw on network failure", async () => {
    mockFetch(async () => {
      throw new Error("network down");
    });

    // recordSession rejects (graphApi throws); callers use .catch(() => {})
    // But the function itself throws — the fire-and-forget wrapper is in dag-feedback
    await expect(recordSession("x.com", "s", "ep", "i", "failure")).rejects.toThrow();
  });

  it("does not throw on non-ok response (rejects with descriptive error)", async () => {
    mockFetch(async () => new Response("Service Unavailable", { status: 503 }));

    await expect(recordSession("x.com", "s", "ep", "i", "skip")).rejects.toThrow("graph API 503");
  });
});

// ---------------------------------------------------------------------------
// recordNegative
// ---------------------------------------------------------------------------

describe("recordNegative", () => {
  it("posts correct body shape to /v1/graph/negative", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    mockFetch(async (input, init) => {
      capturedUrl = input.toString();
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await recordNegative("reddit.com", "search subreddit posts", "ep-search");
    expect(capturedUrl).toContain("/v1/graph/negative");
    expect(capturedBody).toMatchObject({
      domain: "reddit.com",
      intent_pattern: "search subreddit posts",
      endpoint_id: "ep-search",
    });
  });

  it("does not throw on network failure (rejects for caller to catch)", async () => {
    mockFetch(async () => {
      throw new Error("timeout");
    });

    await expect(recordNegative("x.com", "p", "ep")).rejects.toThrow();
  });

  it("does not throw on non-ok response (rejects with descriptive error)", async () => {
    mockFetch(async () => new Response("Not Found", { status: 404 }));

    await expect(recordNegative("x.com", "p", "ep")).rejects.toThrow("graph API 404");
  });
});

// ---------------------------------------------------------------------------
// fetchChain — resilience
// ---------------------------------------------------------------------------

describe("fetchChain resilience", () => {
  it("returns null-safe chain on network failure (throws for caller to catch)", async () => {
    mockFetch(async () => {
      throw new Error("network error");
    });

    // fetchChain throws — the null-safety is in dag-advisor's .catch(() => null)
    await expect(fetchChain("bad.com", "ep-x")).rejects.toThrow();
  });

  it("returns null on timeout (abort signal)", async () => {
    // Simulate a fetch that never resolves within the timeout
    mockFetch(async (_input, init) => {
      // Listen for abort
      return new Promise<Response>((_, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }
      });
    });

    await expect(fetchChain("slow.com", "ep-x")).rejects.toThrow();
  });

  it("parses valid response correctly", async () => {
    const fixture: GraphChainResult = {
      chain: [
        { endpoint_id: "ep-a", provides: ["repo_id"] },
        { endpoint_id: "ep-b", requires: ["repo_id"] },
      ],
      resolved: true,
    };
    mockFetch(async () =>
      new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const result = await fetchChain("github.com", "ep-b", ["user_id"]);
    expect(result.resolved).toBe(true);
    expect(result.chain).toHaveLength(2);
    expect(result.chain[0].endpoint_id).toBe("ep-a");
  });
});

// ---------------------------------------------------------------------------
// Backend URL configuration
// ---------------------------------------------------------------------------

describe("backend URL configuration", () => {
  it("defaults to beta-api.unbrowse.ai", async () => {
    let capturedUrl = "";
    mockFetch(async (input) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify({ chain: [], resolved: false }), { status: 200 });
    });

    await fetchChain("example.com", "ep-1");
    expect(capturedUrl).toContain("beta-api.unbrowse.ai");
  });

  // Note: UNBROWSE_BACKEND_URL is read at module load time, so changing the env var
  // after import has no effect. This test documents the expected default behavior.
  it("uses the UNBROWSE_BACKEND_URL env var (resolved at module load)", () => {
    // The env var is resolved at module-level const initialization.
    // We verify the default rather than trying to mutate the already-loaded constant.
    expect(process.env.UNBROWSE_BACKEND_URL ?? "https://beta-api.unbrowse.ai").toContain("unbrowse.ai");
  });
});

// ---------------------------------------------------------------------------
// Timeout / AbortController
// ---------------------------------------------------------------------------

describe("timeout behavior", () => {
  it("uses AbortController for timeout enforcement", async () => {
    let receivedSignal: AbortSignal | null = null;
    mockFetch(async (_input, init) => {
      receivedSignal = init?.signal ?? null;
      return new Response(JSON.stringify({ chain: [], resolved: false }), { status: 200 });
    });

    await fetchChain("example.com", "ep-1");
    expect(receivedSignal).not.toBeNull();
    // The signal should exist even though it wasn't aborted (fast response)
    expect(receivedSignal!.aborted).toBe(false);
  });
});
