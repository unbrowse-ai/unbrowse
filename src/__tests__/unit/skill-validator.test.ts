/**
 * Unit tests for skill-validator.ts
 *
 * Tests selectValidationEndpoints() — the pure endpoint selection logic
 * used to pick which endpoints to validate before publishing a skill.
 */

import { describe, it, expect } from "bun:test";
import { selectValidationEndpoints } from "../../skill-validator.js";
import type { EndpointGroup } from "../../types.js";

// ── Test helpers ──────────────────────────────────────────────────────────

interface EndpointGroupOptions {
  method?: string;
  normalizedPath?: string;
  description?: string;
  category?: EndpointGroup["category"];
  pathParams?: { name: string; type: string; example: string }[];
  queryParams?: { name: string; example: string; required: boolean }[];
  requestBodySchema?: Record<string, string>;
  responseBodySchema?: Record<string, string>;
  responseSummary?: string;
  exampleCount?: number;
  verified?: boolean;
  fromSpec?: boolean;
  dependencies?: string[];
  produces?: string[];
  consumes?: string[];
}

/** Build a minimal EndpointGroup for unit tests. */
function makeEndpointGroup(opts: EndpointGroupOptions = {}): EndpointGroup {
  return {
    method: opts.method ?? "GET",
    normalizedPath: opts.normalizedPath ?? "/api/v1/items",
    description: opts.description ?? "List items",
    category: opts.category ?? "read",
    pathParams: opts.pathParams ?? [],
    queryParams: opts.queryParams ?? [],
    requestBodySchema: opts.requestBodySchema,
    responseBodySchema: opts.responseBodySchema,
    responseSummary: opts.responseSummary ?? "array[10]",
    exampleCount: opts.exampleCount ?? 3,
    verified: opts.verified,
    fromSpec: opts.fromSpec,
    dependencies: opts.dependencies ?? [],
    produces: opts.produces ?? [],
    consumes: opts.consumes ?? [],
  };
}

// ── selectValidationEndpoints ─────────────────────────────────────────────

describe("selectValidationEndpoints", () => {
  // ── Basic filtering ─────────────────────────────────────────────────

  it("returns only GET endpoints", () => {
    const groups = [
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/items" }),
      makeEndpointGroup({ method: "POST", normalizedPath: "/api/items", category: "write" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/users" }),
    ];

    const result = selectValidationEndpoints(groups);
    expect(result).toHaveLength(2);
    expect(result.every((ep) => ep.method === "GET")).toBe(true);
  });

  it("returns empty array for empty input", () => {
    const result = selectValidationEndpoints([]);
    expect(result).toEqual([]);
  });

  it("returns empty array for mutation-only endpoints (POST/PUT/DELETE)", () => {
    const groups = [
      makeEndpointGroup({ method: "POST", normalizedPath: "/api/items", category: "write" }),
      makeEndpointGroup({ method: "PUT", normalizedPath: "/api/items/{id}", category: "write" }),
      makeEndpointGroup({ method: "DELETE", normalizedPath: "/api/items/{id}", category: "delete" }),
      makeEndpointGroup({ method: "PATCH", normalizedPath: "/api/items/{id}", category: "write" }),
    ];

    const result = selectValidationEndpoints(groups);
    expect(result).toEqual([]);
  });

  // ── Auth endpoint filtering ─────────────────────────────────────────

  it("skips endpoints with auth category", () => {
    const groups = [
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/auth/token", category: "auth" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/login/status", category: "auth" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/items", category: "read" }),
    ];

    const result = selectValidationEndpoints(groups);
    expect(result).toHaveLength(1);
    expect(result[0].normalizedPath).toBe("/api/items");
  });

  it("skips all endpoints when all are auth category", () => {
    const groups = [
      makeEndpointGroup({ method: "GET", normalizedPath: "/auth/session", category: "auth" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/auth/me", category: "auth" }),
    ];

    const result = selectValidationEndpoints(groups);
    expect(result).toEqual([]);
  });

  // ── Template param handling ─────────────────────────────────────────

  it("skips endpoints with unresolvable template params (no exampleValue)", () => {
    const groups = [
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/users/{userId}",
        pathParams: [{ name: "userId", type: "numeric", example: "" }],
      }),
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/items",
      }),
    ];

    const result = selectValidationEndpoints(groups);
    expect(result).toHaveLength(1);
    expect(result[0].normalizedPath).toBe("/api/items");
  });

  it("includes endpoints with resolvable template params (has exampleValue)", () => {
    const groups = [
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/users/{userId}",
        pathParams: [{ name: "userId", type: "numeric", example: "42" }],
      }),
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/items",
      }),
    ];

    const result = selectValidationEndpoints(groups);
    expect(result).toHaveLength(2);
    const paths = result.map((ep) => ep.normalizedPath);
    expect(paths).toContain("/api/users/{userId}");
    expect(paths).toContain("/api/items");
  });

  it("skips endpoints where some template params lack examples", () => {
    const groups = [
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/users/{userId}/orders/{orderId}",
        pathParams: [
          { name: "userId", type: "numeric", example: "42" },
          { name: "orderId", type: "uuid", example: "" },
        ],
      }),
    ];

    const result = selectValidationEndpoints(groups);
    expect(result).toEqual([]);
  });

  it("includes endpoints where all template params have examples", () => {
    const groups = [
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/users/{userId}/orders/{orderId}",
        pathParams: [
          { name: "userId", type: "numeric", example: "42" },
          { name: "orderId", type: "uuid", example: "abc-123" },
        ],
      }),
    ];

    const result = selectValidationEndpoints(groups);
    expect(result).toHaveLength(1);
  });

  it("includes endpoints with no template params at all", () => {
    const groups = [
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/health",
        pathParams: [],
      }),
    ];

    const result = selectValidationEndpoints(groups);
    expect(result).toHaveLength(1);
  });

  // ── maxEndpoints cap ────────────────────────────────────────────────

  it("respects maxEndpoints cap", () => {
    const groups = Array.from({ length: 10 }, (_, i) =>
      makeEndpointGroup({
        method: "GET",
        normalizedPath: `/api/resource${i}`,
      }),
    );

    const result = selectValidationEndpoints(groups, 3);
    expect(result).toHaveLength(3);
  });

  it("returns all candidates when fewer than maxEndpoints", () => {
    const groups = [
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/items" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/users" }),
    ];

    const result = selectValidationEndpoints(groups, 10);
    expect(result).toHaveLength(2);
  });

  it("defaults maxEndpoints to 5", () => {
    const groups = Array.from({ length: 10 }, (_, i) =>
      makeEndpointGroup({
        method: "GET",
        normalizedPath: `/api/resource${i}`,
      }),
    );

    const result = selectValidationEndpoints(groups);
    expect(result).toHaveLength(5);
  });

  // ── Diversity (path prefix grouping) ────────────────────────────────

  it("returns diverse endpoints from different path prefixes", () => {
    const groups = [
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/users" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/users/active" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/users/inactive" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/orders" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/orders/pending" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/products" }),
    ];

    // maxEndpoints = 3 should pick one from each of the 3 prefix groups
    const result = selectValidationEndpoints(groups, 3);
    expect(result).toHaveLength(3);

    const paths = result.map((ep) => ep.normalizedPath);
    // Should have picked from api/users, api/orders, and api/products groups
    const prefixes = paths.map((p) => {
      const segments = p.split("/").filter(Boolean);
      return segments.slice(0, 2).join("/");
    });
    const uniquePrefixes = new Set(prefixes);
    expect(uniquePrefixes.size).toBe(3);
  });

  it("round-robins through prefix groups to fill maxEndpoints", () => {
    const groups = [
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/users" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/users/active" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/orders" }),
      makeEndpointGroup({ method: "GET", normalizedPath: "/api/orders/recent" }),
    ];

    // maxEndpoints = 4 means it picks 1 from each group in first round,
    // then 1 from each in second round
    const result = selectValidationEndpoints(groups, 4);
    expect(result).toHaveLength(4);
  });

  // ── Combined filtering ──────────────────────────────────────────────

  it("filters correctly with mixed endpoint types", () => {
    const groups = [
      // Should be included: GET, read, no template params
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/items",
        category: "read",
      }),
      // Should be excluded: POST
      makeEndpointGroup({
        method: "POST",
        normalizedPath: "/api/items",
        category: "write",
      }),
      // Should be excluded: auth category
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/auth/token",
        category: "auth",
      }),
      // Should be excluded: unresolvable template param
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/items/{itemId}",
        category: "read",
        pathParams: [{ name: "itemId", type: "numeric", example: "" }],
      }),
      // Should be included: GET with resolvable template param
      makeEndpointGroup({
        method: "GET",
        normalizedPath: "/api/users/{userId}",
        category: "read",
        pathParams: [{ name: "userId", type: "numeric", example: "123" }],
      }),
    ];

    const result = selectValidationEndpoints(groups, 10);
    expect(result).toHaveLength(2);

    const paths = result.map((ep) => ep.normalizedPath);
    expect(paths).toContain("/api/items");
    expect(paths).toContain("/api/users/{userId}");
  });

  it("treats method comparison as case-insensitive", () => {
    const groups = [
      makeEndpointGroup({ method: "get", normalizedPath: "/api/items" }),
      makeEndpointGroup({ method: "Get", normalizedPath: "/api/users" }),
    ];

    // The code does ep.method.toUpperCase() !== "GET", so lowercase "get" should pass
    const result = selectValidationEndpoints(groups);
    expect(result).toHaveLength(2);
  });

  it("preserves the original endpoint group objects in output", () => {
    const original = makeEndpointGroup({
      method: "GET",
      normalizedPath: "/api/items",
      description: "My custom description",
      responseSummary: "array[42]",
      exampleCount: 7,
    });

    const result = selectValidationEndpoints([original]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(original); // Same reference
    expect(result[0].description).toBe("My custom description");
    expect(result[0].responseSummary).toBe("array[42]");
    expect(result[0].exampleCount).toBe(7);
  });
});
