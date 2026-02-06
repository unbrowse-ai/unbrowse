/**
 * Unit tests for endpoint-prober.ts probe generation
 *
 * Tests generateProbes() — the pure function that produces probe suggestions
 * without making any HTTP requests. Covers CRUD completion, sub-resource probes,
 * collection operations, user/account probes, doc probes, version variants,
 * deduplication, maxProbes limiting, and known-endpoint exclusion.
 */

import { describe, it, expect } from "bun:test";
import { generateProbes } from "../../endpoint-prober.js";
import type { ProbeConfig } from "../../endpoint-prober.js";
import type { EndpointGroup } from "../../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Create a minimal EndpointGroup for testing. */
function makeGroup(
  method: string,
  normalizedPath: string,
  overrides: Partial<EndpointGroup> = {},
): EndpointGroup {
  return {
    method,
    normalizedPath,
    description: "",
    category: "read",
    pathParams: [],
    queryParams: [],
    responseSummary: "",
    exampleCount: 1,
    dependencies: [],
    produces: [],
    consumes: [],
    ...overrides,
  };
}

/** Create a default ProbeConfig with no auth (minimal). */
function makeConfig(overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    baseUrl: "https://api.example.com",
    authHeaders: {},
    cookies: {},
    probeForDocs: false,
    aggressive: false,
    ...overrides,
  };
}

/** Extract method+path keys from probes for easy assertions. */
function probeKeys(probes: { method: string; path: string }[]): string[] {
  return probes.map((p) => `${p.method} ${p.path}`);
}

// ── CRUD completion probes ───────────────────────────────────────────────

describe("generateProbes", () => {
  describe("CRUD completion", () => {
    it("suggests POST when only GET /users exists", () => {
      const groups = [makeGroup("GET", "/users")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      expect(keys).toContain("POST /users");
    });

    it("suggests GET when only POST /users exists", () => {
      const groups = [makeGroup("POST", "/users")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /users");
    });

    it("suggests DELETE /users/{usersId} when GET /users exists but DELETE does not", () => {
      const groups = [makeGroup("GET", "/users")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      // Should suggest single-resource operations with {id}
      expect(keys.some((k) => k.startsWith("DELETE /users/"))).toBe(true);
    });

    it("suggests PUT and PATCH for single-resource endpoints", () => {
      const groups = [makeGroup("GET", "/users")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      expect(keys.some((k) => k.startsWith("PUT /users/"))).toBe(true);
      expect(keys.some((k) => k.startsWith("PATCH /users/"))).toBe(true);
    });

    it("does not suggest methods that already exist", () => {
      const groups = [
        makeGroup("GET", "/users"),
        makeGroup("POST", "/users"),
        makeGroup("GET", "/users/{userId}"),
        makeGroup("PUT", "/users/{userId}"),
        makeGroup("PATCH", "/users/{userId}"),
        makeGroup("DELETE", "/users/{userId}"),
      ];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      // None of the above existing endpoints should be suggested
      expect(keys).not.toContain("GET /users");
      expect(keys).not.toContain("POST /users");
      expect(keys).not.toContain("GET /users/{userId}");
      expect(keys).not.toContain("PUT /users/{userId}");
      expect(keys).not.toContain("PATCH /users/{userId}");
      expect(keys).not.toContain("DELETE /users/{userId}");
    });

    it("suggests CRUD probes for multiple resources independently", () => {
      const groups = [
        makeGroup("GET", "/users"),
        makeGroup("GET", "/orders"),
      ];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      expect(keys).toContain("POST /users");
      expect(keys).toContain("POST /orders");
    });
  });

  // ── Sub-resource probes ──────────────────────────────────────────────

  describe("sub-resource probes", () => {
    it("suggests sub-resources for endpoints ending with {id}", () => {
      const groups = [makeGroup("GET", "/users/{userId}")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      // Should suggest common sub-resources
      expect(keys).toContain("GET /users/{userId}/comments");
      expect(keys).toContain("GET /users/{userId}/settings");
      expect(keys).toContain("GET /users/{userId}/activity");
    });

    it("suggests sub-resources like tags, attachments, history", () => {
      const groups = [makeGroup("GET", "/posts/{postId}")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /posts/{postId}/tags");
      expect(keys).toContain("GET /posts/{postId}/attachments");
      expect(keys).toContain("GET /posts/{postId}/history");
    });

    it("does not suggest sub-resources when sub-resources already exist", () => {
      // If there's already a sub-resource under /users/{userId}, skip
      const groups = [
        makeGroup("GET", "/users/{userId}"),
        makeGroup("GET", "/users/{userId}/comments"),
      ];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      // The sub-resource generation skips parents that already have sub-resources
      expect(keys).not.toContain("GET /users/{userId}/settings");
      expect(keys).not.toContain("GET /users/{userId}/tags");
    });

    it("does not suggest sub-resources for collection endpoints (no {id})", () => {
      const groups = [makeGroup("GET", "/users")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      // /users does not end with a param, so no sub-resources
      expect(keys).not.toContain("GET /users/comments");
      // (comments is not the same as /users/{usersId}/comments)
    });
  });

  // ── Collection operation probes ──────────────────────────────────────

  describe("collection operation probes", () => {
    it("suggests search, count, export for GET collection endpoints", () => {
      const groups = [makeGroup("GET", "/users")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /users/search");
      expect(keys).toContain("POST /users/search");
      expect(keys).toContain("GET /users/count");
      expect(keys).toContain("GET /users/export");
    });

    it("suggests bulk and batch POST operations", () => {
      const groups = [makeGroup("GET", "/users")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      expect(keys).toContain("POST /users/bulk");
      expect(keys).toContain("POST /users/batch");
    });

    it("does not suggest collection ops for non-GET endpoints", () => {
      const groups = [makeGroup("POST", "/users")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      // Collection operations are only generated for GET collection endpoints
      expect(keys).not.toContain("GET /users/search");
      expect(keys).not.toContain("GET /users/count");
    });

    it("does not suggest collection ops for single-resource endpoints", () => {
      const groups = [makeGroup("GET", "/users/{userId}")];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      // Endpoints ending with params are excluded from collection ops
      expect(keys).not.toContain("GET /users/{userId}/search");
      expect(keys).not.toContain("GET /users/{userId}/count");
    });
  });

  // ── User/account probes ──────────────────────────────────────────────

  describe("user/account probes", () => {
    it("suggests /me, /profile, /account when auth headers are present", () => {
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig({ authHeaders: { Authorization: "Bearer tok" } });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /me");
      expect(keys).toContain("GET /profile");
      expect(keys).toContain("GET /account");
    });

    it("suggests /me, /profile, /account when cookies are present", () => {
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig({ cookies: { session: "abc123" } });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /me");
      expect(keys).toContain("GET /profile");
      expect(keys).toContain("GET /account");
    });

    it("does not suggest user/account probes when no auth is present", () => {
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig();
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).not.toContain("GET /me");
      expect(keys).not.toContain("GET /profile");
      expect(keys).not.toContain("GET /account");
    });

    it("suggests user/account probes with API prefix", () => {
      const groups = [
        makeGroup("GET", "/api/v1/users"),
        makeGroup("GET", "/api/v1/orders"),
      ];
      const config = makeConfig({ authHeaders: { Authorization: "Bearer tok" } });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      // With /api/v1 prefix, paths should be prefixed
      expect(keys).toContain("GET /api/v1/me");
      expect(keys).toContain("GET /api/v1/profile");
      expect(keys).toContain("GET /api/v1/account");
    });
  });

  // ── API documentation probes ─────────────────────────────────────────

  describe("API documentation probes", () => {
    it("suggests openapi.json, swagger.json, api-docs when probeForDocs is true", () => {
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig({ probeForDocs: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /openapi.json");
      expect(keys).toContain("GET /swagger.json");
      expect(keys).toContain("GET /api-docs");
    });

    it("suggests GraphQL introspection when probeForDocs is true", () => {
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig({ probeForDocs: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).toContain("POST /graphql");
    });

    it("does not suggest doc probes when probeForDocs is false", () => {
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig({ probeForDocs: false });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).not.toContain("GET /openapi.json");
      expect(keys).not.toContain("GET /swagger.json");
      expect(keys).not.toContain("GET /api-docs");
    });

    it("probeForDocs defaults to true when not specified", () => {
      const groups = [makeGroup("GET", "/users")];
      const config: ProbeConfig = {
        baseUrl: "https://api.example.com",
        authHeaders: {},
        cookies: {},
      };
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /openapi.json");
    });

    it("suggests doc probes with API prefix and at root", () => {
      const groups = [
        makeGroup("GET", "/api/v1/users"),
        makeGroup("GET", "/api/v1/orders"),
      ];
      const config = makeConfig({ probeForDocs: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      // With prefix
      expect(keys).toContain("GET /api/v1/openapi.json");
      // At root (without prefix)
      expect(keys).toContain("GET /openapi.json");
    });
  });

  // ── Version variant probes (aggressive mode) ─────────────────────────

  describe("version variant probes (aggressive)", () => {
    it("suggests v2 when v1 endpoints exist", () => {
      const groups = [makeGroup("GET", "/api/v1/users")];
      const config = makeConfig({ aggressive: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /api/v2/users");
    });

    it("suggests v1 and v3 when v2 exists", () => {
      const groups = [makeGroup("GET", "/api/v2/users")];
      const config = makeConfig({ aggressive: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /api/v1/users");
      expect(keys).toContain("GET /api/v3/users");
    });

    it("suggests version injection for unversioned /api paths", () => {
      const groups = [makeGroup("GET", "/api/users")];
      const config = makeConfig({ aggressive: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /api/v1/users");
      expect(keys).toContain("GET /api/v2/users");
    });

    it("does not suggest version probes when not aggressive", () => {
      const groups = [makeGroup("GET", "/api/v1/users")];
      const config = makeConfig({ aggressive: false });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).not.toContain("GET /api/v2/users");
    });

    it("does not suggest v0 (stays above 0)", () => {
      const groups = [makeGroup("GET", "/api/v1/users")];
      const config = makeConfig({ aggressive: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).not.toContain("GET /api/v0/users");
    });
  });

  // ── Utility probes (aggressive mode) ─────────────────────────────────

  describe("utility probes (aggressive)", () => {
    it("suggests /health, /status, /version in aggressive mode", () => {
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig({ aggressive: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /health");
      expect(keys).toContain("GET /status");
      expect(keys).toContain("GET /version");
    });

    it("does not suggest utility probes when not aggressive", () => {
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig({ aggressive: false });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).not.toContain("GET /health");
      expect(keys).not.toContain("GET /status");
      expect(keys).not.toContain("GET /version");
    });

    it("suggests utility probes at both prefix and root", () => {
      const groups = [
        makeGroup("GET", "/api/v1/users"),
        makeGroup("GET", "/api/v1/orders"),
      ];
      const config = makeConfig({ aggressive: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).toContain("GET /api/v1/health");
      expect(keys).toContain("GET /health");
    });
  });

  // ── Deduplication ────────────────────────────────────────────────────

  describe("deduplication", () => {
    it("does not produce duplicate method+path combinations", () => {
      const groups = [
        makeGroup("GET", "/users"),
        makeGroup("GET", "/users"),
      ];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      const uniqueKeys = new Set(keys);
      expect(keys.length).toBe(uniqueKeys.size);
    });

    it("deduplicates across different probe strategies", () => {
      // Both CRUD and collection ops might suggest overlapping things;
      // the dedup pass ensures no duplicates
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig({ aggressive: true, probeForDocs: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      const uniqueKeys = new Set(keys);
      expect(keys.length).toBe(uniqueKeys.size);
    });
  });

  // ── maxProbes limit ──────────────────────────────────────────────────

  describe("maxProbes limit", () => {
    it("respects maxProbes config", () => {
      const groups = [
        makeGroup("GET", "/users"),
        makeGroup("GET", "/orders"),
        makeGroup("GET", "/products"),
        makeGroup("GET", "/teams"),
      ];
      const config = makeConfig({ maxProbes: 5 });
      const probes = generateProbes(groups, config);
      expect(probes.length).toBeLessThanOrEqual(5);
    });

    it("returns all probes when maxProbes is larger than generated count", () => {
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig({ maxProbes: 1000 });
      const probes = generateProbes(groups, config);
      // Should return all generated probes (no truncation)
      expect(probes.length).toBeGreaterThan(0);
    });

    it("returns 0 probes when maxProbes is 0", () => {
      const groups = [makeGroup("GET", "/users")];
      const config = makeConfig({ maxProbes: 0 });
      const probes = generateProbes(groups, config);
      expect(probes.length).toBe(0);
    });

    it("defaults maxProbes to 50 when not specified", () => {
      // Create enough endpoint groups to generate more than 50 probes
      const groups: EndpointGroup[] = [];
      for (let i = 0; i < 30; i++) {
        groups.push(makeGroup("GET", `/resource${i}`));
      }
      const config = makeConfig({ aggressive: true, probeForDocs: true });
      const probes = generateProbes(groups, config);
      expect(probes.length).toBeLessThanOrEqual(50);
    });
  });

  // ── Known endpoint exclusion ─────────────────────────────────────────

  describe("known endpoint exclusion", () => {
    it("does not suggest probes for endpoints that already exist in groups", () => {
      const groups = [
        makeGroup("GET", "/users"),
        makeGroup("POST", "/users"),
        makeGroup("DELETE", "/users/{usersId}"),
      ];
      const probes = generateProbes(groups, makeConfig());
      const keys = probeKeys(probes);
      expect(keys).not.toContain("GET /users");
      expect(keys).not.toContain("POST /users");
      expect(keys).not.toContain("DELETE /users/{usersId}");
    });

    it("excludes known doc paths from doc probes", () => {
      const groups = [
        makeGroup("GET", "/users"),
        makeGroup("GET", "/openapi.json"),
      ];
      const config = makeConfig({ probeForDocs: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).not.toContain("GET /openapi.json");
    });

    it("excludes known utility paths from utility probes", () => {
      const groups = [
        makeGroup("GET", "/users"),
        makeGroup("GET", "/health"),
      ];
      const config = makeConfig({ aggressive: true });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      expect(keys).not.toContain("GET /health");
    });
  });

  // ── Probe structure ──────────────────────────────────────────────────

  describe("probe structure", () => {
    it("each probe has method, path, and reason fields", () => {
      const groups = [makeGroup("GET", "/users")];
      const probes = generateProbes(groups, makeConfig());
      for (const probe of probes) {
        expect(probe).toHaveProperty("method");
        expect(probe).toHaveProperty("path");
        expect(probe).toHaveProperty("reason");
        expect(typeof probe.method).toBe("string");
        expect(typeof probe.path).toBe("string");
        expect(typeof probe.reason).toBe("string");
      }
    });

    it("CRUD probes have descriptive reasons", () => {
      const groups = [makeGroup("GET", "/users")];
      const probes = generateProbes(groups, makeConfig());
      const crudProbes = probes.filter((p) => p.reason.startsWith("CRUD completion"));
      expect(crudProbes.length).toBeGreaterThan(0);
      for (const p of crudProbes) {
        expect(p.reason).toContain("CRUD completion");
      }
    });

    it("returns an empty array when no groups are provided", () => {
      const probes = generateProbes([], makeConfig());
      expect(probes).toEqual([]);
    });
  });

  // ── API prefix detection ─────────────────────────────────────────────

  describe("API prefix detection", () => {
    it("detects /api/v1 prefix from multiple endpoints", () => {
      const groups = [
        makeGroup("GET", "/api/v1/users"),
        makeGroup("GET", "/api/v1/orders"),
        makeGroup("GET", "/api/v1/products"),
      ];
      const config = makeConfig({
        authHeaders: { Authorization: "Bearer tok" },
      });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      // User/account probes should use the detected prefix
      expect(keys).toContain("GET /api/v1/me");
    });

    it("uses empty prefix when no API prefix is common", () => {
      const groups = [
        makeGroup("GET", "/users"),
        makeGroup("GET", "/orders"),
      ];
      const config = makeConfig({
        authHeaders: { Authorization: "Bearer tok" },
      });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);
      // Without a prefix, paths should be at root
      expect(keys).toContain("GET /me");
    });
  });

  // ── Combined scenario ────────────────────────────────────────────────

  describe("combined scenario", () => {
    it("generates a comprehensive set of probes for a typical API", () => {
      const groups = [
        makeGroup("GET", "/api/v1/users"),
        makeGroup("GET", "/api/v1/users/{userId}"),
        makeGroup("POST", "/api/v1/users"),
        makeGroup("GET", "/api/v1/orders"),
        makeGroup("GET", "/api/v1/orders/{orderId}"),
      ];
      const config = makeConfig({
        authHeaders: { Authorization: "Bearer tok" },
        probeForDocs: true,
        aggressive: true,
        maxProbes: 500, // raise limit so all strategies are represented
      });
      const probes = generateProbes(groups, config);
      const keys = probeKeys(probes);

      // Should have CRUD completion probes
      expect(keys.some((k) => k.includes("DELETE"))).toBe(true);
      expect(keys.some((k) => k.includes("PUT") || k.includes("PATCH"))).toBe(true);

      // Should have sub-resource probes (for endpoints ending with {id})
      expect(keys.some((k) => k.includes("{userId}/"))).toBe(true);
      expect(keys.some((k) => k.includes("{orderId}/"))).toBe(true);

      // Should have collection operation probes
      expect(keys.some((k) => k.includes("/search"))).toBe(true);

      // Should have user/account probes (auth present)
      expect(keys.some((k) => k.includes("/me"))).toBe(true);

      // Should have doc probes
      expect(keys.some((k) => k.includes("openapi") || k.includes("swagger"))).toBe(true);

      // Should have version probes (aggressive)
      expect(keys.some((k) => k.includes("/v2/"))).toBe(true);

      // All probes should be unique
      const uniqueKeys = new Set(keys);
      expect(keys.length).toBe(uniqueKeys.size);
    });
  });
});
