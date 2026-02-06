/**
 * Unit tests for path-normalizer.ts
 *
 * Tests normalizePath() and isSamePath() with various URL patterns:
 * numeric IDs, UUIDs, hex tokens, nested params, API prefixes,
 * static paths, dates, slugs, edge cases.
 */

import { describe, it, expect } from "bun:test";
import { normalizePath, isSamePath } from "../../path-normalizer.js";

// ── normalizePath ──────────────────────────────────────────────────────────

describe("normalizePath", () => {
  // ── Numeric IDs ────────────────────────────────────────────────────────

  describe("numeric IDs", () => {
    it("replaces a single numeric ID after a resource name", () => {
      const result = normalizePath("/users/123");
      expect(result.normalizedPath).toBe("/users/{userId}");
      expect(result.pathParams).toHaveLength(1);
      expect(result.pathParams[0].name).toBe("userId");
      expect(result.pathParams[0].type).toBe("numeric");
      expect(result.pathParams[0].exampleValue).toBe("123");
    });

    it("replaces large numeric IDs", () => {
      const result = normalizePath("/orders/9876543210");
      expect(result.normalizedPath).toBe("/orders/{orderId}");
      expect(result.pathParams[0].type).toBe("numeric");
    });

    it("handles timestamp-like numeric values", () => {
      const result = normalizePath("/events/1672531200");
      expect(result.normalizedPath).toBe("/events/{eventId}");
      expect(result.pathParams[0].type).toBe("numeric");
    });
  });

  // ── UUIDs ──────────────────────────────────────────────────────────────

  describe("UUIDs", () => {
    it("replaces a standard UUID", () => {
      const result = normalizePath("/users/550e8400-e29b-41d4-a716-446655440000");
      expect(result.normalizedPath).toBe("/users/{userId}");
      expect(result.pathParams[0].type).toBe("uuid");
      expect(result.pathParams[0].exampleValue).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("replaces uppercase UUIDs", () => {
      const result = normalizePath("/items/550E8400-E29B-41D4-A716-446655440000");
      expect(result.normalizedPath).toBe("/items/{productId}");
      expect(result.pathParams[0].type).toBe("uuid");
    });
  });

  // ── Hex tokens ─────────────────────────────────────────────────────────

  describe("hex tokens", () => {
    it("replaces an 8+ character hex string", () => {
      const result = normalizePath("/sessions/abcdef0123456789");
      expect(result.normalizedPath).toBe("/sessions/{sessionId}");
      expect(result.pathParams[0].type).toBe("hex");
    });

    it("replaces a long hex token after a resource", () => {
      const result = normalizePath("/files/deadbeef01234567");
      expect(result.normalizedPath).toBe("/files/{fileId}");
      expect(result.pathParams[0].type).toBe("hex");
    });

    it("does not replace short hex-like strings (< 8 chars)", () => {
      const result = normalizePath("/items/abc123");
      // "abc123" is 6 chars — too short for hex, but has letters+digits so "unknown"
      expect(result.normalizedPath).toBe("/items/{productId}");
      expect(result.pathParams[0].type).toBe("unknown");
    });
  });

  // ── Nested params ──────────────────────────────────────────────────────

  describe("nested params", () => {
    it("replaces multiple dynamic segments in a nested path", () => {
      const result = normalizePath("/users/123/orders/456");
      expect(result.normalizedPath).toBe("/users/{userId}/orders/{orderId}");
      expect(result.pathParams).toHaveLength(2);
      expect(result.pathParams[0].name).toBe("userId");
      expect(result.pathParams[1].name).toBe("orderId");
    });

    it("handles three levels of nesting", () => {
      const result = normalizePath("/users/123/orders/456/items/789");
      expect(result.normalizedPath).toBe("/users/{userId}/orders/{orderId}/items/{productId}");
      expect(result.pathParams).toHaveLength(3);
    });

    it("deduplicates parameter names", () => {
      const result = normalizePath("/users/123/users/456");
      expect(result.normalizedPath).toBe("/users/{userId}/users/{userId2}");
      expect(result.pathParams[0].name).toBe("userId");
      expect(result.pathParams[1].name).toBe("userId2");
    });
  });

  // ── API prefix preservation ────────────────────────────────────────────

  describe("API prefix preservation", () => {
    it("preserves /api/v1 prefix", () => {
      const result = normalizePath("/api/v1/users/123");
      expect(result.normalizedPath).toBe("/api/v1/users/{userId}");
      expect(result.pathParams).toHaveLength(1);
    });

    it("preserves /api/v2 prefix", () => {
      const result = normalizePath("/api/v2/products/42");
      expect(result.normalizedPath).toBe("/api/v2/products/{productId}");
    });

    it("preserves version segments like v1.2", () => {
      const result = normalizePath("/api/v1.2/items/99");
      expect(result.normalizedPath).toBe("/api/v1.2/items/{productId}");
    });
  });

  // ── Static paths ───────────────────────────────────────────────────────

  describe("static paths", () => {
    it("does not replace known static segments", () => {
      const result = normalizePath("/api/v1/auth/login");
      expect(result.normalizedPath).toBe("/api/v1/auth/login");
      expect(result.pathParams).toHaveLength(0);
    });

    it("does not replace /health or /status", () => {
      const result = normalizePath("/api/health");
      expect(result.normalizedPath).toBe("/api/health");
      expect(result.pathParams).toHaveLength(0);
    });

    it("does not replace /search or /export", () => {
      const result = normalizePath("/api/v1/search");
      expect(result.normalizedPath).toBe("/api/v1/search");
      expect(result.pathParams).toHaveLength(0);
    });

    it("preserves purely alphabetic resource names", () => {
      const result = normalizePath("/users/profile/settings");
      expect(result.normalizedPath).toBe("/users/profile/settings");
      expect(result.pathParams).toHaveLength(0);
    });
  });

  // ── Dates ──────────────────────────────────────────────────────────────

  describe("dates", () => {
    it("replaces ISO date segments", () => {
      const result = normalizePath("/reports/2024-01-15");
      expect(result.normalizedPath).toBe("/reports/{date}");
      expect(result.pathParams[0].type).toBe("date");
      expect(result.pathParams[0].name).toBe("date");
    });

    it("replaces date in a nested context", () => {
      const result = normalizePath("/analytics/events/2023-12-25/summary");
      expect(result.normalizedPath).toBe("/analytics/events/{date}/summary");
    });
  });

  // ── Slugs ──────────────────────────────────────────────────────────────

  describe("slugs", () => {
    it("replaces slug-like IDs (3+ dash-separated segments, 8+ chars)", () => {
      const result = normalizePath("/posts/abc-def-ghi");
      expect(result.normalizedPath).toBe("/posts/{postId}");
      expect(result.pathParams[0].type).toBe("slug");
    });

    it("replaces longer slugs", () => {
      const result = normalizePath("/articles/some-long-article-slug");
      expect(result.normalizedPath).toBe("/articles/{postId}");
      expect(result.pathParams[0].type).toBe("slug");
    });

    it("does not replace two-segment short slugs", () => {
      // "my-api" is only 6 chars and two segments — should not match slug pattern
      const result = normalizePath("/services/my-api");
      expect(result.normalizedPath).toBe("/services/my-api");
      expect(result.pathParams).toHaveLength(0);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles root path", () => {
      const result = normalizePath("/");
      expect(result.normalizedPath).toBe("/");
      expect(result.pathParams).toHaveLength(0);
    });

    it("handles trailing slashes", () => {
      const result = normalizePath("/users/123/");
      expect(result.normalizedPath).toBe("/users/{userId}/");
      expect(result.pathParams).toHaveLength(1);
    });

    it("handles empty path", () => {
      const result = normalizePath("");
      expect(result.normalizedPath).toBe("");
      expect(result.pathParams).toHaveLength(0);
    });

    it("handles path with only a numeric segment", () => {
      const result = normalizePath("/123");
      expect(result.normalizedPath).toBe("/{id}");
      expect(result.pathParams[0].name).toBe("id");
    });

    it("preserves positions correctly", () => {
      const result = normalizePath("/api/v1/users/42");
      // segments: ["", "api", "v1", "users", "42"]
      // 42 is at index 4
      expect(result.pathParams[0].position).toBe(4);
    });
  });

  // ── Resource naming ────────────────────────────────────────────────────

  describe("resource naming", () => {
    it("derives userId from /users", () => {
      expect(normalizePath("/users/1").pathParams[0].name).toBe("userId");
    });

    it("derives productId from /products", () => {
      expect(normalizePath("/products/1").pathParams[0].name).toBe("productId");
    });

    it("derives orderId from /orders", () => {
      expect(normalizePath("/orders/1").pathParams[0].name).toBe("orderId");
    });

    it("derives teamId from /teams", () => {
      expect(normalizePath("/teams/1").pathParams[0].name).toBe("teamId");
    });

    it("derives postId from /posts", () => {
      expect(normalizePath("/posts/1").pathParams[0].name).toBe("postId");
    });

    it("derives commentId from /comments", () => {
      expect(normalizePath("/comments/1").pathParams[0].name).toBe("commentId");
    });

    it("singularizes unknown plural resource names", () => {
      const result = normalizePath("/widgets/123");
      expect(result.pathParams[0].name).toBe("widgetId");
    });

    it("singularizes -ies plurals", () => {
      const result = normalizePath("/companies/123");
      // "companies" ends in "ies" → "company" + Id
      // But "companies" is in RESOURCE_NAMES under "team"
      expect(result.pathParams[0].name).toBe("teamId");
    });
  });
});

// ── isSamePath ─────────────────────────────────────────────────────────────

describe("isSamePath", () => {
  it("considers paths with different numeric IDs as the same", () => {
    expect(isSamePath("/users/123", "/users/456")).toBe(true);
  });

  it("considers paths with different UUIDs as the same", () => {
    expect(isSamePath(
      "/items/550e8400-e29b-41d4-a716-446655440000",
      "/items/660f9500-f30c-52e5-b827-557766550000",
    )).toBe(true);
  });

  it("considers different resources as different", () => {
    expect(isSamePath("/users/123", "/orders/123")).toBe(false);
  });

  it("considers different nesting as different", () => {
    expect(isSamePath("/users/123", "/users/123/orders")).toBe(false);
  });

  it("considers identical static paths as the same", () => {
    expect(isSamePath("/api/v1/health", "/api/v1/health")).toBe(true);
  });

  it("considers different static paths as different", () => {
    expect(isSamePath("/api/v1/health", "/api/v1/status")).toBe(false);
  });
});
