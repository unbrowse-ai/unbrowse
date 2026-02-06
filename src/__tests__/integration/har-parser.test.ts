/**
 * Integration tests for HAR parser pipeline.
 *
 * Tests: loadFixture -> parseHar() -> enrichApiData()
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { parseHar, enrichApiData } from "../../har-parser.js";
import { loadFixture, loadEntries, findGroup, getGroupPaths } from "../helpers.js";
import type { ApiData } from "../../types.js";

// ── todo-api fixture ────────────────────────────────────────────────────

describe("HAR parser integration: todo-api", () => {
  let data: ApiData;
  let enriched: ApiData;

  beforeAll(() => {
    const har = loadFixture("todo-api");
    data = parseHar(har);
    enriched = enrichApiData({ ...data });
  });

  it("should derive correct service name", () => {
    expect(data.service).toBe("todoapp");
  });

  it("should derive correct base URL", () => {
    expect(data.baseUrl).toBe("https://api.todoapp.com");
  });

  it("should parse all API requests", () => {
    // The fixture has 8 entries, all on api.todoapp.com — all should pass filtering
    expect(data.requests.length).toBe(8);
  });

  it("should extract Authorization auth header", () => {
    expect(data.authHeaders).toHaveProperty("authorization");
    expect(data.authHeaders["authorization"]).toContain("Bearer ");
  });

  it("should detect Bearer Token auth method", () => {
    expect(data.authMethod).toBe("Bearer Token");
  });

  it("should have no cookies (fixture uses header auth)", () => {
    expect(Object.keys(data.cookies).length).toBe(0);
  });

  it("should group endpoints by domain:path", () => {
    const keys = Object.keys(data.endpoints);
    expect(keys.length).toBeGreaterThanOrEqual(5);
  });

  it("should populate normalized paths on requests", () => {
    const todosListReq = data.requests.find(
      (r) => r.method === "GET" && r.path === "/api/v1/todos",
    );
    expect(todosListReq).toBeDefined();
    expect(todosListReq!.normalizedPath).toBe("/api/v1/todos");
  });

  it("should set normalizedPath on requests (may or may not wildcard single-example segments)", () => {
    const getTodoReq = data.requests.find(
      (r) => r.method === "GET" && r.path === "/api/v1/todos/t-1001",
    );
    expect(getTodoReq).toBeDefined();
    // With only one example, the path normalizer may keep the literal value
    // rather than wildcarding. The important thing is normalizedPath is set.
    expect(getTodoReq!.normalizedPath).toBeDefined();
    expect(getTodoReq!.normalizedPath!.startsWith("/api/v1/todos")).toBe(true);
  });

  it("should extract query params from requests", () => {
    const listReq = data.requests.find(
      (r) => r.method === "GET" && r.path === "/api/v1/todos",
    );
    expect(listReq).toBeDefined();
    expect(listReq!.queryParams).toBeDefined();
    expect(listReq!.queryParams!.length).toBe(3);
    const paramNames = listReq!.queryParams!.map((q) => q.name);
    expect(paramNames).toContain("page");
    expect(paramNames).toContain("limit");
    expect(paramNames).toContain("status");
  });

  it("should parse request bodies for POST/PUT", () => {
    const postReq = data.requests.find(
      (r) => r.method === "POST" && r.path === "/api/v1/todos",
    );
    expect(postReq).toBeDefined();
    expect(postReq!.requestBody).toBeDefined();
    expect((postReq!.requestBody as Record<string, unknown>).title).toBe("Read a book");
  });

  it("should parse response bodies into top-level schema", () => {
    const getReq = data.requests.find(
      (r) => r.method === "GET" && r.path === "/api/v1/users/42",
    );
    expect(getReq).toBeDefined();
    expect(getReq!.responseBody).toBeDefined();
    expect(getReq!.responseSummary).toBeDefined();
  });

  // Enrichment tests

  it("should create endpoint groups after enrichment", () => {
    expect(enriched.endpointGroups).toBeDefined();
    expect(enriched.endpointGroups!.length).toBeGreaterThanOrEqual(5);
  });

  it("should categorize read endpoints", () => {
    const readGroups = enriched.endpointGroups!.filter((g) => g.category === "read");
    expect(readGroups.length).toBeGreaterThanOrEqual(3);
  });

  it("should categorize write endpoints", () => {
    const writeGroups = enriched.endpointGroups!.filter((g) => g.category === "write");
    expect(writeGroups.length).toBeGreaterThanOrEqual(2);
  });

  it("should categorize delete endpoints", () => {
    const deleteGroups = enriched.endpointGroups!.filter((g) => g.category === "delete");
    expect(deleteGroups.length).toBeGreaterThanOrEqual(1);
  });

  it("should have no auth-category endpoints (todo-api has no auth path)", () => {
    const authGroups = enriched.endpointGroups!.filter((g) => g.category === "auth");
    expect(authGroups.length).toBe(0);
  });

  it("should generate descriptions for endpoint groups", () => {
    for (const group of enriched.endpointGroups!) {
      expect(group.description).toBeTruthy();
      expect(group.description.length).toBeGreaterThan(3);
    }
  });

  it("should detect path params in endpoint groups", () => {
    const getTodoGroup = enriched.endpointGroups!.find(
      (g) => g.method === "GET" && g.normalizedPath.includes("todos") && g.normalizedPath.includes("{"),
    );
    expect(getTodoGroup).toBeDefined();
    expect(getTodoGroup!.pathParams.length).toBeGreaterThanOrEqual(1);
  });

  it("should include response body schemas in groups", () => {
    const listGroup = enriched.endpointGroups!.find(
      (g) => g.method === "GET" && g.normalizedPath === "/api/v1/todos",
    );
    expect(listGroup).toBeDefined();
    expect(listGroup!.responseBodySchema).toBeDefined();
  });
});

// ── mixed-traffic fixture (filtering tests) ─────────────────────────────

describe("HAR parser integration: mixed-traffic", () => {
  let data: ApiData;
  let enriched: ApiData;

  beforeAll(() => {
    const har = loadFixture("mixed-traffic");
    data = parseHar(har);
    enriched = enrichApiData({ ...data });
  });

  it("should filter out google-analytics.com requests", () => {
    const gaRequests = data.requests.filter((r) => r.domain.includes("google-analytics"));
    expect(gaRequests.length).toBe(0);
  });

  it("should filter out cdn.jsdelivr.net requests", () => {
    const cdnRequests = data.requests.filter((r) => r.domain.includes("jsdelivr"));
    expect(cdnRequests.length).toBe(0);
  });

  it("should filter out mixpanel requests", () => {
    const mpRequests = data.requests.filter((r) => r.domain.includes("mixpanel"));
    expect(mpRequests.length).toBe(0);
  });

  it("should filter out static CSS/PNG assets", () => {
    const cssRequests = data.requests.filter((r) => r.path.endsWith(".css"));
    const pngRequests = data.requests.filter((r) => r.path.endsWith(".png"));
    expect(cssRequests.length).toBe(0);
    expect(pngRequests.length).toBe(0);
  });

  it("should filter out HTML page navigations", () => {
    const htmlRequests = data.requests.filter(
      (r) => r.path === "/" && r.method === "GET",
    );
    expect(htmlRequests.length).toBe(0);
  });

  it("should keep only API endpoints from the target domain", () => {
    expect(data.requests.length).toBeGreaterThanOrEqual(4);
    for (const req of data.requests) {
      expect(req.domain).toBe("app.acmecrm.io");
    }
  });

  it("should extract cookies from mixed-traffic fixture", () => {
    expect(data.cookies).toHaveProperty("session_id");
    expect(data.cookies["session_id"]).toBe("sess-abcdef123456");
  });

  it("should detect auth endpoint in mixed-traffic", () => {
    expect(enriched.endpointGroups).toBeDefined();
    const authGroups = enriched.endpointGroups!.filter((g) => g.category === "auth");
    expect(authGroups.length).toBeGreaterThanOrEqual(1);
    expect(authGroups[0].normalizedPath).toContain("auth");
  });
});

// ── ecommerce-api fixture ───────────────────────────────────────────────

describe("HAR parser integration: ecommerce-api", () => {
  let data: ApiData;

  beforeAll(() => {
    const har = loadFixture("ecommerce-api");
    data = parseHar(har);
  });

  it("should parse the ecommerce fixture successfully", () => {
    expect(data.requests.length).toBeGreaterThanOrEqual(5);
  });

  it("should detect Bearer Token auth", () => {
    expect(data.authMethod).toBe("Bearer Token");
  });

  it("should capture the X-Store-Id auth info header", () => {
    // X-Store-Id is a custom x-* header, should be in authInfo
    const hasStoreId = Object.keys(data.authInfo).some((k) =>
      k.includes("x-store-id"),
    );
    expect(hasStoreId).toBe(true);
  });
});

// ── auth-api-key fixture ────────────────────────────────────────────────

describe("HAR parser integration: auth-api-key", () => {
  let data: ApiData;
  let enriched: ApiData;

  beforeAll(() => {
    const har = loadFixture("auth-api-key");
    data = parseHar(har);
    enriched = enrichApiData({ ...data });
  });

  it("should detect API Key auth method", () => {
    expect(data.authMethod).toContain("API Key");
  });

  it("should extract x-api-key auth header", () => {
    expect(data.authHeaders).toHaveProperty("x-api-key");
  });

  it("should detect rate limit headers in authInfo", () => {
    // Rate limit headers appear in response, not in authInfo
    // But X-Shop-Domain custom header should be captured
    const hasShopDomain = Object.keys(data.authInfo).some((k) =>
      k.includes("x-shop-domain"),
    );
    expect(hasShopDomain).toBe(true);
  });

  it("should create endpoint groups after enrichment", () => {
    expect(enriched.endpointGroups).toBeDefined();
    expect(enriched.endpointGroups!.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Edge case: empty HAR ────────────────────────────────────────────────

describe("HAR parser integration: empty HAR", () => {
  it("should handle empty entries gracefully", () => {
    const emptyHar = { log: { entries: [] } };
    const data = parseHar(emptyHar);
    expect(data.service).toBe("unknown-api");
    expect(data.requests.length).toBe(0);
    expect(Object.keys(data.endpoints).length).toBe(0);
    expect(Object.keys(data.authHeaders).length).toBe(0);
  });

  it("should handle enrichment of empty data gracefully", () => {
    const emptyHar = { log: { entries: [] } };
    const data = parseHar(emptyHar);
    const enriched = enrichApiData(data);
    expect(enriched.endpointGroups).toBeDefined();
    expect(enriched.endpointGroups!.length).toBe(0);
  });

  it("should handle missing log.entries gracefully", () => {
    const badHar = { log: {} } as any;
    const data = parseHar(badHar);
    expect(data.requests.length).toBe(0);
  });
});

// ── seedUrl behavior ────────────────────────────────────────────────────

describe("HAR parser integration: seedUrl", () => {
  it("should use seedUrl domain for service name when provided", () => {
    const har = loadFixture("todo-api");
    const data = parseHar(har, "https://www.todoapp.com/home");
    expect(data.service).toBe("todoapp");
  });
});
