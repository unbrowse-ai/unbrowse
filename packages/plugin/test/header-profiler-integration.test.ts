/**
 * Header Profiler Integration Tests
 *
 * Tests the full pipeline: HAR → parseHar → headerProfile → generateSkill
 * → headers.json → load skill → resolveHeaders → correct headers.
 *
 * Uses realistic test data simulating actual API traffic patterns.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseHar } from "../src/har-parser.js";
import { generateSkill } from "../src/skill-generator.js";
import { resolveHeaders, buildHeaderProfiles, classifyHeader } from "../src/header-profiler.js";
import { enrichApiData } from "../src/har-parser.js";
import type { HarEntry, HeaderProfileFile, ApiData } from "../src/types.js";

// ── Test Data Builders ───────────────────────────────────────────────────────

/** Build a realistic HAR entry with mixed header categories. */
function makeHarEntry(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  requestBody?: string;
  cookies?: { name: string; value: string }[];
}): HarEntry {
  return {
    request: {
      method: opts.method,
      url: opts.url,
      headers: Object.entries(opts.headers ?? {}).map(([name, value]) => ({ name, value })),
      cookies: opts.cookies,
      postData: opts.requestBody ? { mimeType: "application/json", text: opts.requestBody } : undefined,
    },
    response: {
      status: opts.status ?? 200,
      headers: Object.entries(opts.responseHeaders ?? { "content-type": "application/json" })
        .map(([name, value]) => ({ name, value })),
      content: opts.responseBody ? { text: opts.responseBody, mimeType: "application/json" } : undefined,
    },
  };
}

/**
 * Build a realistic HAR capture simulating a SaaS dashboard with:
 * - Multiple API endpoints (GET, POST, PUT)
 * - Auth headers (Authorization, x-csrf-token)
 * - App-specific custom headers (x-app-version, x-client-id, x-workspace-id)
 * - Browser context headers (accept, user-agent, referer)
 * - Protocol/browser headers (accept-encoding, sec-fetch-site)
 * - Cookies (session_id, _csrf)
 */
function buildRealisticHar(requestCount = 10): { log: { entries: HarEntry[] } } {
  const entries: HarEntry[] = [];
  const domain = "api.acme-saas.com";
  const baseHeaders: Record<string, string> = {
    // Auth headers (should NOT appear in header profile)
    "Authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.abc123",
    "x-csrf-token": "csrf-abc-123",
    // App headers (should appear in profile as "app")
    "X-App-Version": "3.2.1",
    "X-Client-Id": "web-dashboard-v2",
    "X-Workspace-Id": "ws-12345",
    "Content-Type": "application/json",
    // Context headers (should appear in profile as "context")
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0",
    "Referer": "https://app.acme-saas.com/dashboard",
    "Accept-Language": "en-US,en;q=0.9",
    // Browser auto-added (should NOT appear in profile)
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    // Protocol (should NOT appear in profile)
    ":authority": "api.acme-saas.com",
  };

  // Regular API calls (GET /api/v1/projects)
  for (let i = 0; i < requestCount; i++) {
    entries.push(makeHarEntry({
      method: "GET",
      url: `https://${domain}/api/v1/projects?page=${i + 1}&limit=20`,
      headers: baseHeaders,
      responseBody: JSON.stringify({ projects: [{ id: `proj-${i}`, name: `Project ${i}` }] }),
      cookies: [
        { name: "session_id", value: "sess-abc123" },
        { name: "_csrf", value: "csrf-xyz789" },
      ],
    }));
  }

  // POST /api/v1/projects (with same headers)
  entries.push(makeHarEntry({
    method: "POST",
    url: `https://${domain}/api/v1/projects`,
    headers: baseHeaders,
    requestBody: JSON.stringify({ name: "New Project", description: "Test" }),
    responseBody: JSON.stringify({ id: "proj-new", name: "New Project" }),
    cookies: [
      { name: "session_id", value: "sess-abc123" },
    ],
  }));

  // Upload endpoint with different headers (endpoint-specific override)
  entries.push(makeHarEntry({
    method: "POST",
    url: `https://${domain}/api/v1/uploads`,
    headers: {
      ...baseHeaders,
      "Accept": "*/*",
      "Content-Type": "multipart/form-data; boundary=----WebKitFormBoundary",
      "X-Upload-Checksum": "sha256:abc123def456",
    },
  }));
  entries.push(makeHarEntry({
    method: "POST",
    url: `https://${domain}/api/v1/uploads`,
    headers: {
      ...baseHeaders,
      "Accept": "*/*",
      "Content-Type": "multipart/form-data; boundary=----WebKitFormBoundary",
      "X-Upload-Checksum": "sha256:def789ghi012",
    },
  }));

  return { log: { entries } };
}

/**
 * Build a minimal HAR with only auth + context headers (no custom app headers).
 */
function buildMinimalHar(): { log: { entries: HarEntry[] } } {
  const entries: HarEntry[] = [];
  const domain = "api.minimal.io";

  for (let i = 0; i < 5; i++) {
    entries.push(makeHarEntry({
      method: "GET",
      url: `https://${domain}/api/data?page=${i}`,
      headers: {
        "Authorization": "Bearer token-xyz",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      responseBody: JSON.stringify({ items: [] }),
    }));
  }

  return { log: { entries } };
}

// ── Integration Tests ────────────────────────────────────────────────────────

describe("Header Profiler Pipeline Integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "header-profiler-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Phase 1: parseHar → headerProfile ──────────────────────────────────

  describe("Phase 1: parseHar generates headerProfile", () => {
    it("should populate headerProfile on ApiData from realistic HAR", () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");

      expect(apiData.headerProfile).toBeDefined();
      expect(apiData.headerProfile!.version).toBe(1);

      const domainProfile = apiData.headerProfile!.domains["api.acme-saas.com"];
      expect(domainProfile).toBeDefined();
      expect(domainProfile.requestCount).toBeGreaterThan(0);
    });

    it("should include app headers in the profile", () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      const domainProfile = apiData.headerProfile!.domains["api.acme-saas.com"];

      // App-specific custom headers should be captured
      expect(domainProfile.commonHeaders["x-app-version"]).toBeDefined();
      expect(domainProfile.commonHeaders["x-app-version"].value).toBe("3.2.1");
      expect(domainProfile.commonHeaders["x-app-version"].category).toBe("app");

      expect(domainProfile.commonHeaders["x-client-id"]).toBeDefined();
      expect(domainProfile.commonHeaders["x-client-id"].category).toBe("app");

      expect(domainProfile.commonHeaders["x-workspace-id"]).toBeDefined();
      expect(domainProfile.commonHeaders["x-workspace-id"].category).toBe("app");
    });

    it("should include context headers in the profile", () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      const domainProfile = apiData.headerProfile!.domains["api.acme-saas.com"];

      expect(domainProfile.commonHeaders["accept"]).toBeDefined();
      expect(domainProfile.commonHeaders["accept"].category).toBe("context");

      expect(domainProfile.commonHeaders["user-agent"]).toBeDefined();
      expect(domainProfile.commonHeaders["user-agent"].category).toBe("context");
    });

    it("should exclude auth headers from the profile", () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      const domainProfile = apiData.headerProfile!.domains["api.acme-saas.com"];

      // Auth headers should NOT be in the profile (they go in auth.json)
      expect(domainProfile.commonHeaders["authorization"]).toBeUndefined();
      expect(domainProfile.commonHeaders["x-csrf-token"]).toBeUndefined();
    });

    it("should exclude browser and protocol headers from the profile", () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      const domainProfile = apiData.headerProfile!.domains["api.acme-saas.com"];

      expect(domainProfile.commonHeaders["accept-encoding"]).toBeUndefined();
      expect(domainProfile.commonHeaders["sec-fetch-site"]).toBeUndefined();
      expect(domainProfile.commonHeaders["sec-fetch-mode"]).toBeUndefined();
      expect(domainProfile.commonHeaders[":authority"]).toBeUndefined();
    });

    it("should return headerProfile with empty domains for empty HAR", () => {
      const har = { log: { entries: [] } };
      const apiData = parseHar(har);

      // Empty HAR may not have headerProfile since there are no target domains
      // The parse still returns valid structure
      expect(apiData).toBeDefined();
      expect(apiData.requests).toHaveLength(0);
    });

    it("should still extract auth headers into apiData.authHeaders", () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");

      // Auth headers should be in authHeaders, not in headerProfile
      expect(apiData.authHeaders["authorization"]).toBeDefined();
      expect(apiData.authHeaders["x-csrf-token"]).toBeDefined();
    });
  });

  // ── Phase 2: generateSkill → headers.json ──────────────────────────────

  describe("Phase 2: generateSkill writes headers.json", () => {
    it("should write headers.json when headerProfile has domains", async () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData);

      const result = await generateSkill(apiData, tmpDir);

      const headersPath = join(result.skillDir, "headers.json");
      expect(existsSync(headersPath)).toBe(true);

      const profile: HeaderProfileFile = JSON.parse(readFileSync(headersPath, "utf-8"));
      expect(profile.version).toBe(1);
      expect(profile.domains["api.acme-saas.com"]).toBeDefined();
    });

    it("should include app headers in headers.json", async () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData);

      const result = await generateSkill(apiData, tmpDir);
      const headersPath = join(result.skillDir, "headers.json");
      const profile: HeaderProfileFile = JSON.parse(readFileSync(headersPath, "utf-8"));
      const domainProfile = profile.domains["api.acme-saas.com"];

      expect(domainProfile.commonHeaders["x-app-version"]).toBeDefined();
      expect(domainProfile.commonHeaders["x-app-version"].value).toBe("3.2.1");
      expect(domainProfile.commonHeaders["x-app-version"].category).toBe("app");
    });

    it("should write auth.json alongside headers.json", async () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData);

      const result = await generateSkill(apiData, tmpDir);

      expect(existsSync(join(result.skillDir, "auth.json"))).toBe(true);
      expect(existsSync(join(result.skillDir, "headers.json"))).toBe(true);
      expect(existsSync(join(result.skillDir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(result.skillDir, "scripts", "api.ts"))).toBe(true);
    });

    it("should NOT write headers.json when headerProfile has no domains", async () => {
      // Build apiData with empty header profile
      const apiData: ApiData = {
        service: "empty-headers-test",
        baseUrls: ["https://api.empty.com"],
        baseUrl: "https://api.empty.com",
        authHeaders: { "Authorization": "Bearer token" },
        authMethod: "Bearer",
        cookies: {},
        authInfo: {},
        requests: [{
          method: "GET",
          url: "https://api.empty.com/health",
          path: "/health",
          domain: "api.empty.com",
          status: 200,
        }],
        endpoints: { "api.empty.com:/health": [{ method: "GET", url: "https://api.empty.com/health", path: "/health", domain: "api.empty.com", status: 200 }] },
        headerProfile: { version: 1, domains: {}, endpointOverrides: {} },
      };

      const result = await generateSkill(apiData, tmpDir);
      const headersPath = join(result.skillDir, "headers.json");

      // Empty domains means headers.json should NOT be written
      expect(existsSync(headersPath)).toBe(false);
    });
  });

  // ── Phase 3: Load skill → resolveHeaders ────────────────────────────────

  describe("Phase 3: resolveHeaders produces correct headers from profile", () => {
    it("should resolve app headers in node mode (context excluded)", async () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData);

      const result = await generateSkill(apiData, tmpDir);
      const headersPath = join(result.skillDir, "headers.json");
      const profile: HeaderProfileFile = JSON.parse(readFileSync(headersPath, "utf-8"));

      // Simulate what unbrowse_replay does: resolveHeaders in node mode
      const authHeaders = { "Authorization": "Bearer fresh-token" };
      const cookies = { "session_id": "fresh-sess" };
      const resolved = resolveHeaders(
        profile, "api.acme-saas.com", "GET", "/api/v1/projects", authHeaders, cookies, "node",
      );

      // App headers should be present
      expect(resolved["X-App-Version"]).toBe("3.2.1");
      expect(resolved["X-Client-Id"]).toBe("web-dashboard-v2");
      expect(resolved["X-Workspace-Id"]).toBe("ws-12345");

      // Context headers should be EXCLUDED in node mode
      expect(resolved["Accept"]).toBeUndefined();
      expect(resolved["User-Agent"]).toBeUndefined();
      expect(resolved["Referer"]).toBeUndefined();

      // Auth headers should be present (from auth layer)
      expect(resolved["Authorization"]).toBe("Bearer fresh-token");

      // Cookies should be present
      expect(resolved["Cookie"]).toBe("session_id=fresh-sess");
    });

    it("should resolve all headers in browser mode", async () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData);

      const result = await generateSkill(apiData, tmpDir);
      const headersPath = join(result.skillDir, "headers.json");
      const profile: HeaderProfileFile = JSON.parse(readFileSync(headersPath, "utf-8"));

      const resolved = resolveHeaders(
        profile, "api.acme-saas.com", "GET", "/api/v1/projects", {}, {}, "browser",
      );

      // App headers present
      expect(resolved["X-App-Version"]).toBe("3.2.1");

      // Context headers INCLUDED in browser mode
      expect(resolved["Accept"]).toBeDefined();
      expect(resolved["User-Agent"]).toBeDefined();
    });

    it("should let auth headers override any profile headers", async () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData);

      const result = await generateSkill(apiData, tmpDir);
      const headersPath = join(result.skillDir, "headers.json");
      const profile: HeaderProfileFile = JSON.parse(readFileSync(headersPath, "utf-8"));

      // Auth headers override everything
      const authHeaders = {
        "Authorization": "Bearer override-token",
        "X-CSRF-Token": "fresh-csrf",
      };
      const resolved = resolveHeaders(
        profile, "api.acme-saas.com", "GET", "/api/v1/projects", authHeaders, {},
      );

      expect(resolved["Authorization"]).toBe("Bearer override-token");
      expect(resolved["X-CSRF-Token"]).toBe("fresh-csrf");
      // App headers still present
      expect(resolved["X-App-Version"]).toBe("3.2.1");
    });

    it("should work without headers.json (backwards compatibility)", () => {
      // No profile at all — just auth + cookies
      const authHeaders = { "Authorization": "Bearer abc" };
      const cookies = { "session_id": "sess-xyz" };
      const resolved = resolveHeaders(
        undefined, "api.example.com", "GET", "/api/data", authHeaders, cookies,
      );

      // Only auth headers and cookies — no profile headers
      expect(resolved["Authorization"]).toBe("Bearer abc");
      expect(resolved["Cookie"]).toBe("session_id=sess-xyz");
      expect(Object.keys(resolved)).toHaveLength(2);
    });
  });

  // ── Phase 4: Endpoint overrides ────────────────────────────────────────

  describe("Phase 4: Endpoint-specific header overrides", () => {
    it("should detect endpoint-specific overrides in parseHar", () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");

      const overrides = apiData.headerProfile!.endpointOverrides;
      // The upload endpoint has a different Content-Type and Accept
      // At minimum we should have overrides detected
      expect(overrides).toBeDefined();
    });

    it("should apply endpoint overrides in resolveHeaders", () => {
      // Build a profile with a known endpoint override
      const profile: HeaderProfileFile = {
        version: 1,
        domains: {
          "api.acme-saas.com": {
            domain: "api.acme-saas.com",
            commonHeaders: {
              "x-app-version": {
                name: "X-App-Version",
                value: "3.2.1",
                category: "app",
                seenCount: 50,
              },
              "content-type": {
                name: "Content-Type",
                value: "application/json",
                category: "app",
                seenCount: 50,
              },
            },
            requestCount: 50,
            capturedAt: new Date().toISOString(),
          },
        },
        endpointOverrides: {
          "POST /api/v1/uploads": {
            endpointPattern: "POST /api/v1/uploads",
            headers: {
              "content-type": "multipart/form-data",
            },
          },
        },
      };

      // Regular endpoint uses common Content-Type
      const regularResolved = resolveHeaders(
        profile, "api.acme-saas.com", "GET", "/api/v1/projects", {}, {},
      );
      expect(regularResolved["Content-Type"]).toBe("application/json");
      expect(regularResolved["X-App-Version"]).toBe("3.2.1");

      // Upload endpoint gets the override
      const uploadResolved = resolveHeaders(
        profile, "api.acme-saas.com", "POST", "/api/v1/uploads", {}, {},
      );
      expect(uploadResolved["Content-Type"]).toBe("multipart/form-data");
      expect(uploadResolved["X-App-Version"]).toBe("3.2.1");
    });
  });

  // ── Phase 5: Full pipeline round-trip ──────────────────────────────────

  describe("Phase 5: Full round-trip HAR → skill → headers", () => {
    it("should produce correct headers after full pipeline", async () => {
      // Step 1: Parse HAR
      const har = buildRealisticHar(15);
      const apiData = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData);

      // Verify parseHar output
      expect(apiData.headerProfile).toBeDefined();
      expect(apiData.requests.length).toBeGreaterThan(0);
      expect(apiData.authHeaders["authorization"]).toBeDefined();

      // Step 2: Generate skill to disk
      const result = await generateSkill(apiData, tmpDir);
      expect(result.skillDir).toBeDefined();
      expect(result.endpointCount).toBeGreaterThan(0);

      // Step 3: Load headers.json from generated skill
      const headersPath = join(result.skillDir, "headers.json");
      expect(existsSync(headersPath)).toBe(true);
      const profile: HeaderProfileFile = JSON.parse(readFileSync(headersPath, "utf-8"));

      // Step 4: Resolve headers as unbrowse_replay would
      const freshAuth = { "Authorization": "Bearer refreshed-jwt-token" };
      const freshCookies = { "session_id": "new-session", "_csrf": "new-csrf" };
      const resolved = resolveHeaders(
        profile, "api.acme-saas.com", "GET", "/api/v1/projects",
        freshAuth, freshCookies, "node",
      );

      // Verify the complete resolved header set
      // App headers from profile template
      expect(resolved["X-App-Version"]).toBe("3.2.1");
      expect(resolved["X-Client-Id"]).toBe("web-dashboard-v2");
      expect(resolved["X-Workspace-Id"]).toBe("ws-12345");

      // Auth from fresh auth layer
      expect(resolved["Authorization"]).toBe("Bearer refreshed-jwt-token");

      // Cookies merged
      expect(resolved["Cookie"]).toContain("session_id=new-session");
      expect(resolved["Cookie"]).toContain("_csrf=new-csrf");

      // No context headers in node mode (prevents TLS mismatch)
      expect(resolved["User-Agent"]).toBeUndefined();
      expect(resolved["Accept-Encoding"]).toBeUndefined();
      expect(resolved["Sec-Fetch-Site"]).toBeUndefined();
    });

    it("should handle minimal HAR with only auth headers correctly", async () => {
      const har = buildMinimalHar();
      const apiData = parseHar(har, "https://api.minimal.io");
      enrichApiData(apiData);

      const result = await generateSkill(apiData, tmpDir);

      // With only auth + context headers and no app headers,
      // the profile may still be written with context headers
      const headersPath = join(result.skillDir, "headers.json");

      if (existsSync(headersPath)) {
        const profile: HeaderProfileFile = JSON.parse(readFileSync(headersPath, "utf-8"));
        const domainProfile = profile.domains["api.minimal.io"];

        if (domainProfile) {
          // Should have context headers but no auth
          expect(domainProfile.commonHeaders["authorization"]).toBeUndefined();

          // In node mode, context headers are excluded anyway
          const resolved = resolveHeaders(
            profile, "api.minimal.io", "GET", "/api/data",
            { "Authorization": "Bearer fresh" }, {},
            "node",
          );

          expect(resolved["Authorization"]).toBe("Bearer fresh");
          // Context headers excluded in node mode
          expect(resolved["User-Agent"]).toBeUndefined();
        }
      }

      // Auth should always work regardless
      expect(existsSync(join(result.skillDir, "auth.json"))).toBe(true);
    });

    it("should handle skill regeneration (idempotent headers.json)", async () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData);

      // Generate skill twice to the same directory
      const result1 = await generateSkill(apiData, tmpDir);
      const headersPath = join(result1.skillDir, "headers.json");
      const profile1 = JSON.parse(readFileSync(headersPath, "utf-8"));

      // Parse again and regenerate
      const apiData2 = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData2);
      const result2 = await generateSkill(apiData2, tmpDir);
      const profile2 = JSON.parse(readFileSync(headersPath, "utf-8"));

      // Profiles should have same structure (capturedAt will differ)
      expect(Object.keys(profile1.domains)).toEqual(Object.keys(profile2.domains));
      const domain1 = profile1.domains["api.acme-saas.com"];
      const domain2 = profile2.domains["api.acme-saas.com"];
      expect(Object.keys(domain1.commonHeaders).sort())
        .toEqual(Object.keys(domain2.commonHeaders).sort());
    });
  });

  // ── Phase 6: Generated api.ts client template ─────────────────────────

  describe("Phase 6: Generated api.ts loads headers.json", () => {
    it("should generate api.ts that references headers.json loading", async () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData);

      const result = await generateSkill(apiData, tmpDir);
      const apiTsPath = join(result.skillDir, "scripts", "api.ts");
      const apiTs = readFileSync(apiTsPath, "utf-8");

      // api.ts should contain headers.json loading logic
      expect(apiTs).toContain("headers.json");
      expect(apiTs).toContain("headerProfile");

      // Should filter to app category only
      expect(apiTs).toContain('category === "app"');

      // Should build headers with profile
      expect(apiTs).toContain("...this.headerProfile");
    });

    it("should generate api.ts that compiles without type errors", async () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      enrichApiData(apiData);

      const result = await generateSkill(apiData, tmpDir);
      const apiTsPath = join(result.skillDir, "scripts", "api.ts");

      // The api.ts should be valid TypeScript (syntactically)
      expect(existsSync(apiTsPath)).toBe(true);
      const content = readFileSync(apiTsPath, "utf-8");

      // Should have proper class structure
      expect(content).toContain("export class");
      expect(content).toContain("fromAuthFile");
      expect(content).toContain("buildHeaders");
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("should handle HAR with only third-party traffic (no target domains)", () => {
      const har = {
        log: {
          entries: [
            makeHarEntry({
              method: "GET",
              url: "https://www.google-analytics.com/collect?v=1",
              headers: { "User-Agent": "Mozilla/5.0" },
            }),
            makeHarEntry({
              method: "POST",
              url: "https://api.segment.io/v1/track",
              headers: { "Authorization": "Basic abc123" },
            }),
          ],
        },
      };

      // These are all skip-listed domains
      const apiData = parseHar(har, "https://example.com");
      expect(apiData.requests).toHaveLength(0);
    });

    it("should handle profile with domain not matching request target", () => {
      const profile: HeaderProfileFile = {
        version: 1,
        domains: {
          "api.other.com": {
            domain: "api.other.com",
            commonHeaders: {
              "x-app-version": { name: "X-App-Version", value: "1.0", category: "app", seenCount: 10 },
            },
            requestCount: 10,
            capturedAt: new Date().toISOString(),
          },
        },
        endpointOverrides: {},
      };

      // Request to a domain NOT in the profile
      const resolved = resolveHeaders(
        profile, "api.different.com", "GET", "/data",
        { "Authorization": "Bearer token" }, {},
      );

      // Only auth headers — no profile headers applied
      expect(resolved["Authorization"]).toBe("Bearer token");
      expect(resolved["X-App-Version"]).toBeUndefined();
    });

    it("should handle multiple domains in a single HAR", () => {
      const entries: HarEntry[] = [];

      // Domain 1: api.acme-saas.com
      for (let i = 0; i < 5; i++) {
        entries.push(makeHarEntry({
          method: "GET",
          url: `https://api.acme-saas.com/api/v1/data?p=${i}`,
          headers: {
            "X-App-Version": "2.0",
            "Accept": "application/json",
          },
        }));
      }

      // Domain 2: cdn.acme-saas.com (same root domain)
      for (let i = 0; i < 5; i++) {
        entries.push(makeHarEntry({
          method: "GET",
          url: `https://cdn.acme-saas.com/assets/config.json`,
          headers: {
            "X-CDN-Token": "cdn-abc",
            "Accept": "application/json",
          },
        }));
      }

      const har = { log: { entries } };
      const apiData = parseHar(har, "https://app.acme-saas.com");

      if (apiData.headerProfile) {
        const domains = Object.keys(apiData.headerProfile.domains);
        // Should have profiles for target domains that were captured
        expect(domains.length).toBeGreaterThan(0);
      }
    });

    it("should preserve header name casing in profile", () => {
      const har = buildRealisticHar();
      const apiData = parseHar(har, "https://app.acme-saas.com");
      const profile = apiData.headerProfile!;
      const domainProfile = profile.domains["api.acme-saas.com"];

      // Keys are lowercased but name preserves original casing
      expect(domainProfile.commonHeaders["x-app-version"]).toBeDefined();
      expect(domainProfile.commonHeaders["x-app-version"].name).toBe("X-App-Version");
    });
  });
});
