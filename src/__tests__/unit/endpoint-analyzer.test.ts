/**
 * Unit tests for endpoint-analyzer.ts
 *
 * Tests analyzeEndpoints() — endpoint categorization, description generation,
 * normalized path grouping, producer/consumer detection, dependency building,
 * sorting, and edge cases.
 */

import { describe, it, expect } from "bun:test";
import { analyzeEndpoints } from "../../endpoint-analyzer.js";
import { parseHar, enrichApiData } from "../../har-parser.js";
import type { ParsedRequest, EndpointGroup } from "../../types.js";
import { readFileSync } from "fs";
import { join } from "path";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a minimal ParsedRequest for testing. */
function makeRequest(overrides: Partial<ParsedRequest> & { method: string; path: string }): ParsedRequest {
  const normalizedPath = overrides.normalizedPath ?? overrides.path;
  return {
    url: `https://api.example.com${overrides.path}`,
    domain: "api.example.com",
    status: 200,
    ...overrides,
    normalizedPath,
  };
}

/** Find a group by method + normalizedPath. */
function findGroup(groups: EndpointGroup[], method: string, path: string): EndpointGroup | undefined {
  return groups.find((g) => g.method === method && g.normalizedPath === path);
}

// ── Categorization ─────────────────────────────────────────────────────────

describe("analyzeEndpoints", () => {
  describe("categorization", () => {
    it("categorizes GET requests as 'read'", () => {
      const requests = [makeRequest({ method: "GET", path: "/users" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("read");
    });

    it("categorizes HEAD requests as 'read'", () => {
      const requests = [makeRequest({ method: "HEAD", path: "/users" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("read");
    });

    it("categorizes OPTIONS requests as 'read'", () => {
      const requests = [makeRequest({ method: "OPTIONS", path: "/users" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("read");
    });

    it("categorizes POST requests as 'write'", () => {
      const requests = [makeRequest({ method: "POST", path: "/users" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("write");
    });

    it("categorizes PUT requests as 'write'", () => {
      const requests = [makeRequest({ method: "PUT", path: "/users/{userId}" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("write");
    });

    it("categorizes PATCH requests as 'write'", () => {
      const requests = [makeRequest({ method: "PATCH", path: "/users/{userId}" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("write");
    });

    it("categorizes DELETE requests as 'delete'", () => {
      const requests = [makeRequest({ method: "DELETE", path: "/users/{userId}" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("delete");
    });

    it("categorizes auth endpoints with /login as 'auth'", () => {
      const requests = [makeRequest({ method: "POST", path: "/auth/login" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("auth");
    });

    it("categorizes auth endpoints with /token as 'auth'", () => {
      const requests = [makeRequest({ method: "POST", path: "/oauth/token" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("auth");
    });

    it("categorizes auth endpoints with /register as 'auth'", () => {
      const requests = [makeRequest({ method: "POST", path: "/auth/register" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("auth");
    });

    it("categorizes auth endpoints with /signin as 'auth'", () => {
      const requests = [makeRequest({ method: "POST", path: "/signin" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("auth");
    });

    it("categorizes auth endpoints with /signup as 'auth'", () => {
      const requests = [makeRequest({ method: "POST", path: "/signup" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("auth");
    });

    it("categorizes auth endpoints with /session as 'auth'", () => {
      const requests = [makeRequest({ method: "POST", path: "/api/session" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("auth");
    });

    it("categorizes auth endpoints with /refresh as 'auth'", () => {
      const requests = [makeRequest({ method: "POST", path: "/auth/refresh" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("auth");
    });

    it("auth detection is case-insensitive", () => {
      const requests = [makeRequest({ method: "POST", path: "/AUTH/LOGIN" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("auth");
    });

    it("auth takes priority over write for POST to auth path", () => {
      const requests = [makeRequest({ method: "POST", path: "/api/v1/auth/login" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("auth");
    });
  });

  // ── Description generation ─────────────────────────────────────────────

  describe("description generation", () => {
    it("generates 'List users' for GET /users", () => {
      const requests = [makeRequest({ method: "GET", path: "/users" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("List users");
    });

    it("generates 'Get a user by ID' for GET /users/{userId}", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users/123",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "123", type: "numeric" }],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("Get a user by ID");
    });

    it("generates 'Create a user' for POST /users", () => {
      const requests = [makeRequest({ method: "POST", path: "/users" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("Create a user");
    });

    it("generates 'Update a user' for PUT /users/{userId}", () => {
      const requests = [
        makeRequest({
          method: "PUT",
          path: "/users/123",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "123", type: "numeric" }],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("Update a user");
    });

    it("generates 'Partially update a user' for PATCH /users/{userId}", () => {
      const requests = [
        makeRequest({
          method: "PATCH",
          path: "/users/123",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "123", type: "numeric" }],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("Partially update a user");
    });

    it("generates 'Delete a user' for DELETE /users/{userId}", () => {
      const requests = [
        makeRequest({
          method: "DELETE",
          path: "/users/123",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "123", type: "numeric" }],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("Delete a user");
    });

    it("generates parent phrase for nested resources: 'List orders for a user'", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users/42/orders",
          normalizedPath: "/users/{userId}/orders",
          pathParams: [{ name: "userId", position: 2, exampleValue: "42", type: "numeric" }],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("List orders for a user");
    });

    it("generates 'Create a order for a user' for POST /users/{userId}/orders", () => {
      const requests = [
        makeRequest({
          method: "POST",
          path: "/users/42/orders",
          normalizedPath: "/users/{userId}/orders",
          pathParams: [{ name: "userId", position: 2, exampleValue: "42", type: "numeric" }],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("Create a order for a user");
    });

    it("strips /api/v1 noise from description", () => {
      const requests = [makeRequest({ method: "GET", path: "/api/v1/users", normalizedPath: "/api/v1/users" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("List users");
    });

    it("generates 'Authenticate' for POST /auth/login", () => {
      const requests = [makeRequest({ method: "POST", path: "/auth/login" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("Authenticate");
    });

    it("generates 'Refresh auth token' for POST /auth/refresh", () => {
      const requests = [makeRequest({ method: "POST", path: "/auth/refresh" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("Refresh auth token");
    });

    it("generates 'Register a new account' for POST /auth/register", () => {
      const requests = [makeRequest({ method: "POST", path: "/auth/register" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("Register a new account");
    });

    it("generates 'Register a new account' for POST /signup", () => {
      const requests = [makeRequest({ method: "POST", path: "/signup" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("Register a new account");
    });

    it("handles root path description", () => {
      const requests = [makeRequest({ method: "GET", path: "/" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("GET root");
    });

    it("singularizes -ies plural for description", () => {
      const requests = [makeRequest({ method: "GET", path: "/categories" })];
      const groups = analyzeEndpoints(requests, {});
      // "categories" -> singularize -> "category"
      expect(groups[0].description).toBe("List categories");
    });

    it("handles camelCase segments in descriptions", () => {
      const requests = [makeRequest({ method: "GET", path: "/userProfiles" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].description).toBe("List user profiles");
    });
  });

  // ── Normalized path grouping ───────────────────────────────────────────

  describe("normalized path grouping", () => {
    it("groups requests with different IDs into one endpoint", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users/123",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "123", type: "numeric" }],
        }),
        makeRequest({
          method: "GET",
          path: "/users/456",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "456", type: "numeric" }],
        }),
        makeRequest({
          method: "GET",
          path: "/users/789",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "789", type: "numeric" }],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups).toHaveLength(1);
      expect(groups[0].method).toBe("GET");
      expect(groups[0].normalizedPath).toBe("/users/{userId}");
      expect(groups[0].exampleCount).toBe(3);
    });

    it("keeps different methods on the same path as separate groups", () => {
      const requests = [
        makeRequest({ method: "GET", path: "/users" }),
        makeRequest({ method: "POST", path: "/users", requestBody: { name: "Alice" } }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups).toHaveLength(2);
      const methods = groups.map((g) => g.method).sort();
      expect(methods).toEqual(["GET", "POST"]);
    });

    it("keeps different paths as separate groups", () => {
      const requests = [
        makeRequest({ method: "GET", path: "/users" }),
        makeRequest({ method: "GET", path: "/orders" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups).toHaveLength(2);
    });

    it("falls back to path when normalizedPath is not set", () => {
      const req: ParsedRequest = {
        method: "GET",
        url: "https://api.example.com/items",
        path: "/items",
        domain: "api.example.com",
        status: 200,
        // normalizedPath intentionally omitted
      };
      const groups = analyzeEndpoints([req], {});
      expect(groups).toHaveLength(1);
      expect(groups[0].normalizedPath).toBe("/items");
    });
  });

  // ── Path params ──────────────────────────────────────────────────────────

  describe("path params", () => {
    it("merges path params from multiple request examples", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users/123",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "123", type: "numeric" }],
        }),
        makeRequest({
          method: "GET",
          path: "/users/456",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "456", type: "numeric" }],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      // Should have one pathParam (deduplicated by name)
      expect(groups[0].pathParams).toHaveLength(1);
      expect(groups[0].pathParams[0].name).toBe("userId");
      expect(groups[0].pathParams[0].type).toBe("numeric");
      // Uses the first example value seen
      expect(groups[0].pathParams[0].example).toBe("123");
    });

    it("collects multiple path params for nested routes", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users/1/orders/99",
          normalizedPath: "/users/{userId}/orders/{orderId}",
          pathParams: [
            { name: "userId", position: 2, exampleValue: "1", type: "numeric" },
            { name: "orderId", position: 4, exampleValue: "99", type: "numeric" },
          ],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].pathParams).toHaveLength(2);
      expect(groups[0].pathParams[0].name).toBe("userId");
      expect(groups[0].pathParams[1].name).toBe("orderId");
    });
  });

  // ── Query params ──────────────────────────────────────────────────────────

  describe("query params", () => {
    it("collects query params from requests", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users",
          queryParams: [
            { name: "page", value: "1" },
            { name: "limit", value: "20" },
          ],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].queryParams).toHaveLength(2);
      const names = groups[0].queryParams.map((q) => q.name);
      expect(names).toContain("page");
      expect(names).toContain("limit");
    });

    it("marks query params appearing in >80% of requests as required", () => {
      // 5 requests, "page" appears in all 5 (100%), "filter" appears in 2 (40%)
      const requests = Array.from({ length: 5 }, (_, i) => {
        const qp = [{ name: "page", value: String(i + 1) }];
        if (i < 2) qp.push({ name: "filter", value: "active" });
        return makeRequest({ method: "GET", path: "/users", queryParams: qp });
      });
      const groups = analyzeEndpoints(requests, {});
      const pageParam = groups[0].queryParams.find((q) => q.name === "page");
      const filterParam = groups[0].queryParams.find((q) => q.name === "filter");
      expect(pageParam?.required).toBe(true);
      expect(filterParam?.required).toBe(false);
    });

    it("uses first example value for each query param", () => {
      const requests = [
        makeRequest({ method: "GET", path: "/users", queryParams: [{ name: "page", value: "1" }] }),
        makeRequest({ method: "GET", path: "/users", queryParams: [{ name: "page", value: "2" }] }),
      ];
      const groups = analyzeEndpoints(requests, {});
      const pageParam = groups[0].queryParams.find((q) => q.name === "page");
      expect(pageParam?.example).toBe("1");
    });
  });

  // ── Request/Response body schemas ──────────────────────────────────────

  describe("body schemas", () => {
    it("infers request body schema from POST requests", () => {
      const requests = [
        makeRequest({
          method: "POST",
          path: "/users",
          requestBody: { name: "Alice", email: "alice@example.com" },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].requestBodySchema).toBeDefined();
      expect(groups[0].requestBodySchema!["name"]).toBe("string");
      expect(groups[0].requestBodySchema!["email"]).toBe("string");
    });

    it("infers response body schema", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users",
          responseBody: { id: 1, name: "Alice", active: true },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].responseBodySchema).toBeDefined();
      expect(groups[0].responseBodySchema!["id"]).toBe("number");
      expect(groups[0].responseBodySchema!["name"]).toBe("string");
      expect(groups[0].responseBodySchema!["active"]).toBe("boolean");
    });

    it("merges schemas from multiple request examples", () => {
      const requests = [
        makeRequest({
          method: "POST",
          path: "/users",
          requestBody: { name: "Alice" },
        }),
        makeRequest({
          method: "POST",
          path: "/users",
          requestBody: { name: "Bob", email: "bob@example.com" },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].requestBodySchema).toBeDefined();
      expect(groups[0].requestBodySchema!["name"]).toBe("string");
      expect(groups[0].requestBodySchema!["email"]).toBe("string");
    });

    it("leaves requestBodySchema undefined when no body exists", () => {
      const requests = [makeRequest({ method: "GET", path: "/users" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].requestBodySchema).toBeUndefined();
    });

    it("leaves responseBodySchema undefined when no response body exists", () => {
      const requests = [makeRequest({ method: "DELETE", path: "/users/{userId}" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].responseBodySchema).toBeUndefined();
    });
  });

  // ── Producer detection ────────────────────────────────────────────────────

  describe("producer detection", () => {
    it("detects 'id' as a produced field", () => {
      const requests = [
        makeRequest({
          method: "POST",
          path: "/users",
          responseBody: { id: 42, name: "Alice" },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].produces).toContain("id");
    });

    it("detects fields ending with 'Id' as produced fields", () => {
      const requests = [
        makeRequest({
          method: "POST",
          path: "/orders",
          responseBody: { orderId: "o-123", userId: 42, status: "created" },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].produces).toContain("orderId");
      expect(groups[0].produces).toContain("userId");
    });

    it("detects token fields as produced", () => {
      const requests = [
        makeRequest({
          method: "POST",
          path: "/auth/login",
          responseBody: { accessToken: "abc", refreshToken: "def" },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].produces).toContain("accessToken");
      expect(groups[0].produces).toContain("refreshToken");
    });

    it("detects uuid and key fields as produced", () => {
      const requests = [
        makeRequest({
          method: "POST",
          path: "/api-keys",
          responseBody: { uuid: "abc-123", apiKey: "key-456" },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].produces).toContain("uuid");
      expect(groups[0].produces).toContain("apiKey");
    });

    it("does not mark non-ID fields as produced", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users",
          responseBody: { name: "Alice", email: "a@b.com", status: "active" },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].produces).not.toContain("name");
      expect(groups[0].produces).not.toContain("email");
      expect(groups[0].produces).not.toContain("status");
    });

    it("returns empty produces when no response body", () => {
      const requests = [makeRequest({ method: "DELETE", path: "/users/{userId}" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].produces).toEqual([]);
    });
  });

  // ── Consumer detection ────────────────────────────────────────────────────

  describe("consumer detection", () => {
    it("detects path params as consumed fields", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users/123",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "123", type: "numeric" }],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].consumes).toContain("userId");
    });

    it("detects ID-like query params as consumed", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/orders",
          queryParams: [
            { name: "userId", value: "42" },
            { name: "page", value: "1" },
          ],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].consumes).toContain("userId");
      // "page" is not an ID-like field
      expect(groups[0].consumes).not.toContain("page");
    });

    it("detects ID-like request body fields as consumed", () => {
      const requests = [
        makeRequest({
          method: "POST",
          path: "/orders",
          requestBody: { userId: 42, productId: 7, quantity: 2 },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].consumes).toContain("userId");
      expect(groups[0].consumes).toContain("productId");
      expect(groups[0].consumes).not.toContain("quantity");
    });

    it("deduplicates consumed fields", () => {
      const requests = [
        makeRequest({
          method: "POST",
          path: "/users/42/orders",
          normalizedPath: "/users/{userId}/orders",
          pathParams: [{ name: "userId", position: 2, exampleValue: "42", type: "numeric" }],
          requestBody: { userId: 42, title: "New order" },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      // userId appears both as path param and in body; should be deduplicated
      const userIdCount = groups[0].consumes.filter((c) => c === "userId").length;
      expect(userIdCount).toBe(1);
    });

    it("returns empty consumes when no params or body", () => {
      const requests = [makeRequest({ method: "GET", path: "/health" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].consumes).toEqual([]);
    });
  });

  // ── Dependency building ───────────────────────────────────────────────────

  describe("dependency building", () => {
    it("auth endpoints have no dependencies", () => {
      const requests = [
        makeRequest({ method: "POST", path: "/auth/login" }),
        makeRequest({ method: "GET", path: "/users" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      const authGroup = findGroup(groups, "POST", "/auth/login");
      expect(authGroup?.dependencies).toEqual([]);
    });

    it("non-auth endpoints depend on auth endpoints", () => {
      const requests = [
        makeRequest({ method: "POST", path: "/auth/login" }),
        makeRequest({ method: "GET", path: "/users" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      const usersGroup = findGroup(groups, "GET", "/users");
      expect(usersGroup?.dependencies).toContain("POST /auth/login");
    });

    it("non-auth endpoints depend on all auth endpoints", () => {
      const requests = [
        makeRequest({ method: "POST", path: "/auth/login" }),
        makeRequest({ method: "POST", path: "/auth/refresh" }),
        makeRequest({ method: "GET", path: "/users" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      const usersGroup = findGroup(groups, "GET", "/users");
      expect(usersGroup?.dependencies).toContain("POST /auth/login");
      expect(usersGroup?.dependencies).toContain("POST /auth/refresh");
    });

    it("consumers depend on producers of the IDs they consume", () => {
      const requests = [
        makeRequest({
          method: "POST",
          path: "/users",
          responseBody: { id: 1, name: "Alice" },
        }),
        makeRequest({
          method: "GET",
          path: "/users/1",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "1", type: "numeric" }],
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      const getUser = findGroup(groups, "GET", "/users/{userId}");
      // GET /users/{userId} consumes "userId"; POST /users produces "id"
      // The dependency detection checks if consumed field includes produced field name
      expect(getUser?.dependencies).toContain("POST /users");
    });

    it("does not create self-dependencies", () => {
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users/1",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "1", type: "numeric" }],
          responseBody: { id: 1, userId: 1 },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      const getUser = findGroup(groups, "GET", "/users/{userId}");
      // Should not list itself as a dependency
      expect(getUser?.dependencies).not.toContain("GET /users/{userId}");
    });
  });

  // ── Sorting ─────────────────────────────────────────────────────────────

  describe("sorting", () => {
    it("sorts auth endpoints first", () => {
      const requests = [
        makeRequest({ method: "GET", path: "/users" }),
        makeRequest({ method: "POST", path: "/auth/login" }),
        makeRequest({ method: "DELETE", path: "/users/{userId}" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].category).toBe("auth");
    });

    it("sorts by dependency count (fewer deps first)", () => {
      // POST /users produces id, no auth present so no auth deps
      // GET /users/{userId} consumes userId, depends on POST /users
      const requests = [
        makeRequest({
          method: "GET",
          path: "/users/1",
          normalizedPath: "/users/{userId}",
          pathParams: [{ name: "userId", position: 2, exampleValue: "1", type: "numeric" }],
        }),
        makeRequest({
          method: "POST",
          path: "/users",
          responseBody: { id: 1 },
        }),
      ];
      const groups = analyzeEndpoints(requests, {});
      // POST /users should come before GET /users/{userId} (fewer deps)
      const postIndex = groups.findIndex((g) => g.method === "POST");
      const getIndex = groups.findIndex((g) => g.method === "GET");
      expect(postIndex).toBeLessThan(getIndex);
    });

    it("sorts reads before writes before deletes at same dependency count", () => {
      const requests = [
        makeRequest({ method: "DELETE", path: "/items/{itemId}" }),
        makeRequest({ method: "POST", path: "/items" }),
        makeRequest({ method: "GET", path: "/items" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      const categories = groups.map((g) => g.category);
      expect(categories).toEqual(["read", "write", "delete"]);
    });

    it("alphabetical tie-break for same category and dependency count", () => {
      const requests = [
        makeRequest({ method: "GET", path: "/zebras" }),
        makeRequest({ method: "GET", path: "/alpacas" }),
        makeRequest({ method: "GET", path: "/monkeys" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      const paths = groups.map((g) => g.normalizedPath);
      expect(paths).toEqual(["/alpacas", "/monkeys", "/zebras"]);
    });
  });

  // ── Response summary and flags ──────────────────────────────────────────

  describe("response summary and flags", () => {
    it("captures responseSummary from the first request with one", () => {
      const requests = [
        makeRequest({ method: "GET", path: "/users", responseSummary: "array[2]<object{id,name}>" }),
        makeRequest({ method: "GET", path: "/users" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].responseSummary).toBe("array[2]<object{id,name}>");
    });

    it("sets verified flag when any request is verified", () => {
      const requests = [
        makeRequest({ method: "GET", path: "/users", verified: false }),
        makeRequest({ method: "GET", path: "/users", verified: true }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].verified).toBe(true);
    });

    it("leaves verified undefined when no request is verified", () => {
      const requests = [
        makeRequest({ method: "GET", path: "/users" }),
        makeRequest({ method: "GET", path: "/users" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].verified).toBeUndefined();
    });

    it("sets fromSpec flag when any request has fromSpec", () => {
      const requests = [
        makeRequest({ method: "GET", path: "/users", fromSpec: true }),
        makeRequest({ method: "GET", path: "/users" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].fromSpec).toBe(true);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty requests array", () => {
      const groups = analyzeEndpoints([], {});
      expect(groups).toEqual([]);
    });

    it("handles single request", () => {
      const requests = [makeRequest({ method: "GET", path: "/health" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups).toHaveLength(1);
      expect(groups[0].exampleCount).toBe(1);
    });

    it("handles all requests with the same method", () => {
      const requests = [
        makeRequest({ method: "GET", path: "/users" }),
        makeRequest({ method: "GET", path: "/orders" }),
        makeRequest({ method: "GET", path: "/products" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups).toHaveLength(3);
      expect(groups.every((g) => g.category === "read")).toBe(true);
    });

    it("handles method case insensitivity (groups uppercase)", () => {
      const requests = [
        makeRequest({ method: "get", path: "/users" }),
        makeRequest({ method: "GET", path: "/users" }),
      ];
      const groups = analyzeEndpoints(requests, {});
      expect(groups).toHaveLength(1);
      expect(groups[0].method).toBe("GET");
      expect(groups[0].exampleCount).toBe(2);
    });

    it("handles requests with no queryParams, pathParams, or bodies", () => {
      const requests = [makeRequest({ method: "GET", path: "/health" })];
      const groups = analyzeEndpoints(requests, {});
      expect(groups[0].pathParams).toEqual([]);
      expect(groups[0].queryParams).toEqual([]);
      expect(groups[0].requestBodySchema).toBeUndefined();
      expect(groups[0].produces).toEqual([]);
      expect(groups[0].consumes).toEqual([]);
    });
  });

  // ── Integration with HAR fixture ──────────────────────────────────────

  describe("integration with todo-api.har.json", () => {
    const fixturePath = join(import.meta.dir, "..", "fixtures", "todo-api.har.json");
    const harJson = JSON.parse(readFileSync(fixturePath, "utf-8"));
    const apiData = enrichApiData(parseHar(harJson));
    const groups = apiData.endpointGroups!;

    it("produces endpointGroups from the HAR file", () => {
      expect(groups).toBeDefined();
      expect(groups.length).toBeGreaterThan(0);
    });

    it("groups endpoints by normalized path and method", () => {
      // The fixture has GET /api/v1/todos and GET /api/v1/todos/t-1001
      // (t-1001 is not normalized to a param because it's a short slug)
      const listTodos = findGroup(groups, "GET", "/api/v1/todos");
      expect(listTodos).toBeDefined();
      // Different paths should be separate groups
      const paths = groups.map((g) => `${g.method} ${g.normalizedPath}`);
      expect(new Set(paths).size).toBe(paths.length);
    });

    it("categorizes POST /api/v1/todos as write", () => {
      const createTodo = findGroup(groups, "POST", "/api/v1/todos");
      expect(createTodo).toBeDefined();
      expect(createTodo!.category).toBe("write");
    });

    it("categorizes DELETE endpoints as delete", () => {
      // The fixture has DELETE /api/v1/todos/t-1002 (not normalized since t-1002 is short)
      const deleteGroup = groups.find((g) => g.category === "delete");
      expect(deleteGroup).toBeDefined();
      expect(deleteGroup!.method).toBe("DELETE");
    });

    it("detects produced id fields in POST response", () => {
      const createTodo = findGroup(groups, "POST", "/api/v1/todos");
      expect(createTodo).toBeDefined();
      expect(createTodo!.produces).toContain("id");
    });

    it("detects consumed path params from user endpoints", () => {
      // /api/v1/users/42 normalizes to /api/v1/users/{userId}
      const getUser = findGroup(groups, "GET", "/api/v1/users/{userId}");
      expect(getUser).toBeDefined();
      expect(getUser!.consumes).toContain("userId");
    });

    it("captures query params from list endpoint", () => {
      const listTodos = findGroup(groups, "GET", "/api/v1/todos");
      expect(listTodos).toBeDefined();
      expect(listTodos!.queryParams.length).toBeGreaterThan(0);
      const paramNames = listTodos!.queryParams.map((q) => q.name);
      expect(paramNames).toContain("page");
      expect(paramNames).toContain("limit");
    });

    it("generates a description for user todo listing", () => {
      // /api/v1/users/42/todos normalizes to /api/v1/users/{userId}/todos
      const userTodos = findGroup(groups, "GET", "/api/v1/users/{userId}/todos");
      expect(userTodos).toBeDefined();
      expect(userTodos!.description).toBe("List todos for a user");
    });

    it("generates response body schema for list endpoint", () => {
      const listTodos = findGroup(groups, "GET", "/api/v1/todos");
      expect(listTodos).toBeDefined();
      expect(listTodos!.responseBodySchema).toBeDefined();
    });

    it("all groups have dependencies array (may be empty)", () => {
      for (const group of groups) {
        expect(Array.isArray(group.dependencies)).toBe(true);
      }
    });
  });
});
