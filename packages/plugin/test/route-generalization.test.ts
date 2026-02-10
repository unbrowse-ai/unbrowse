/**
 * Route Generalization Tests
 *
 * Tests single-request route normalization (pattern-based) and cross-request
 * route generalization (comparing multiple requests to detect variable segments).
 *
 * Static segments (api, v1, search, me, etc.) must never be parameterized.
 * Single-instance paths should not over-generalize pure-letter segments.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  HarParser,
  RouteNormalizer,
  enrichApiData,
} from "../src/har-parser.js";
import type { HarEntry, ParsedRequest, ApiData } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers — build mock HAR entries for testing
// ---------------------------------------------------------------------------

function makeHarEntry(method: string, url: string, status = 200): HarEntry {
  return {
    request: {
      method,
      url,
      headers: [
        { name: "content-type", value: "application/json" },
      ],
      queryString: [],
      cookies: [],
    },
    response: {
      status,
      headers: [{ name: "content-type", value: "application/json" }],
      content: {
        size: 10,
        mimeType: "application/json",
        text: "{}",
      },
    },
  };
}

function makeHar(entries: HarEntry[]) {
  return { log: { version: "1.2", creator: { name: "test", version: "1.0" }, entries } };
}

// ---------------------------------------------------------------------------
// Test 1: RouteNormalizer unit tests — single-request pattern detection
// ---------------------------------------------------------------------------

describe("RouteNormalizer: single-request pattern detection", () => {
  const normalizer = new RouteNormalizer();

  it("numeric IDs are parameterized", () => {
    const result = normalizer.normalizePath("/users/123");
    expect(result.normalizedPath).toBe("/users/{userId}");
    expect(result.pathParams).toHaveLength(1);
    expect(result.pathParams[0].type).toBe("integer");
  });

  it("UUIDs are parameterized with context-aware naming", () => {
    const result = normalizer.normalizePath("/items/a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(result.normalizedPath).toBe("/items/{itemId}");
    expect(result.pathParams).toHaveLength(1);
    expect(result.pathParams[0].type).toBe("uuid");
  });

  it("hex IDs (8+ chars) are parameterized", () => {
    const result = normalizer.normalizePath("/commits/abc123def0");
    expect(result.normalizedPath).toMatch(/\/commits\/\{[^}]+\}/);
    expect(result.pathParams).toHaveLength(1);
    expect(result.pathParams[0].type).toBe("hex");
  });

  it("timestamps (10-13 digits) are parameterized", () => {
    const result = normalizer.normalizePath("/events/1706745600000");
    expect(result.normalizedPath).toBe("/events/{timestamp}");
    expect(result.pathParams).toHaveLength(1);
    expect(result.pathParams[0].type).toBe("timestamp");
  });

  it("email addresses are parameterized", () => {
    const result = normalizer.normalizePath("/users/test@example.com");
    expect(result.normalizedPath).toBe("/users/{email}");
    expect(result.pathParams).toHaveLength(1);
    expect(result.pathParams[0].type).toBe("email");
  });

  it("mixed alphanumeric segments (letters + digits) are parameterized", () => {
    const result = normalizer.normalizePath("/modules/CS2030S");
    expect(result.normalizedPath).toMatch(/\/modules\/\{[^}]+\}/);
    expect(result.pathParams).toHaveLength(1);
    expect(result.pathParams[0].type).toBe("string");
  });

  it("academic year ranges are parameterized", () => {
    const result = normalizer.normalizePath("/v2/2024-2025/modules/CS2030S");
    expect(result.normalizedPath).toMatch(/\/v2\/\{[^}]+\}\/modules\/\{[^}]+\}/);
    expect(result.pathParams).toHaveLength(2);
  });

  it("file extensions are preserved in output", () => {
    const result = normalizer.normalizePath("/v2/2024-2025/modules/CS2030S.json");
    expect(result.normalizedPath).toContain(".json");
    // The parameterized segment should end with .json
    expect(result.normalizedPath).toMatch(/\{[^}]+\}\.json$/);
  });

  it("short non-ID strings are kept literal", () => {
    const result = normalizer.normalizePath("/api/v1/users/me");
    expect(result.normalizedPath).toBe("/api/v1/users/me");
    expect(result.pathParams).toHaveLength(0);
  });

  it("version prefixes are kept literal", () => {
    const result = normalizer.normalizePath("/v2/modules/something");
    expect(result.normalizedPath).toContain("/v2/");
  });

  it("pure-letter segments like repo names are NOT parameterized", () => {
    const result = normalizer.normalizePath("/repos/torvalds/linux");
    // "torvalds" and "linux" are pure letters — not detected as IDs
    expect(result.normalizedPath).toBe("/repos/torvalds/linux");
    expect(result.pathParams).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: NUSMods — pattern-detected parameterization
// ---------------------------------------------------------------------------

describe("NUSMods: module codes parameterized via pattern detection", () => {
  const parser = new HarParser();

  it("CS2030S, CS1101S, MA2001 all normalize to same path (mixedAlphaNum pattern)", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://api.nusmods.com/v2/2024-2025/modules/CS2030S.json"),
      makeHarEntry("GET", "https://api.nusmods.com/v2/2024-2025/modules/CS1101S.json"),
      makeHarEntry("GET", "https://api.nusmods.com/v2/2024-2025/modules/MA2001.json"),
    ]);

    const apiData = parser.parse(har, "https://api.nusmods.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    // All three requests should normalize to same path via pattern detection
    const moduleGroups = groups.filter(g =>
      g.normalizedPath.includes("modules") && g.method === "GET"
    );
    expect(moduleGroups.length).toBe(1);

    const group = moduleGroups[0];
    // Module code should be parameterized (mixedAlphaNum)
    expect(group.normalizedPath).not.toContain("CS2030S");
    expect(group.normalizedPath).not.toContain("CS1101S");
    expect(group.normalizedPath).not.toContain("MA2001");
    // Year range should also be parameterized
    expect(group.normalizedPath).not.toContain("2024-2025");
    // File extension should be preserved
    expect(group.normalizedPath).toContain(".json");
    expect(group.exampleCount).toBe(3);
  });

  it("different year ranges normalize to same path", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://api.nusmods.com/v2/2024-2025/modules/CS2030S.json"),
      makeHarEntry("GET", "https://api.nusmods.com/v2/2023-2024/modules/CS2030S.json"),
    ]);

    const apiData = parser.parse(har, "https://api.nusmods.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    const moduleGroups = groups.filter(g =>
      g.normalizedPath.includes("modules") && g.method === "GET"
    );
    // Both year ranges should normalize to the same path
    expect(moduleGroups.length).toBe(1);
    expect(moduleGroups[0].exampleCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 3: HackerNews — numeric IDs parameterized
// ---------------------------------------------------------------------------

describe("HackerNews: numeric item IDs parameterized", () => {
  const parser = new HarParser();

  it("item/1.json + item/42.json -> item/{itemId}.json", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://hacker-news.firebaseio.com/v0/item/1.json"),
      makeHarEntry("GET", "https://hacker-news.firebaseio.com/v0/item/42.json"),
      makeHarEntry("GET", "https://hacker-news.firebaseio.com/v0/item/100.json"),
    ]);

    const apiData = parser.parse(har, "https://hacker-news.firebaseio.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    const itemGroups = groups.filter(g =>
      g.normalizedPath.includes("item") && g.method === "GET"
    );
    expect(itemGroups.length).toBe(1);

    const group = itemGroups[0];
    // Numeric IDs detected by single-request pattern
    expect(group.normalizedPath).toMatch(/\/item\/\{[^}]+\}\.json/);
    expect(group.normalizedPath).not.toContain("/1.");
    expect(group.normalizedPath).not.toContain("/42.");
    expect(group.exampleCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 4: GitHub — pure-letter segments need cross-request generalization
// ---------------------------------------------------------------------------

describe("GitHub: owner/repo cross-request generalization", () => {
  const parser = new HarParser();

  it("torvalds/linux + octocat/hello-world -> {owner}/{repo}", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://api.github.com/repos/torvalds/linux"),
      makeHarEntry("GET", "https://api.github.com/repos/octocat/hello-world"),
      makeHarEntry("GET", "https://api.github.com/repos/linus/git"),
    ]);

    const apiData = parser.parse(har, "https://api.github.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    // With cross-request generalization, all three should merge into one group
    const repoGroups = groups.filter(g =>
      g.normalizedPath.includes("repos") && g.method === "GET"
    );
    expect(repoGroups.length).toBe(1);

    const group = repoGroups[0];
    // Both owner and repo segments should be parameterized
    expect(group.normalizedPath).toMatch(/\/repos\/\{[^}]+\}\/\{[^}]+\}/);
    expect(group.normalizedPath).not.toContain("torvalds");
    expect(group.normalizedPath).not.toContain("linux");
    expect(group.normalizedPath).not.toContain("octocat");
    expect(group.exampleCount).toBe(3);
  });

  it("nested paths: repos/{owner}/{repo}/issues should generalize", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://api.github.com/repos/torvalds/linux/issues"),
      makeHarEntry("GET", "https://api.github.com/repos/octocat/hello-world/issues"),
    ]);

    const apiData = parser.parse(har, "https://api.github.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    const issueGroups = groups.filter(g =>
      g.normalizedPath.includes("issues") && g.method === "GET"
    );
    expect(issueGroups.length).toBe(1);

    const group = issueGroups[0];
    // Owner and repo parameterized, but "issues" stays literal
    expect(group.normalizedPath).toMatch(/\/repos\/\{[^}]+\}\/\{[^}]+\}\/issues/);
    expect(group.normalizedPath).toContain("/issues");
  });
});

// ---------------------------------------------------------------------------
// Test 5: Static segments never parameterized
// ---------------------------------------------------------------------------

describe("Static segments should never be parameterized", () => {
  const parser = new HarParser();

  it("api, v1, v2 segments remain literal", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://example.com/api/v1/users/123"),
      makeHarEntry("GET", "https://example.com/api/v1/users/456"),
    ]);

    const apiData = parser.parse(har, "https://example.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    for (const group of groups) {
      expect(group.normalizedPath).toContain("/api/");
      expect(group.normalizedPath).toContain("/v1/");
    }
  });

  it("search, me, auth segments remain literal in different paths", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://example.com/api/v1/users/me"),
      makeHarEntry("GET", "https://example.com/api/v1/search?q=test"),
      makeHarEntry("POST", "https://example.com/api/v1/auth/login"),
    ]);

    const apiData = parser.parse(har, "https://example.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    const paths = groups.map(g => g.normalizedPath);
    // Each should be a separate endpoint, not merged together
    expect(paths.some(p => p.includes("/me"))).toBe(true);
    expect(paths.some(p => p.includes("/search"))).toBe(true);
    expect(paths.some(p => p.includes("/auth") || p.includes("/login"))).toBe(true);
  });

  it("graphql endpoint remains literal", () => {
    const har = makeHar([
      makeHarEntry("POST", "https://example.com/graphql"),
      makeHarEntry("POST", "https://example.com/graphql"),
    ]);

    const apiData = parser.parse(har, "https://example.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    const gqlGroups = groups.filter(g => g.normalizedPath.includes("graphql"));
    expect(gqlGroups.length).toBe(1);
    expect(gqlGroups[0].normalizedPath).toContain("graphql");
  });
});

// ---------------------------------------------------------------------------
// Test 6: Single-instance paths should NOT over-generalize
// ---------------------------------------------------------------------------

describe("Single-instance paths should not over-generalize", () => {
  const parser = new HarParser();

  it("single request with pure-letter segments keeps them literal", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://api.github.com/repos/torvalds/linux/languages"),
    ]);

    const apiData = parser.parse(har, "https://api.github.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    // With only one example, pure-letter segments stay literal
    expect(groups.length).toBe(1);
    expect(groups[0].normalizedPath).toContain("languages");
    expect(groups[0].normalizedPath).toContain("torvalds");
    expect(groups[0].normalizedPath).toContain("linux");
  });

  it("single numeric ID should still be parameterized (pattern-based)", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://example.com/api/v1/users/12345"),
    ]);

    const apiData = parser.parse(har, "https://example.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    expect(groups.length).toBe(1);
    // Numeric IDs always parameterized even with single instance
    expect(groups[0].normalizedPath).toMatch(/\{[^}]*[Ii]d[^}]*\}/);
    expect(groups[0].normalizedPath).not.toContain("12345");
  });
});

// ---------------------------------------------------------------------------
// Test 7: E-commerce — SKU codes with cross-request generalization
// ---------------------------------------------------------------------------

describe("E-commerce: SKU codes need cross-request generalization", () => {
  const parser = new HarParser();

  it("multiple SKU requests should be grouped into one endpoint", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://api.shop.com/v1/products/SKU-12345"),
      makeHarEntry("GET", "https://api.shop.com/v1/products/SKU-67890"),
      makeHarEntry("GET", "https://api.shop.com/v1/products/SKU-11111"),
      makeHarEntry("POST", "https://api.shop.com/v1/cart"),
    ]);

    const apiData = parser.parse(har, "https://api.shop.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    // Product GET requests should be grouped into one endpoint
    const productGroups = groups.filter(g =>
      g.normalizedPath.includes("products") && g.method === "GET"
    );
    expect(productGroups.length).toBe(1);
    expect(productGroups[0].exampleCount).toBe(3);

    // Cart POST should be separate
    const cartGroups = groups.filter(g =>
      g.normalizedPath.includes("cart") && g.method === "POST"
    );
    expect(cartGroups.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 8: File extensions stripped from method names
// ---------------------------------------------------------------------------

describe("File extensions in method names", () => {
  const parser = new HarParser();

  it("method names should not contain file extensions", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://api.nusmods.com/v2/2024-2025/modules/CS2030S.json"),
      makeHarEntry("GET", "https://api.nusmods.com/v2/2024-2025/modules/CS1101S.json"),
    ]);

    const apiData = parser.parse(har, "https://api.nusmods.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    for (const group of groups) {
      if (group.methodName) {
        expect(group.methodName).not.toContain(".json");
        expect(group.methodName).not.toContain(".xml");
        expect(group.methodName).not.toContain(".csv");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 9: UUID and mixed traffic
// ---------------------------------------------------------------------------

describe("Mixed real-world traffic scenarios", () => {
  const parser = new HarParser();

  it("REST API with UUID resources groups correctly by method", () => {
    const har = makeHar([
      makeHarEntry("GET", "https://api.example.com/v1/projects/a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
      makeHarEntry("GET", "https://api.example.com/v1/projects/11111111-2222-3333-4444-555555555555"),
      makeHarEntry("PUT", "https://api.example.com/v1/projects/a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
    ]);

    const apiData = parser.parse(har, "https://api.example.com");
    const groups = parser.buildEndpointGroups(apiData.requests);

    // GET requests with different UUIDs should be grouped
    const getGroups = groups.filter(g =>
      g.normalizedPath.includes("projects") && g.method === "GET"
    );
    expect(getGroups.length).toBe(1);
    expect(getGroups[0].exampleCount).toBe(2);

    // PUT should be a separate group (different method)
    const putGroups = groups.filter(g =>
      g.normalizedPath.includes("projects") && g.method === "PUT"
    );
    expect(putGroups.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 10: enrichApiData preserves existing behavior
// ---------------------------------------------------------------------------

describe("enrichApiData: normalizedPath enrichment", () => {
  it("adds normalizedPath to requests that lack it", () => {
    const apiData: ApiData = {
      service: "test",
      baseUrls: ["https://example.com"],
      baseUrl: "https://example.com",
      authHeaders: {},
      authMethod: "None",
      cookies: {},
      authInfo: {},
      requests: [
        { method: "GET", url: "https://example.com/users/123", path: "/users/123", domain: "example.com", status: 200 },
        { method: "GET", url: "https://example.com/users/456", path: "/users/456", domain: "example.com", status: 200 },
      ],
      endpoints: {},
    };

    const enriched = enrichApiData(apiData);

    for (const req of enriched.requests) {
      expect(req.normalizedPath).toBeDefined();
    }

    // Both /users/123 and /users/456 should normalize to the same path
    expect(enriched.requests[0].normalizedPath).toBe(enriched.requests[1].normalizedPath);
    expect(enriched.requests[0].normalizedPath).toMatch(/\/users\/\{[^}]+\}/);
  });

  it("builds endpointGroups from enriched requests", () => {
    const apiData: ApiData = {
      service: "test",
      baseUrls: ["https://example.com"],
      baseUrl: "https://example.com",
      authHeaders: {},
      authMethod: "None",
      cookies: {},
      authInfo: {},
      requests: [
        { method: "GET", url: "https://example.com/users/123", path: "/users/123", domain: "example.com", status: 200 },
        { method: "GET", url: "https://example.com/users/456", path: "/users/456", domain: "example.com", status: 200 },
        { method: "POST", url: "https://example.com/users", path: "/users", domain: "example.com", status: 201 },
      ],
      endpoints: {},
    };

    const enriched = enrichApiData(apiData);

    expect(enriched.endpointGroups).toBeDefined();
    expect(enriched.endpointGroups!.length).toBeGreaterThan(0);

    // GET /users/{id} should have exampleCount 2
    const getUserGroup = enriched.endpointGroups!.find(g =>
      g.method === "GET" && g.normalizedPath.includes("users")
    );
    expect(getUserGroup).toBeDefined();
    expect(getUserGroup!.exampleCount).toBe(2);
  });
});
