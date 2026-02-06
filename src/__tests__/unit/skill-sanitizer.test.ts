/**
 * Unit tests for skill-sanitizer.ts
 *
 * Tests the exported pure functions:
 *   - sanitizeApiTemplate()
 *   - extractEndpoints()
 *   - extractPublishableAuth()
 */

import { describe, it, expect } from "bun:test";
import {
  sanitizeApiTemplate,
  extractEndpoints,
  extractPublishableAuth,
} from "../../skill-sanitizer.js";

// ── sanitizeApiTemplate ──────────────────────────────────────────────────────

describe("sanitizeApiTemplate", () => {
  it("replaces Bearer tokens longer than 8 chars", () => {
    const input = 'headers["Authorization"] = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc"';
    const result = sanitizeApiTemplate(input);
    expect(result).toContain("Bearer YOUR_TOKEN_HERE");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("does not replace short Bearer values", () => {
    const input = 'headers["Authorization"] = "Bearer short"';
    const result = sanitizeApiTemplate(input);
    expect(result).toBe(input);
  });

  it("replaces token assignments with long values", () => {
    const input = 'const authToken = "ABCDEFGHIJKLMNOPQRSTuvwxyz1234567890"';
    const result = sanitizeApiTemplate(input);
    expect(result).toContain("YOUR_TOKEN_HERE");
    expect(result).not.toContain("ABCDEFGHIJKLMNOPQRSTuvwxyz1234567890");
  });

  it("replaces token property values", () => {
    const input = 'token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
    const result = sanitizeApiTemplate(input);
    expect(result).toContain("YOUR_TOKEN_HERE");
  });

  it("replaces apiKey assignments", () => {
    const input = 'const apiKey = "sk_live_12345678901234567890"';
    const result = sanitizeApiTemplate(input);
    expect(result).toContain("YOUR_TOKEN_HERE");
  });

  it("replaces api_key assignments", () => {
    const input = 'const api_key = "pk_test_abcdefghijklmnopqrst"';
    const result = sanitizeApiTemplate(input);
    expect(result).toContain("YOUR_TOKEN_HERE");
  });

  it("does not modify strings that are not token-like", () => {
    const input = 'const name = "hello world this is a test string"';
    const result = sanitizeApiTemplate(input);
    expect(result).toBe(input);
  });

  it("handles multiple Bearer tokens in the same string", () => {
    const input = [
      'headers["Authorization"] = "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      'headers["X-Custom"] = "Bearer bbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
    ].join("\n");
    const result = sanitizeApiTemplate(input);
    expect(result).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result).not.toContain("bbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("returns empty string unchanged", () => {
    expect(sanitizeApiTemplate("")).toBe("");
  });

  it("preserves non-credential code", () => {
    const input = 'const baseUrl = "https://api.example.com";\nconst limit = 100;';
    const result = sanitizeApiTemplate(input);
    expect(result).toBe(input);
  });
});

// ── extractEndpoints ─────────────────────────────────────────────────────────

describe("extractEndpoints", () => {
  it("extracts a single GET endpoint", () => {
    const skillMd = "- `GET /api/v2/streams/trending` \u2014 List trending streams";
    const endpoints = extractEndpoints(skillMd);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toEqual({
      method: "GET",
      path: "/api/v2/streams/trending",
      description: "List trending streams",
    });
  });

  it("extracts multiple endpoints with different methods", () => {
    const skillMd = [
      "- `GET /api/users` \u2014 List users",
      "- `POST /api/users` \u2014 Create user",
      "- `PUT /api/users/{id}` \u2014 Update user",
      "- `DELETE /api/users/{id}` \u2014 Delete user",
      "- `PATCH /api/users/{id}` \u2014 Patch user",
    ].join("\n");
    const endpoints = extractEndpoints(skillMd);
    expect(endpoints).toHaveLength(5);
    expect(endpoints.map(e => e.method)).toEqual(["GET", "POST", "PUT", "DELETE", "PATCH"]);
  });

  it("handles endpoints without descriptions", () => {
    const skillMd = "- `GET /api/health`";
    const endpoints = extractEndpoints(skillMd);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toEqual({
      method: "GET",
      path: "/api/health",
      description: "",
    });
  });

  it("returns empty array for content with no endpoints", () => {
    const skillMd = "# My Skill\n\nThis is a description with no endpoint lines.";
    const endpoints = extractEndpoints(skillMd);
    expect(endpoints).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractEndpoints("")).toEqual([]);
  });

  it("extracts endpoints from mixed content", () => {
    const skillMd = [
      "# Twitter API Skill",
      "",
      "## Endpoints",
      "- `GET /api/v1/timeline` \u2014 Get timeline",
      "Some other text in between",
      "- `POST /api/v1/tweets` \u2014 Create tweet",
      "",
      "## Notes",
      "This is a note.",
    ].join("\n");
    const endpoints = extractEndpoints(skillMd);
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0].path).toBe("/api/v1/timeline");
    expect(endpoints[1].path).toBe("/api/v1/tweets");
  });

  it("trims whitespace from path and description", () => {
    const skillMd = "- `GET  /api/users/{id}  ` \u2014  Get a user by ID  ";
    const endpoints = extractEndpoints(skillMd);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].path).toBe("/api/users/{id}");
    expect(endpoints[0].description).toBe("Get a user by ID");
  });
});

// ── extractPublishableAuth ───────────────────────────────────────────────────

describe("extractPublishableAuth", () => {
  it("extracts baseUrl and authMethod from valid auth JSON", () => {
    const authJson = JSON.stringify({
      baseUrl: "https://api.example.com",
      authMethod: "Bearer Token",
      token: "secret-should-not-appear",
      cookies: { session: "abc123" },
    });
    const result = extractPublishableAuth(authJson);
    expect(result).toEqual({
      baseUrl: "https://api.example.com",
      authMethodType: "Bearer Token",
    });
  });

  it("does not leak credentials", () => {
    const authJson = JSON.stringify({
      baseUrl: "https://api.example.com",
      authMethod: "API Key",
      apiKey: "sk-secret-key-12345",
      cookies: { session: "secret-session" },
      headers: { Authorization: "Bearer secret-token" },
    });
    const result = extractPublishableAuth(authJson);
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("sk-secret-key");
    expect(resultStr).not.toContain("secret-session");
    expect(resultStr).not.toContain("secret-token");
  });

  it("returns defaults for missing fields", () => {
    const authJson = JSON.stringify({});
    const result = extractPublishableAuth(authJson);
    expect(result).toEqual({
      baseUrl: "",
      authMethodType: "Unknown",
    });
  });

  it("returns defaults for invalid JSON", () => {
    const result = extractPublishableAuth("not valid json {{{");
    expect(result).toEqual({
      baseUrl: "",
      authMethodType: "Unknown",
    });
  });

  it("returns defaults for empty string", () => {
    const result = extractPublishableAuth("");
    expect(result).toEqual({
      baseUrl: "",
      authMethodType: "Unknown",
    });
  });

  it("handles authMethod with various values", () => {
    const cases = ["Cookie-based", "API Key", "OAuth 2.0", "Custom Header"];
    for (const method of cases) {
      const authJson = JSON.stringify({ authMethod: method });
      const result = extractPublishableAuth(authJson);
      expect(result.authMethodType).toBe(method);
    }
  });

  it("handles null baseUrl gracefully", () => {
    const authJson = JSON.stringify({ baseUrl: null, authMethod: "Bearer" });
    const result = extractPublishableAuth(authJson);
    // null ?? "" returns ""
    expect(result.baseUrl).toBe("");
  });
});
