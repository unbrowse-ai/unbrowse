import { describe, expect, it } from "bun:test";
import { verifyAndPruneGetEndpoints } from "@getfoundry/unbrowse-core";
import type { ApiData } from "@getfoundry/unbrowse-core";

describe("verifyAndPruneGetEndpoints", () => {
  it("prunes failing tested GET endpoints and keeps verified GET + non-GET", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/ok")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/fail")) {
        return new Response("nope", { status: 500, headers: { "content-type": "text/plain" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const apiData: ApiData = {
        service: "demo",
        baseUrls: ["https://api.example.com"],
        baseUrl: "https://api.example.com",
        authHeaders: {},
        authMethod: "cookie",
        cookies: {},
        authInfo: {},
        requests: [
          { method: "GET", url: "https://api.example.com/ok", path: "/ok", domain: "api.example.com", status: 200 },
          { method: "GET", url: "https://api.example.com/fail", path: "/fail", domain: "api.example.com", status: 200 },
          { method: "POST", url: "https://api.example.com/write", path: "/write", domain: "api.example.com", status: 200 },
        ],
        endpoints: {
          "api.example.com:/ok": [{ method: "GET", url: "https://api.example.com/ok", path: "/ok", domain: "api.example.com", status: 200 }],
          "api.example.com:/fail": [{ method: "GET", url: "https://api.example.com/fail", path: "/fail", domain: "api.example.com", status: 200 }],
          "api.example.com:/write": [{ method: "POST", url: "https://api.example.com/write", path: "/write", domain: "api.example.com", status: 200 }],
        },
      };

      const summary = await verifyAndPruneGetEndpoints(apiData, {});
      expect(summary).toBeTruthy();
      expect(summary?.total).toBe(2);
      expect(summary?.verified).toBe(1);
      expect(summary?.pruned).toBe(1);
      expect(apiData.endpoints["api.example.com:/fail"]).toBeUndefined();
      expect(apiData.endpoints["api.example.com:/ok"]?.[0]?.verified).toBe(true);
      expect(apiData.endpoints["api.example.com:/write"]?.[0]?.method).toBe("POST");
      expect(apiData.requests.some((r) => r.path === "/fail")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not prune templated GET paths that are not testable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const apiData: ApiData = {
        service: "demo",
        baseUrls: ["https://api.example.com"],
        baseUrl: "https://api.example.com",
        authHeaders: {},
        authMethod: "cookie",
        cookies: {},
        authInfo: {},
        requests: [
          { method: "GET", url: "https://api.example.com/users/{id}", path: "/users/{id}", domain: "api.example.com", status: 200 },
        ],
        endpoints: {
          "api.example.com:/users/{id}": [{ method: "GET", url: "https://api.example.com/users/{id}", path: "/users/{id}", domain: "api.example.com", status: 200 }],
        },
      };

      const summary = await verifyAndPruneGetEndpoints(apiData, {});
      expect(summary).toBeTruthy();
      expect(summary?.total).toBe(0);
      expect(summary?.pruned).toBe(0);
      expect(apiData.endpoints["api.example.com:/users/{id}"]).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
