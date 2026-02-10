/**
 * Header Profiler Tests
 *
 * Tests header classification, profile building (frequency-based),
 * and header resolution for replay.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  classifyHeader,
  buildHeaderProfiles,
  resolveHeaders,
  primeHeaders,
  type BrowserCapturer,
} from "../src/header-profiler.js";
import { sanitizeHeaderProfile } from "../src/skill-sanitizer.js";
import type { HarEntry, HeaderProfileFile } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(
  method: string,
  url: string,
  headers: Record<string, string>,
  status = 200,
): HarEntry {
  return {
    request: {
      method,
      url,
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    },
    response: { status, headers: [] },
  };
}

function makeEntries(
  count: number,
  domain: string,
  headers: Record<string, string>,
  path = "/api/data",
): HarEntry[] {
  return Array.from({ length: count }, (_, i) =>
    makeEntry("GET", `https://${domain}${path}?page=${i}`, headers)
  );
}

// ── classifyHeader ──────────────────────────────────────────────────────────

describe("classifyHeader", () => {
  it("should classify HTTP/2 pseudo-headers as protocol", () => {
    expect(classifyHeader(":authority")).toBe("protocol");
    expect(classifyHeader(":method")).toBe("protocol");
    expect(classifyHeader(":path")).toBe("protocol");
    expect(classifyHeader(":scheme")).toBe("protocol");
  });

  it("should classify transport headers as protocol", () => {
    expect(classifyHeader("host")).toBe("protocol");
    expect(classifyHeader("connection")).toBe("protocol");
    expect(classifyHeader("content-length")).toBe("protocol");
    expect(classifyHeader("transfer-encoding")).toBe("protocol");
    expect(classifyHeader("Host")).toBe("protocol");
  });

  it("should classify browser-auto-added headers as browser", () => {
    expect(classifyHeader("accept-encoding")).toBe("browser");
    expect(classifyHeader("sec-fetch-site")).toBe("browser");
    expect(classifyHeader("sec-fetch-mode")).toBe("browser");
    expect(classifyHeader("sec-fetch-dest")).toBe("browser");
    expect(classifyHeader("sec-ch-ua")).toBe("browser");
    expect(classifyHeader("sec-ch-ua-mobile")).toBe("browser");
    expect(classifyHeader("Sec-Fetch-Site")).toBe("browser");
  });

  it("should classify cookie headers as cookie", () => {
    expect(classifyHeader("cookie")).toBe("cookie");
    expect(classifyHeader("Cookie")).toBe("cookie");
    expect(classifyHeader("set-cookie")).toBe("cookie");
  });

  it("should classify auth headers as auth", () => {
    expect(classifyHeader("authorization")).toBe("auth");
    expect(classifyHeader("Authorization")).toBe("auth");
    expect(classifyHeader("x-api-key")).toBe("auth");
    expect(classifyHeader("x-csrf-token")).toBe("auth");
    expect(classifyHeader("bearer")).toBe("auth");
    expect(classifyHeader("x-auth-token")).toBe("auth");
  });

  it("should classify known context headers as context", () => {
    expect(classifyHeader("accept")).toBe("context");
    expect(classifyHeader("Accept")).toBe("context");
    expect(classifyHeader("user-agent")).toBe("context");
    expect(classifyHeader("User-Agent")).toBe("context");
    expect(classifyHeader("referer")).toBe("context");
    expect(classifyHeader("origin")).toBe("context");
    expect(classifyHeader("accept-language")).toBe("context");
    expect(classifyHeader("dnt")).toBe("context");
    expect(classifyHeader("cache-control")).toBe("context");
  });

  it("should classify unknown headers as app (catch-all)", () => {
    expect(classifyHeader("x-requested-with")).toBe("app");
    expect(classifyHeader("x-app-version")).toBe("app");
    expect(classifyHeader("x-client-id")).toBe("app");
    expect(classifyHeader("x-custom-anything")).toBe("app");
    expect(classifyHeader("content-type")).toBe("app");
  });

  it("should classify headers with auth-like patterns as auth", () => {
    // These contain substrings matching AUTH_HEADER_PATTERNS ("token", "key", etc.)
    expect(classifyHeader("x-shopify-storefront-token")).toBe("auth"); // contains "token"
    expect(classifyHeader("x-goog-api-key")).toBe("auth"); // contains "key"
    expect(classifyHeader("x-amz-security-token")).toBe("auth"); // contains "token"
  });

  it("should handle edge cases", () => {
    // Empty-ish headers
    expect(classifyHeader("x-powered-by")).toBe("app");
    expect(classifyHeader("pragma")).toBe("context");
  });
});

// ── buildHeaderProfiles ─────────────────────────────────────────────────────

describe("buildHeaderProfiles", () => {
  it("should capture headers appearing on >= 80% of requests as common", () => {
    const entries = makeEntries(10, "api.example.com", {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest",
    });

    const profile = buildHeaderProfiles(entries, new Set(["api.example.com"]));
    const domain = profile.domains["api.example.com"];

    expect(domain).toBeDefined();
    expect(domain.requestCount).toBe(10);
    expect(domain.commonHeaders["accept"]).toBeDefined();
    expect(domain.commonHeaders["accept"].value).toBe("application/json");
    expect(domain.commonHeaders["accept"].category).toBe("context");
    expect(domain.commonHeaders["user-agent"]).toBeDefined();
    expect(domain.commonHeaders["x-requested-with"]).toBeDefined();
    expect(domain.commonHeaders["x-requested-with"].category).toBe("app");
  });

  it("should NOT capture infrequent headers as common", () => {
    // 10 entries: 9 have Accept, only 1 has X-Upload-Id
    const entries = makeEntries(9, "api.example.com", {
      "Accept": "application/json",
    });
    entries.push(makeEntry("POST", "https://api.example.com/api/upload", {
      "Accept": "*/*",
      "X-Upload-Id": "abc123",
    }));

    const profile = buildHeaderProfiles(entries, new Set(["api.example.com"]));
    const domain = profile.domains["api.example.com"];

    expect(domain.commonHeaders["accept"]).toBeDefined(); // 10/10 = 100%
    expect(domain.commonHeaders["x-upload-id"]).toBeUndefined(); // 1/10 = 10%
  });

  it("should exclude auth headers from profile", () => {
    const entries = makeEntries(10, "api.example.com", {
      "Accept": "application/json",
      "Authorization": "Bearer abc123",
      "X-CSRF-Token": "token-xyz",
    });

    const profile = buildHeaderProfiles(entries, new Set(["api.example.com"]));
    const domain = profile.domains["api.example.com"];

    expect(domain.commonHeaders["accept"]).toBeDefined();
    expect(domain.commonHeaders["authorization"]).toBeUndefined();
    expect(domain.commonHeaders["x-csrf-token"]).toBeUndefined();
  });

  it("should exclude browser/protocol headers from profile", () => {
    const entries = makeEntries(10, "api.example.com", {
      "Accept": "application/json",
      "Accept-Encoding": "gzip, br",
      "Sec-Fetch-Mode": "cors",
      ":authority": "api.example.com",
      "Host": "api.example.com",
    });

    const profile = buildHeaderProfiles(entries, new Set(["api.example.com"]));
    const domain = profile.domains["api.example.com"];

    expect(domain.commonHeaders["accept"]).toBeDefined();
    expect(domain.commonHeaders["accept-encoding"]).toBeUndefined();
    expect(domain.commonHeaders["sec-fetch-mode"]).toBeUndefined();
    expect(domain.commonHeaders[":authority"]).toBeUndefined();
    expect(domain.commonHeaders["host"]).toBeUndefined();
  });

  it("should handle multiple domains separately", () => {
    const entries = [
      ...makeEntries(5, "api.example.com", { "Accept": "application/json" }),
      ...makeEntries(5, "cdn.example.com", { "Accept": "image/webp" }),
    ];

    const profile = buildHeaderProfiles(
      entries,
      new Set(["api.example.com", "cdn.example.com"])
    );

    expect(profile.domains["api.example.com"]).toBeDefined();
    expect(profile.domains["cdn.example.com"]).toBeDefined();
    expect(profile.domains["api.example.com"].commonHeaders["accept"].value).toBe("application/json");
    expect(profile.domains["cdn.example.com"].commonHeaders["accept"].value).toBe("image/webp");
  });

  it("should only include target domains", () => {
    const entries = [
      ...makeEntries(5, "api.example.com", { "Accept": "application/json" }),
      ...makeEntries(5, "analytics.google.com", { "Accept": "application/json" }),
    ];

    const profile = buildHeaderProfiles(entries, new Set(["api.example.com"]));

    expect(profile.domains["api.example.com"]).toBeDefined();
    expect(profile.domains["analytics.google.com"]).toBeUndefined();
  });

  it("should pick the most frequent value for a header", () => {
    const entries = [
      // 7 requests with application/json
      ...makeEntries(7, "api.example.com", { "Accept": "application/json" }),
      // 3 requests with text/plain
      ...makeEntries(3, "api.example.com", { "Accept": "text/plain" }),
    ];

    const profile = buildHeaderProfiles(entries, new Set(["api.example.com"]));
    expect(profile.domains["api.example.com"].commonHeaders["accept"].value).toBe("application/json");
  });

  it("should capture site-specific custom headers generically", () => {
    // Simulates a site with custom headers (non-auth-pattern names)
    const entries = makeEntries(10, "api.shopify.com", {
      "Accept": "application/json",
      "X-Shopify-Client-Version": "2.4.1",
      "X-Request-Context": "web",
      "X-Locale": "en-US",
    });

    const profile = buildHeaderProfiles(entries, new Set(["api.shopify.com"]));
    const domain = profile.domains["api.shopify.com"];

    // Custom headers captured as "app" category
    expect(domain.commonHeaders["x-shopify-client-version"]).toBeDefined();
    expect(domain.commonHeaders["x-shopify-client-version"].category).toBe("app");
    expect(domain.commonHeaders["x-request-context"]).toBeDefined();
    expect(domain.commonHeaders["x-locale"]).toBeDefined();
  });

  it("should exclude headers matching auth patterns from profile", () => {
    // Headers with "token" in name are classified as auth → excluded
    const entries = makeEntries(10, "api.shopify.com", {
      "Accept": "application/json",
      "X-Shopify-Storefront-Token": "storefront-abc-123",
    });

    const profile = buildHeaderProfiles(entries, new Set(["api.shopify.com"]));
    const domain = profile.domains["api.shopify.com"];

    expect(domain.commonHeaders["accept"]).toBeDefined();
    expect(domain.commonHeaders["x-shopify-storefront-token"]).toBeUndefined(); // Auth pattern
  });

  it("should produce endpoint overrides for endpoint-specific headers", () => {
    // Regular API endpoints with standard headers
    const apiEntries = makeEntries(8, "api.example.com", {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0",
    });

    // Upload endpoint with different Accept
    const uploadEntries = [
      makeEntry("POST", "https://api.example.com/api/upload", {
        "Accept": "*/*",
        "User-Agent": "Mozilla/5.0",
        "X-Upload-Checksum": "sha256:abc",
      }),
      makeEntry("POST", "https://api.example.com/api/upload", {
        "Accept": "*/*",
        "User-Agent": "Mozilla/5.0",
        "X-Upload-Checksum": "sha256:def",
      }),
    ];

    const entries = [...apiEntries, ...uploadEntries];
    const profile = buildHeaderProfiles(entries, new Set(["api.example.com"]));

    // Accept should be "application/json" in common (8/10)
    expect(profile.domains["api.example.com"].commonHeaders["accept"].value).toBe("application/json");

    // Upload endpoint should have override for accept
    const uploadOverride = profile.endpointOverrides["POST /api/upload"];
    expect(uploadOverride).toBeDefined();
    expect(uploadOverride.headers["accept"]).toBe("*/*");
  });

  it("should handle empty entries gracefully", () => {
    const profile = buildHeaderProfiles([], new Set(["api.example.com"]));
    expect(profile.domains).toEqual({});
    expect(profile.endpointOverrides).toEqual({});
    expect(profile.version).toBe(1);
  });

  it("should handle entries with no headers", () => {
    const entries: HarEntry[] = [{
      request: { method: "GET", url: "https://api.example.com/health", headers: [] },
      response: { status: 200, headers: [] },
    }];

    const profile = buildHeaderProfiles(entries, new Set(["api.example.com"]));
    expect(profile.domains["api.example.com"]).toBeDefined();
    expect(profile.domains["api.example.com"].requestCount).toBe(1);
    expect(Object.keys(profile.domains["api.example.com"].commonHeaders)).toHaveLength(0);
  });
});

// ── resolveHeaders ──────────────────────────────────────────────────────────

describe("resolveHeaders", () => {
  const baseProfile: HeaderProfileFile = {
    version: 1,
    domains: {
      "api.example.com": {
        domain: "api.example.com",
        commonHeaders: {
          "accept": { name: "Accept", value: "application/json", category: "context", seenCount: 50 },
          "user-agent": { name: "User-Agent", value: "Mozilla/5.0 (Mac)", category: "context", seenCount: 50 },
          "x-requested-with": { name: "X-Requested-With", value: "XMLHttpRequest", category: "app", seenCount: 50 },
          "referer": { name: "Referer", value: "https://example.com/app", category: "context", seenCount: 45 },
        },
        requestCount: 50,
        capturedAt: "2026-02-10T00:00:00Z",
      },
    },
    endpointOverrides: {
      "POST /api/upload": {
        endpointPattern: "POST /api/upload",
        headers: { "accept": "*/*" },
      },
    },
  };

  it("should include app headers by default (node mode) and exclude context", () => {
    const result = resolveHeaders(baseProfile, "api.example.com", "GET", "/api/data", {}, {});

    // Default is "node" mode — only app headers included
    expect(result["X-Requested-With"]).toBe("XMLHttpRequest"); // app — included
    expect(result["Accept"]).toBeUndefined(); // context — excluded
    expect(result["User-Agent"]).toBeUndefined(); // context — excluded
    expect(result["Referer"]).toBeUndefined(); // context — excluded
  });

  it("should apply endpoint overrides for app headers only (default node mode)", () => {
    const result = resolveHeaders(baseProfile, "api.example.com", "POST", "/api/upload", {}, {});

    // Accept override is context — excluded in default node mode
    expect(result["Accept"]).toBeUndefined();
    // App headers still present
    expect(result["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("should let auth headers win over profile headers", () => {
    const authHeaders = { "Authorization": "Bearer fresh-token" };
    const result = resolveHeaders(baseProfile, "api.example.com", "GET", "/api/data", authHeaders, {});

    expect(result["X-Requested-With"]).toBe("XMLHttpRequest"); // From profile (app)
    expect(result["Authorization"]).toBe("Bearer fresh-token"); // From auth
  });

  it("should build Cookie header from cookies dict", () => {
    const cookies = { "session_id": "abc123", "_csrf": "xyz789" };
    const result = resolveHeaders(baseProfile, "api.example.com", "GET", "/api/data", {}, cookies);

    expect(result["Cookie"]).toBe("session_id=abc123; _csrf=xyz789");
  });

  it("should not include Cookie header when cookies are empty", () => {
    const result = resolveHeaders(baseProfile, "api.example.com", "GET", "/api/data", {}, {});
    expect(result["Cookie"]).toBeUndefined();
  });

  it("should return only auth headers when profile is undefined", () => {
    const authHeaders = { "Authorization": "Bearer abc" };
    const result = resolveHeaders(undefined, "api.example.com", "GET", "/api/data", authHeaders, {});

    expect(result["Authorization"]).toBe("Bearer abc");
    expect(result["Accept"]).toBeUndefined(); // No profile = no context headers
  });

  it("should return only auth headers when domain not in profile", () => {
    const authHeaders = { "Authorization": "Bearer abc" };
    const result = resolveHeaders(baseProfile, "unknown.com", "GET", "/api/data", authHeaders, {});

    expect(result["Authorization"]).toBe("Bearer abc");
    expect(result["Accept"]).toBeUndefined();
  });

  it("should merge all layers correctly in default node mode", () => {
    const authHeaders = { "X-CSRF-Token": "fresh-csrf" };
    const cookies = { "sid": "session123" };
    const result = resolveHeaders(
      baseProfile, "api.example.com", "POST", "/api/upload", authHeaders, cookies
    );

    // Default node mode: context headers excluded, app + auth + cookies included
    expect(result["Accept"]).toBeUndefined(); // Context — excluded in node mode
    expect(result["User-Agent"]).toBeUndefined(); // Context — excluded
    expect(result["X-Requested-With"]).toBe("XMLHttpRequest"); // App — included
    expect(result["X-CSRF-Token"]).toBe("fresh-csrf"); // Auth
    expect(result["Cookie"]).toBe("sid=session123"); // Cookies
  });

  // ── mode: "node" vs "browser" ──────────────────────────────────────────

  it("should include context headers in explicit browser mode", () => {
    const result = resolveHeaders(baseProfile, "api.example.com", "GET", "/api/data", {}, {}, "browser");

    expect(result["Accept"]).toBe("application/json"); // context — included
    expect(result["User-Agent"]).toBe("Mozilla/5.0 (Mac)"); // context — included
    expect(result["Referer"]).toBe("https://example.com/app"); // context — included
    expect(result["X-Requested-With"]).toBe("XMLHttpRequest"); // app — included
  });

  it("should exclude context headers in node mode", () => {
    const result = resolveHeaders(baseProfile, "api.example.com", "GET", "/api/data", {}, {}, "node");

    // Context headers excluded — prevents TLS fingerprint mismatch detection
    expect(result["Accept"]).toBeUndefined();
    expect(result["User-Agent"]).toBeUndefined();
    expect(result["Referer"]).toBeUndefined();

    // App headers still included — site-specific, safe from Node.js
    expect(result["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("should exclude context endpoint overrides in node mode", () => {
    const result = resolveHeaders(baseProfile, "api.example.com", "POST", "/api/upload", {}, {}, "node");

    // Accept override is a context header — should be excluded in node mode
    expect(result["Accept"]).toBeUndefined();

    // App headers still included
    expect(result["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("should always include auth and cookies regardless of mode", () => {
    const authHeaders = { "Authorization": "Bearer token" };
    const cookies = { "sid": "session123" };
    const result = resolveHeaders(baseProfile, "api.example.com", "GET", "/api/data", authHeaders, cookies, "node");

    expect(result["Authorization"]).toBe("Bearer token");
    expect(result["Cookie"]).toBe("sid=session123");
    // But no context headers
    expect(result["User-Agent"]).toBeUndefined();
  });
});

// ── primeHeaders ────────────────────────────────────────────────────────────

describe("primeHeaders", () => {
  const testProfile: HeaderProfileFile = {
    version: 1,
    domains: {
      "api.example.com": {
        domain: "api.example.com",
        commonHeaders: {
          "accept": { name: "Accept", value: "application/json", category: "context", seenCount: 50 },
          "user-agent": { name: "User-Agent", value: "Mozilla/5.0 (old)", category: "context", seenCount: 50 },
          "x-app-version": { name: "X-App-Version", value: "1.0.0", category: "app", seenCount: 50 },
          "referer": { name: "Referer", value: "https://example.com/old", category: "context", seenCount: 45 },
        },
        requestCount: 50,
        capturedAt: "2026-02-10T00:00:00Z",
      },
    },
    endpointOverrides: {},
  };

  // Mock capturer that simulates a failed browser connection
  const failCapturer: BrowserCapturer = async () => ({
    headers: new Map(),
    cookies: {},
  });

  it("should return sample values when browser is not available", async () => {
    const result = await primeHeaders("https://api.example.com", testProfile, 19999, failCapturer);

    expect(result.headers["Accept"]).toBe("application/json");
    expect(result.headers["User-Agent"]).toBe("Mozilla/5.0 (old)");
    expect(result.headers["X-App-Version"]).toBe("1.0.0");
    expect(result.headers["Referer"]).toBe("https://example.com/old");
    expect(Object.keys(result.cookies)).toHaveLength(0);
  });

  it("should hydrate template with fresh browser values", async () => {
    const capturer: BrowserCapturer = async () => ({
      headers: new Map([
        ["accept", "application/json"],
        ["user-agent", "Mozilla/5.0 (Mac; Intel) Chrome/120.0.0"],
        ["x-app-version", "2.5.0"],
        ["referer", "https://example.com/dashboard"],
      ]),
      cookies: {
        session_id: "abc123",
        _csrf: "xyz789",
      },
    });

    const result = await primeHeaders("https://api.example.com", testProfile, 19999, capturer);

    expect(result.headers["User-Agent"]).toBe("Mozilla/5.0 (Mac; Intel) Chrome/120.0.0");
    expect(result.headers["X-App-Version"]).toBe("2.5.0");
    expect(result.headers["Referer"]).toBe("https://example.com/dashboard");
    expect(result.headers["Accept"]).toBe("application/json");
    expect(result.cookies["session_id"]).toBe("abc123");
    expect(result.cookies["_csrf"]).toBe("xyz789");
  });

  it("should fall back to sample values for unmatched keys", async () => {
    const capturer: BrowserCapturer = async () => ({
      headers: new Map([
        ["accept", "text/html"],
        ["user-agent", "Mozilla/5.0 (fresh)"],
      ]),
      cookies: {},
    });

    const result = await primeHeaders("https://api.example.com", testProfile, 19999, capturer);

    expect(result.headers["User-Agent"]).toBe("Mozilla/5.0 (fresh)");
    expect(result.headers["Accept"]).toBe("text/html");
    expect(result.headers["X-App-Version"]).toBe("1.0.0");
    expect(result.headers["Referer"]).toBe("https://example.com/old");
    expect(Object.keys(result.cookies)).toHaveLength(0);
  });

  it("should return empty result for empty profile", async () => {
    const emptyProfile: HeaderProfileFile = {
      version: 1,
      domains: {},
      endpointOverrides: {},
    };

    const result = await primeHeaders("https://api.example.com", emptyProfile, 19999, failCapturer);
    expect(Object.keys(result.headers)).toHaveLength(0);
    expect(Object.keys(result.cookies)).toHaveLength(0);
  });

  it("should ignore requests from non-target domains", async () => {
    // Capturer returns nothing matching the target domain
    const result = await primeHeaders("https://api.example.com", testProfile, 19999, failCapturer);

    expect(result.headers["User-Agent"]).toBe("Mozilla/5.0 (old)");
    expect(result.headers["X-App-Version"]).toBe("1.0.0");
    expect(Object.keys(result.cookies)).toHaveLength(0);
  });
});

// ── sanitizeHeaderProfile ─────────────────────────────────────────────────

describe("sanitizeHeaderProfile", () => {
  it("should strip auth header values but keep keys and categories", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {
        "api.example.com": {
          domain: "api.example.com",
          commonHeaders: {
            "authorization": { name: "Authorization", value: "Bearer secret123", category: "auth", seenCount: 10 },
            "x-api-key": { name: "X-Api-Key", value: "sk-live-abc", category: "auth", seenCount: 10 },
            "accept": { name: "Accept", value: "application/json", category: "context", seenCount: 10 },
            "x-requested-with": { name: "X-Requested-With", value: "XMLHttpRequest", category: "app", seenCount: 10 },
          },
          requestCount: 10,
          capturedAt: "2026-02-10T00:00:00Z",
        },
      },
      endpointOverrides: {},
    };

    const sanitized = sanitizeHeaderProfile(profile);

    // Auth values stripped
    expect(sanitized.domains["api.example.com"].commonHeaders["authorization"].value).toBe("");
    expect(sanitized.domains["api.example.com"].commonHeaders["x-api-key"].value).toBe("");
    // Auth categories preserved
    expect(sanitized.domains["api.example.com"].commonHeaders["authorization"].category).toBe("auth");
    expect(sanitized.domains["api.example.com"].commonHeaders["x-api-key"].category).toBe("auth");
    // Non-auth values kept as-is
    expect(sanitized.domains["api.example.com"].commonHeaders["accept"].value).toBe("application/json");
    expect(sanitized.domains["api.example.com"].commonHeaders["x-requested-with"].value).toBe("XMLHttpRequest");
  });

  it("should preserve version and endpointOverrides", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {},
      endpointOverrides: {
        "POST /api/upload": {
          endpointPattern: "POST /api/upload",
          headers: { "accept": "*/*" },
        },
      },
    };

    const sanitized = sanitizeHeaderProfile(profile);

    expect(sanitized.version).toBe(1);
    expect(sanitized.endpointOverrides["POST /api/upload"]).toBeDefined();
    expect(sanitized.endpointOverrides["POST /api/upload"].headers["accept"]).toBe("*/*");
  });

  it("should not mutate the original profile", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {
        "api.example.com": {
          domain: "api.example.com",
          commonHeaders: {
            "authorization": { name: "Authorization", value: "Bearer secret", category: "auth", seenCount: 5 },
          },
          requestCount: 5,
          capturedAt: "2026-02-10T00:00:00Z",
        },
      },
      endpointOverrides: {},
    };

    sanitizeHeaderProfile(profile);

    // Original should be unchanged
    expect(profile.domains["api.example.com"].commonHeaders["authorization"].value).toBe("Bearer secret");
  });

  it("should handle empty domains gracefully", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {},
      endpointOverrides: {},
    };

    const sanitized = sanitizeHeaderProfile(profile);

    expect(sanitized.version).toBe(1);
    expect(Object.keys(sanitized.domains)).toHaveLength(0);
  });

  it("should handle profile with only non-auth headers", () => {
    const profile: HeaderProfileFile = {
      version: 1,
      domains: {
        "api.example.com": {
          domain: "api.example.com",
          commonHeaders: {
            "accept": { name: "Accept", value: "application/json", category: "context", seenCount: 10 },
            "x-app-version": { name: "X-App-Version", value: "2.0", category: "app", seenCount: 10 },
          },
          requestCount: 10,
          capturedAt: "2026-02-10T00:00:00Z",
        },
      },
      endpointOverrides: {},
    };

    const sanitized = sanitizeHeaderProfile(profile);

    // All values preserved (no auth headers to strip)
    expect(sanitized.domains["api.example.com"].commonHeaders["accept"].value).toBe("application/json");
    expect(sanitized.domains["api.example.com"].commonHeaders["x-app-version"].value).toBe("2.0");
  });
});
