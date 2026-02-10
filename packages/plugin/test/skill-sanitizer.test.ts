/**
 * Skill Sanitizer Tests
 *
 * Tests sanitization of skill content before publishing to the marketplace.
 * Ensures no auth credentials leak while preserving template shape.
 */

import { describe, it, expect } from "bun:test";
import {
  sanitizeApiTemplate,
  extractEndpoints,
  extractPublishableAuth,
  sanitizeHeaderProfile,
} from "../src/skill-sanitizer.js";
import type { HeaderProfileFile } from "../src/types.js";

// ── sanitizeHeaderProfile ───────────────────────────────────────────────────

describe("sanitizeHeaderProfile", () => {
  it("should strip auth header values and replace with empty string", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {
        "api.example.com": {
          domain: "api.example.com",
          commonHeaders: {
            "authorization": {
              name: "Authorization",
              value: "Bearer super-secret-token-123",
              category: "auth",
              seenCount: 50,
            },
            "x-api-key": {
              name: "X-Api-Key",
              value: "sk_live_abc123secret",
              category: "auth",
              seenCount: 50,
            },
          },
          requestCount: 50,
          capturedAt: "2026-02-10T00:00:00Z",
        },
      },
      endpointOverrides: {},
    };

    const sanitized = sanitizeHeaderProfile(profile);

    expect(sanitized.domains["api.example.com"].commonHeaders["authorization"].value).toBe("");
    expect(sanitized.domains["api.example.com"].commonHeaders["x-api-key"].value).toBe("");
    // Category and other metadata preserved
    expect(sanitized.domains["api.example.com"].commonHeaders["authorization"].category).toBe("auth");
    expect(sanitized.domains["api.example.com"].commonHeaders["authorization"].name).toBe("Authorization");
    expect(sanitized.domains["api.example.com"].commonHeaders["authorization"].seenCount).toBe(50);
  });

  it("should preserve app header values as-is", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {
        "api.example.com": {
          domain: "api.example.com",
          commonHeaders: {
            "x-requested-with": {
              name: "X-Requested-With",
              value: "XMLHttpRequest",
              category: "app",
              seenCount: 50,
            },
            "x-app-version": {
              name: "X-App-Version",
              value: "2.4.1",
              category: "app",
              seenCount: 50,
            },
          },
          requestCount: 50,
          capturedAt: "2026-02-10T00:00:00Z",
        },
      },
      endpointOverrides: {},
    };

    const sanitized = sanitizeHeaderProfile(profile);

    expect(sanitized.domains["api.example.com"].commonHeaders["x-requested-with"].value).toBe("XMLHttpRequest");
    expect(sanitized.domains["api.example.com"].commonHeaders["x-app-version"].value).toBe("2.4.1");
  });

  it("should preserve context header values as-is", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {
        "api.example.com": {
          domain: "api.example.com",
          commonHeaders: {
            "accept": {
              name: "Accept",
              value: "application/json",
              category: "context",
              seenCount: 50,
            },
            "user-agent": {
              name: "User-Agent",
              value: "Mozilla/5.0 (Mac)",
              category: "context",
              seenCount: 50,
            },
          },
          requestCount: 50,
          capturedAt: "2026-02-10T00:00:00Z",
        },
      },
      endpointOverrides: {},
    };

    const sanitized = sanitizeHeaderProfile(profile);

    expect(sanitized.domains["api.example.com"].commonHeaders["accept"].value).toBe("application/json");
    expect(sanitized.domains["api.example.com"].commonHeaders["user-agent"].value).toBe("Mozilla/5.0 (Mac)");
  });

  it("should strip auth but keep app and context in mixed profiles", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {
        "api.example.com": {
          domain: "api.example.com",
          commonHeaders: {
            "authorization": {
              name: "Authorization",
              value: "Bearer secret-token",
              category: "auth",
              seenCount: 50,
            },
            "accept": {
              name: "Accept",
              value: "application/json",
              category: "context",
              seenCount: 50,
            },
            "x-client-id": {
              name: "X-Client-Id",
              value: "web-client-v3",
              category: "app",
              seenCount: 50,
            },
          },
          requestCount: 50,
          capturedAt: "2026-02-10T00:00:00Z",
        },
      },
      endpointOverrides: {},
    };

    const sanitized = sanitizeHeaderProfile(profile);

    expect(sanitized.domains["api.example.com"].commonHeaders["authorization"].value).toBe("");
    expect(sanitized.domains["api.example.com"].commonHeaders["accept"].value).toBe("application/json");
    expect(sanitized.domains["api.example.com"].commonHeaders["x-client-id"].value).toBe("web-client-v3");
  });

  it("should preserve endpoint overrides unchanged", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {
        "api.example.com": {
          domain: "api.example.com",
          commonHeaders: {},
          requestCount: 10,
          capturedAt: "2026-02-10T00:00:00Z",
        },
      },
      endpointOverrides: {
        "POST /api/upload": {
          endpointPattern: "POST /api/upload",
          headers: { "accept": "*/*", "content-type": "multipart/form-data" },
        },
      },
    };

    const sanitized = sanitizeHeaderProfile(profile);

    expect(sanitized.endpointOverrides["POST /api/upload"]).toBeDefined();
    expect(sanitized.endpointOverrides["POST /api/upload"].headers["accept"]).toBe("*/*");
  });

  it("should handle multiple domains independently", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {
        "api.example.com": {
          domain: "api.example.com",
          commonHeaders: {
            "authorization": {
              name: "Authorization",
              value: "Bearer secret1",
              category: "auth",
              seenCount: 50,
            },
          },
          requestCount: 50,
          capturedAt: "2026-02-10T00:00:00Z",
        },
        "cdn.example.com": {
          domain: "cdn.example.com",
          commonHeaders: {
            "x-cdn-key": {
              name: "X-CDN-Key",
              value: "cdn-key-value",
              category: "app",
              seenCount: 20,
            },
          },
          requestCount: 20,
          capturedAt: "2026-02-10T00:00:00Z",
        },
      },
      endpointOverrides: {},
    };

    const sanitized = sanitizeHeaderProfile(profile);

    expect(sanitized.domains["api.example.com"].commonHeaders["authorization"].value).toBe("");
    expect(sanitized.domains["cdn.example.com"].commonHeaders["x-cdn-key"].value).toBe("cdn-key-value");
  });

  it("should handle empty profile gracefully", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {},
      endpointOverrides: {},
    };

    const sanitized = sanitizeHeaderProfile(profile);

    expect(sanitized.version).toBe(1);
    expect(sanitized.domains).toEqual({});
    expect(sanitized.endpointOverrides).toEqual({});
  });

  it("should not mutate the original profile", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {
        "api.example.com": {
          domain: "api.example.com",
          commonHeaders: {
            "authorization": {
              name: "Authorization",
              value: "Bearer original-token",
              category: "auth",
              seenCount: 50,
            },
          },
          requestCount: 50,
          capturedAt: "2026-02-10T00:00:00Z",
        },
      },
      endpointOverrides: {},
    };

    sanitizeHeaderProfile(profile);

    // Original should be untouched
    expect(profile.domains["api.example.com"].commonHeaders["authorization"].value).toBe("Bearer original-token");
  });
});

// ── sanitizeApiTemplate ─────────────────────────────────────────────────────

describe("sanitizeApiTemplate", () => {
  it("should replace Bearer tokens with placeholder", () => {
    const input = 'headers["Authorization"] = "Bearer sk_live_abcdef1234567890"';
    const result = sanitizeApiTemplate(input);
    expect(result).toContain("Bearer YOUR_TOKEN_HERE");
    expect(result).not.toContain("sk_live_abcdef1234567890");
  });

  it("should replace long token-like strings in auth contexts", () => {
    const input = 'authToken: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"';
    const result = sanitizeApiTemplate(input);
    expect(result).toContain("YOUR_TOKEN_HERE");
  });

  it("should not modify non-sensitive strings", () => {
    const input = 'const name = "hello world";';
    const result = sanitizeApiTemplate(input);
    expect(result).toBe(input);
  });
});

// ── extractEndpoints ────────────────────────────────────────────────────────

describe("extractEndpoints", () => {
  it("should extract endpoints from SKILL.md format", () => {
    const skillMd = `
- \`GET /api/users\` — List users
- \`POST /api/users\` — Create user
- \`DELETE /api/users/{id}\` — Delete user
`;
    const endpoints = extractEndpoints(skillMd);
    expect(endpoints).toHaveLength(3);
    expect(endpoints[0]).toEqual({ method: "GET", path: "/api/users", description: "List users" });
    expect(endpoints[1]).toEqual({ method: "POST", path: "/api/users", description: "Create user" });
    expect(endpoints[2]).toEqual({ method: "DELETE", path: "/api/users/{id}", description: "Delete user" });
  });

  it("should handle endpoints without descriptions", () => {
    const skillMd = "- `GET /api/health`\n";
    const endpoints = extractEndpoints(skillMd);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].description).toBe("");
  });
});

// ── extractPublishableAuth ──────────────────────────────────────────────────

describe("extractPublishableAuth", () => {
  it("should extract baseUrl and authMethod", () => {
    const authJson = JSON.stringify({
      baseUrl: "https://api.example.com",
      authMethod: "Bearer Token",
      headers: { authorization: "Bearer secret" },
      cookies: { session: "abc123" },
    });
    const result = extractPublishableAuth(authJson);
    expect(result.baseUrl).toBe("https://api.example.com");
    expect(result.authMethodType).toBe("Bearer Token");
  });

  it("should handle invalid JSON gracefully", () => {
    const result = extractPublishableAuth("not json");
    expect(result.baseUrl).toBe("");
    expect(result.authMethodType).toBe("Unknown");
  });
});
