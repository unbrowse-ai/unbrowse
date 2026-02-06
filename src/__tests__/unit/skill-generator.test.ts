/**
 * Unit tests for skill-generator.ts
 *
 * Tests the exported pure functions:
 *   - generateVersionHash()
 *   - extractVersionInfo()
 *
 * Tests internal helpers indirectly through generateSkill() output:
 *   - toPascalCase, endpointDesc, descToMethodName
 *   - categoryBadge, sortEndpointGroups
 *   - generateSkillMd, generateApiTs, generateAuthJson
 *   - parseExistingEndpoints (via merge behavior)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { generateVersionHash, extractVersionInfo, generateSkill } from "../../skill-generator.js";
import { makeApiData } from "../helpers.js";
import type { EndpointGroup, ApiData } from "../../types.js";

// ── generateVersionHash ─────────────────────────────────────────────────────

describe("generateVersionHash", () => {
  it("returns consistent hash for same inputs", () => {
    const skillMd = "# My Skill\nSome content";
    const scripts = { "api.ts": "export class Foo {}" };
    const references = { "REFERENCE.md": "# Ref" };

    const hash1 = generateVersionHash(skillMd, scripts, references);
    const hash2 = generateVersionHash(skillMd, scripts, references);

    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different inputs", () => {
    const hash1 = generateVersionHash("V1", { "api.ts": "v1" }, { "R.md": "r1" });
    const hash2 = generateVersionHash("V2", { "client.ts": "v2" }, { "G.md": "r2" });

    expect(hash1).not.toBe(hash2);
  });

  it("returns an 8-character hex string", () => {
    const hash = generateVersionHash("content", {}, {});
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles empty inputs", () => {
    const hash = generateVersionHash("", {}, {});
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles multiple scripts and references", () => {
    const hash = generateVersionHash(
      "# Skill",
      { "api.ts": "code", "types.d.ts": "types" },
      { "REFERENCE.md": "ref", "EXTRA.md": "extra" },
    );
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces distinct hashes when only values differ (regression: Object.keys replacer bug)", () => {
    // When Object.keys was used as JSON.stringify replacer, all values were stripped
    // and every input produced the same hash. Verify values affect the hash.
    const hash1 = generateVersionHash("same", { "api.ts": "AAA" }, {});
    const hash2 = generateVersionHash("same", { "api.ts": "BBB" }, {});

    expect(hash1).not.toBe(hash2);
  });
});

// ── extractVersionInfo ──────────────────────────────────────────────────────

describe("extractVersionInfo", () => {
  it("extracts version from markdown with YAML frontmatter", () => {
    const skillMd = `---
name: test-api
metadata:
  version: "1.0"
  versionHash: "abc12345"
---
# Test API`;

    const info = extractVersionInfo(skillMd);
    expect(info.version).toBe("1.0");
    expect(info.versionHash).toBe("abc12345");
  });

  it("extracts version without quotes", () => {
    const skillMd = `---
  version: 2.1
  versionHash: deadbeef
---`;

    const info = extractVersionInfo(skillMd);
    expect(info.version).toBe("2.1");
    expect(info.versionHash).toBe("deadbeef");
  });

  it("returns undefined when no version present", () => {
    const skillMd = `# Just a Markdown File

No frontmatter here.`;

    const info = extractVersionInfo(skillMd);
    expect(info.version).toBeUndefined();
    expect(info.versionHash).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const info = extractVersionInfo("");
    expect(info.version).toBeUndefined();
    expect(info.versionHash).toBeUndefined();
  });

  it("extracts version with leading spaces (indented YAML)", () => {
    const skillMd = `---
name: my-skill
metadata:
  author: unbrowse
  version: "3.0"
  versionHash: "ff00ff00"
---`;

    const info = extractVersionInfo(skillMd);
    expect(info.version).toBe("3.0");
    expect(info.versionHash).toBe("ff00ff00");
  });

  it("handles version without versionHash", () => {
    const skillMd = `  version: "1.5"`;

    const info = extractVersionInfo(skillMd);
    expect(info.version).toBe("1.5");
    expect(info.versionHash).toBeUndefined();
  });

  it("handles versionHash without version", () => {
    const skillMd = `  versionHash: "abcd1234"`;

    const info = extractVersionInfo(skillMd);
    expect(info.version).toBeUndefined();
    expect(info.versionHash).toBe("abcd1234");
  });
});

// ── generateSkill (indirectly tests internal helpers) ───────────────────────

describe("generateSkill", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `skill-gen-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  // Helper to build a minimal EndpointGroup
  function makeEndpointGroup(overrides: Partial<EndpointGroup> = {}): EndpointGroup {
    return {
      method: "GET",
      normalizedPath: "/api/v1/items",
      description: "List items",
      category: "read",
      pathParams: [],
      queryParams: [],
      responseSummary: "array[10]",
      exampleCount: 3,
      dependencies: [],
      produces: [],
      consumes: [],
      ...overrides,
    };
  }

  describe("basic skill generation", () => {
    it("creates skill directory with expected files", async () => {
      const data = makeApiData({
        service: "my-test-api",
        baseUrl: "https://api.example.com",
        authHeaders: { Authorization: "Bearer token123" },
        authMethod: "Bearer Token",
        cookies: { session: "abc" },
        endpoints: {
          "GET /api/items": [
            {
              method: "GET",
              url: "https://api.example.com/api/items",
              path: "/api/items",
              domain: "api.example.com",
              status: 200,
            },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);

      expect(result.service).toBe("my-test-api");
      expect(result.endpointCount).toBeGreaterThanOrEqual(1);
      expect(result.authHeaderCount).toBe(1);
      expect(result.cookieCount).toBe(1);
      expect(result.authMethod).toBe("Bearer Token");
      expect(result.changed).toBe(true);

      // Verify files were created
      const skillDir = result.skillDir;
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(skillDir, "auth.json"))).toBe(true);
      expect(existsSync(join(skillDir, "scripts", "api.ts"))).toBe(true);
      expect(existsSync(join(skillDir, "test.ts"))).toBe(true);
      expect(existsSync(join(skillDir, "references", "REFERENCE.md"))).toBe(true);
    });

    it("returns a valid versionHash", async () => {
      const data = makeApiData({
        service: "hash-test",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /items": [
            {
              method: "GET",
              url: "https://api.example.com/items",
              path: "/items",
              domain: "api.example.com",
              status: 200,
            },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);

      expect(result.versionHash).toBeDefined();
      expect(result.versionHash).toHaveLength(8);
      expect(result.versionHash).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe("SKILL.md content (indirectly tests generateSkillMd, toPascalCase, endpointDesc)", () => {
    it("generates markdown with correct title from service name", async () => {
      const data = makeApiData({
        service: "cool-web-app",
        baseUrl: "https://cool.example.com",
        endpoints: {
          "GET /data": [
            {
              method: "GET",
              url: "https://cool.example.com/data",
              path: "/data",
              domain: "cool.example.com",
              status: 200,
            },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      // toPascalCase("cool-web-app") => "CoolWebApp"
      expect(skillMd).toContain("CoolWebAppClient");
      // Title: "Cool Web App"
      expect(skillMd).toContain("# Cool Web App Internal API");
    });

    it("includes base URL and auth method in SKILL.md", async () => {
      const data = makeApiData({
        service: "example-api",
        baseUrl: "https://api.example.com",
        authMethod: "API Key",
        endpoints: {
          "GET /ping": [
            {
              method: "GET",
              url: "https://api.example.com/ping",
              path: "/ping",
              domain: "api.example.com",
              status: 200,
            },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      expect(skillMd).toContain("https://api.example.com");
      expect(skillMd).toContain("API Key");
    });

    it("lists endpoints with method descriptions (endpointDesc)", async () => {
      const data = makeApiData({
        service: "crud-api",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /users": [
            {
              method: "GET",
              url: "https://api.example.com/users",
              path: "/users",
              domain: "api.example.com",
              status: 200,
            },
          ],
          "POST /users": [
            {
              method: "POST",
              url: "https://api.example.com/users",
              path: "/users",
              domain: "api.example.com",
              status: 201,
            },
          ],
          "DELETE /users/1": [
            {
              method: "DELETE",
              url: "https://api.example.com/users/1",
              path: "/users/1",
              domain: "api.example.com",
              status: 204,
            },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      // endpointDesc for GET without path params => "List resources"
      expect(skillMd).toContain("`GET /users` — List resources");
      // endpointDesc for POST => "Create resource"
      expect(skillMd).toContain("`POST /users` — Create resource");
      // endpointDesc for DELETE => "Delete resource"
      expect(skillMd).toContain("`DELETE /users/1` — Delete resource");
    });

    it("shows auth header and cookie counts in SKILL.md", async () => {
      const data = makeApiData({
        service: "auth-api",
        baseUrl: "https://api.example.com",
        authHeaders: { Authorization: "Bearer x", "x-api-key": "key123" },
        cookies: { session: "abc", csrf: "def", uid: "123" },
        endpoints: {
          "GET /me": [
            {
              method: "GET",
              url: "https://api.example.com/me",
              path: "/me",
              domain: "api.example.com",
              status: 200,
            },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      expect(skillMd).toContain("**Auth headers:** 2");
      expect(skillMd).toContain("**Session cookies:** 3");
    });

    it("includes YAML frontmatter with metadata", async () => {
      const data = makeApiData({
        service: "meta-api",
        baseUrl: "https://meta.example.com",
        authMethod: "Cookie",
        endpoints: {
          "GET /health": [
            {
              method: "GET",
              url: "https://meta.example.com/health",
              path: "/health",
              domain: "meta.example.com",
              status: 200,
            },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      expect(skillMd).toMatch(/^---/);
      expect(skillMd).toContain("name: meta-api");
      expect(skillMd).toContain('version: "1.0"');
      expect(skillMd).toContain(`versionHash: "${result.versionHash}"`);
      expect(skillMd).toContain('baseUrl: "https://meta.example.com"');
      expect(skillMd).toContain('authMethod: "Cookie"');
      expect(skillMd).toContain("endpointCount: 1");
      expect(skillMd).toContain('apiType: "internal"');
    });
  });

  describe("endpointGroups (indirectly tests sortEndpointGroups, categoryBadge, descToMethodName)", () => {
    it("generates SKILL.md with grouped endpoints sorted by category", async () => {
      const groups: EndpointGroup[] = [
        makeEndpointGroup({
          method: "DELETE",
          normalizedPath: "/api/v1/items/{itemId}",
          description: "Delete item",
          category: "delete",
        }),
        makeEndpointGroup({
          method: "POST",
          normalizedPath: "/api/v1/items",
          description: "Create item",
          category: "write",
        }),
        makeEndpointGroup({
          method: "POST",
          normalizedPath: "/auth/login",
          description: "Login",
          category: "auth",
        }),
        makeEndpointGroup({
          method: "GET",
          normalizedPath: "/api/v1/items",
          description: "List items",
          category: "read",
        }),
      ];

      const data = makeApiData({
        service: "grouped-api",
        baseUrl: "https://api.example.com",
        endpointGroups: groups,
        endpoints: {
          "POST /auth/login": [
            { method: "POST", url: "https://api.example.com/auth/login", path: "/auth/login", domain: "api.example.com", status: 200 },
          ],
          "GET /api/v1/items": [
            { method: "GET", url: "https://api.example.com/api/v1/items", path: "/api/v1/items", domain: "api.example.com", status: 200 },
          ],
          "POST /api/v1/items": [
            { method: "POST", url: "https://api.example.com/api/v1/items", path: "/api/v1/items", domain: "api.example.com", status: 201 },
          ],
          "DELETE /api/v1/items/{itemId}": [
            { method: "DELETE", url: "https://api.example.com/api/v1/items/1", path: "/api/v1/items/1", domain: "api.example.com", status: 204 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      // sortEndpointGroups sorts by category: auth(0), read(1), write(2), delete(3)
      const authIdx = skillMd.indexOf("**Auth**");
      const readIdx = skillMd.indexOf("**Read**");
      const writeIdx = skillMd.indexOf("**Write**");
      const deleteIdx = skillMd.indexOf("**Delete**");

      expect(authIdx).toBeGreaterThan(-1);
      expect(readIdx).toBeGreaterThan(authIdx);
      expect(writeIdx).toBeGreaterThan(readIdx);
      expect(deleteIdx).toBeGreaterThan(writeIdx);
    });

    it("generates typed methods in api.ts from endpoint groups (descToMethodName)", async () => {
      const groups: EndpointGroup[] = [
        makeEndpointGroup({
          method: "GET",
          normalizedPath: "/users",
          description: "List users",
          category: "read",
        }),
        makeEndpointGroup({
          method: "GET",
          normalizedPath: "/users/{userId}",
          description: "Get a user by ID",
          category: "read",
          pathParams: [{ name: "userId", type: "string", example: "123" }],
        }),
        makeEndpointGroup({
          method: "POST",
          normalizedPath: "/users",
          description: "Create user",
          category: "write",
          requestBodySchema: { name: "string", email: "string" },
        }),
      ];

      const data = makeApiData({
        service: "method-api",
        baseUrl: "https://api.example.com",
        endpointGroups: groups,
        endpoints: {
          "GET /users": [
            { method: "GET", url: "https://api.example.com/users", path: "/users", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");

      // descToMethodName("List users") => "listUsers"
      expect(apiTs).toContain("async listUsers(");
      // descToMethodName("Get a user by ID") => strips "a", "by", "ID" => "Get user" => "getUser"
      expect(apiTs).toContain("async getUser(");
      // descToMethodName("Create user") => "createUser"
      expect(apiTs).toContain("async createUser(");
    });

    it("handles path params in typed methods", async () => {
      const groups: EndpointGroup[] = [
        makeEndpointGroup({
          method: "GET",
          normalizedPath: "/users/{userId}/orders/{orderId}",
          description: "Get user order",
          category: "read",
          pathParams: [
            { name: "userId", type: "string", example: "u123" },
            { name: "orderId", type: "string", example: "o456" },
          ],
        }),
      ];

      const data = makeApiData({
        service: "params-api",
        baseUrl: "https://api.example.com",
        endpointGroups: groups,
        endpoints: {
          "GET /users/{userId}/orders/{orderId}": [
            { method: "GET", url: "https://api.example.com/users/u123/orders/o456", path: "/users/u123/orders/o456", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");

      // Method should take both path params as arguments
      expect(apiTs).toContain("userId: string");
      expect(apiTs).toContain("orderId: string");
      // Path expression uses template literal with interpolation
      expect(apiTs).toContain("${userId}");
      expect(apiTs).toContain("${orderId}");
    });

    it("deduplicates method names in api.ts", async () => {
      const groups: EndpointGroup[] = [
        makeEndpointGroup({
          method: "GET",
          normalizedPath: "/items",
          description: "List items",
          category: "read",
        }),
        makeEndpointGroup({
          method: "GET",
          normalizedPath: "/other-items",
          description: "List items",
          category: "read",
        }),
      ];

      const data = makeApiData({
        service: "dedup-api",
        baseUrl: "https://api.example.com",
        endpointGroups: groups,
        endpoints: {
          "GET /items": [
            { method: "GET", url: "https://api.example.com/items", path: "/items", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");

      // First one keeps its name; second gets a numeric suffix
      expect(apiTs).toContain("async listItems(");
      expect(apiTs).toContain("async listItems2(");
    });

    it("shows endpoint dependencies section when present", async () => {
      const groups: EndpointGroup[] = [
        makeEndpointGroup({
          method: "POST",
          normalizedPath: "/auth/login",
          description: "Login",
          category: "auth",
          dependencies: [],
        }),
        makeEndpointGroup({
          method: "GET",
          normalizedPath: "/api/profile",
          description: "Get profile",
          category: "read",
          dependencies: ["/auth/login"],
        }),
      ];

      const data = makeApiData({
        service: "dep-api",
        baseUrl: "https://api.example.com",
        endpointGroups: groups,
        endpoints: {
          "POST /auth/login": [
            { method: "POST", url: "https://api.example.com/auth/login", path: "/auth/login", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      expect(skillMd).toContain("## Endpoint Dependencies");
      expect(skillMd).toContain("`GET /api/profile` depends on: `/auth/login`");
    });
  });

  describe("api.ts content (indirectly tests generateApiTs, toPascalCase)", () => {
    it("generates a class with PascalCase name from kebab-case service", async () => {
      const data = makeApiData({
        service: "my-cool-api",
        baseUrl: "https://cool.example.com",
        endpoints: {
          "GET /data": [
            { method: "GET", url: "https://cool.example.com/data", path: "/data", domain: "cool.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");

      // toPascalCase("my-cool-api") => "MyCoolApi"
      expect(apiTs).toContain("export class MyCoolApiClient");
      expect(apiTs).toContain("MyCoolApi API Client");
    });

    it("uses correct baseUrl in constructor default", async () => {
      const data = makeApiData({
        service: "base-url-test",
        baseUrl: "https://custom.api.com/v2",
        endpoints: {
          "GET /test": [
            { method: "GET", url: "https://custom.api.com/v2/test", path: "/test", domain: "custom.api.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");

      expect(apiTs).toContain('"https://custom.api.com/v2"');
    });

    it("uses primary auth header in client", async () => {
      const data = makeApiData({
        service: "auth-header-test",
        baseUrl: "https://api.example.com",
        authHeaders: { "x-api-key": "key-value" },
        endpoints: {
          "GET /test": [
            { method: "GET", url: "https://api.example.com/test", path: "/test", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");

      // Primary auth header should be x-api-key
      expect(apiTs).toContain('"x-api-key"');
    });

    it("includes CRUD methods (get, post, put, delete)", async () => {
      const data = makeApiData({
        service: "crud-test",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /test": [
            { method: "GET", url: "https://api.example.com/test", path: "/test", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");

      expect(apiTs).toContain("async get(");
      expect(apiTs).toContain("async post(");
      expect(apiTs).toContain("async put(");
      expect(apiTs).toContain("async delete(");
    });
  });

  describe("auth.json content", () => {
    it("generates valid JSON for auth.json", async () => {
      const data = makeApiData({
        service: "auth-json-test",
        baseUrl: "https://api.example.com",
        authHeaders: { Authorization: "Bearer abc123" },
        cookies: { session: "xyz" },
        endpoints: {
          "GET /test": [
            { method: "GET", url: "https://api.example.com/test", path: "/test", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const authJsonPath = join(result.skillDir, "auth.json");
      const authJsonStr = readFileSync(authJsonPath, "utf-8");
      const authJson = JSON.parse(authJsonStr);

      expect(authJson).toBeDefined();
      expect(typeof authJson).toBe("object");
      // Should contain service info
      expect(authJson.service).toBe("auth-json-test");
      expect(authJson.baseUrl).toBe("https://api.example.com");
    });
  });

  describe("endpoint merging (indirectly tests parseExistingEndpoints)", () => {
    it("merges new endpoints with existing ones from previous SKILL.md", async () => {
      // First generation: one endpoint
      const data1 = makeApiData({
        service: "merge-test",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /users": [
            { method: "GET", url: "https://api.example.com/users", path: "/users", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result1 = await generateSkill(data1, tmpDir);
      const skillMd1 = readFileSync(join(result1.skillDir, "SKILL.md"), "utf-8");
      expect(skillMd1).toContain("`GET /users`");

      // Second generation: different endpoint, same service
      const data2 = makeApiData({
        service: "merge-test",
        baseUrl: "https://api.example.com",
        endpoints: {
          "POST /orders": [
            { method: "POST", url: "https://api.example.com/orders", path: "/orders", domain: "api.example.com", status: 201 },
          ],
        },
      });

      const result2 = await generateSkill(data2, tmpDir);

      // Should have merged both endpoints
      expect(result2.endpointCount).toBe(2);
      const skillMd2 = readFileSync(join(result2.skillDir, "SKILL.md"), "utf-8");
      expect(skillMd2).toContain("`POST /orders`");
      expect(skillMd2).toContain("`GET /users`");
    });

    it("does not duplicate endpoints that exist in both old and new data", async () => {
      const data1 = makeApiData({
        service: "no-dup",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /items": [
            { method: "GET", url: "https://api.example.com/items", path: "/items", domain: "api.example.com", status: 200 },
          ],
        },
      });

      await generateSkill(data1, tmpDir);

      // Regenerate with the same endpoint
      const data2 = makeApiData({
        service: "no-dup",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /items": [
            { method: "GET", url: "https://api.example.com/items", path: "/items", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result2 = await generateSkill(data2, tmpDir);
      expect(result2.endpointCount).toBe(1);
    });
  });

  describe("verified / fromSpec badges", () => {
    it("shows verified badge for verified endpoints", async () => {
      const data = makeApiData({
        service: "badge-test",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /verified": [
            { method: "GET", url: "https://api.example.com/verified", path: "/verified", domain: "api.example.com", status: 200, verified: true },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      // Verified endpoints get a checkmark
      expect(skillMd).toMatch(/`GET \/verified`.*✓/);
    });

    it("shows from-spec badge for fromSpec endpoints", async () => {
      const data = makeApiData({
        service: "spec-test",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /from-spec": [
            { method: "GET", url: "https://api.example.com/from-spec", path: "/from-spec", domain: "api.example.com", status: 200, fromSpec: true },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      expect(skillMd).toMatch(/`GET \/from-spec`.*\[from-spec\]/);
    });
  });

  describe("version tracking", () => {
    it("sets changed to true for new skills", async () => {
      const data = makeApiData({
        service: "new-skill",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /test": [
            { method: "GET", url: "https://api.example.com/test", path: "/test", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      expect(result.changed).toBe(true);
    });

    it("reports diff summary when new endpoints are added", async () => {
      // First: generate with 1 endpoint
      const data1 = makeApiData({
        service: "diff-test",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /a": [
            { method: "GET", url: "https://api.example.com/a", path: "/a", domain: "api.example.com", status: 200 },
          ],
        },
      });
      await generateSkill(data1, tmpDir);

      // Second: generate with 3 endpoints
      const data2 = makeApiData({
        service: "diff-test",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /a": [
            { method: "GET", url: "https://api.example.com/a", path: "/a", domain: "api.example.com", status: 200 },
          ],
          "GET /b": [
            { method: "GET", url: "https://api.example.com/b", path: "/b", domain: "api.example.com", status: 200 },
          ],
          "POST /c": [
            { method: "POST", url: "https://api.example.com/c", path: "/c", domain: "api.example.com", status: 201 },
          ],
        },
      });

      const result2 = await generateSkill(data2, tmpDir);
      expect(result2.diff).toContain("+2 new endpoint(s)");
      expect(result2.diff).toContain("1 → 3");
    });

    it("writes versionHash into SKILL.md frontmatter (replacing placeholder)", async () => {
      const data = makeApiData({
        service: "placeholder-test",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /x": [
            { method: "GET", url: "https://api.example.com/x", path: "/x", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      // The placeholder should have been replaced with the real hash
      expect(skillMd).not.toContain("PLACEHOLDER");
      expect(skillMd).toContain(`versionHash: "${result.versionHash}"`);
    });
  });

  describe("prevents nested directories", () => {
    it("does not create service/service double nesting when outputDir ends with service name", async () => {
      const serviceDir = join(tmpDir, "my-svc");
      mkdirSync(serviceDir, { recursive: true });

      const data = makeApiData({
        service: "my-svc",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /test": [
            { method: "GET", url: "https://api.example.com/test", path: "/test", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, serviceDir);

      // skillDir should be serviceDir itself, not serviceDir/my-svc
      expect(result.skillDir).toBe(serviceDir);
      expect(existsSync(join(serviceDir, "SKILL.md"))).toBe(true);
    });
  });

  describe("query params and body schema in endpoint groups", () => {
    it("includes query and body hints in SKILL.md for groups", async () => {
      const groups: EndpointGroup[] = [
        makeEndpointGroup({
          method: "GET",
          normalizedPath: "/search",
          description: "Search items",
          category: "read",
          queryParams: [
            { name: "q", example: "shoes", required: true },
            { name: "limit", example: "10", required: false },
          ],
        }),
        makeEndpointGroup({
          method: "POST",
          normalizedPath: "/items",
          description: "Create item",
          category: "write",
          requestBodySchema: { name: "string", price: "number" },
        }),
      ];

      const data = makeApiData({
        service: "params-test",
        baseUrl: "https://api.example.com",
        endpointGroups: groups,
        endpoints: {
          "GET /search": [
            { method: "GET", url: "https://api.example.com/search?q=shoes", path: "/search", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      // Query params listed
      expect(skillMd).toContain("`q`");
      expect(skillMd).toContain("`limit`");
      // Body schema fields
      expect(skillMd).toContain("name?:");
      expect(skillMd).toContain("price?:");
    });
  });

  describe("endpointDesc via GET with path params", () => {
    it("uses 'Get resource' for GET endpoints with path parameters", async () => {
      // A GET endpoint with /{id} should get "Get resource" not "List resources"
      const data = makeApiData({
        service: "get-vs-list",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /users/{userId}": [
            { method: "GET", url: "https://api.example.com/users/123", path: "/users/{userId}", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      // endpointDesc for GET with /{ pattern => "Get resource"
      expect(skillMd).toContain("Get resource");
    });

    it("uses 'List resources' for GET endpoints without path parameters", async () => {
      const data = makeApiData({
        service: "list-test",
        baseUrl: "https://api.example.com",
        endpoints: {
          "GET /users": [
            { method: "GET", url: "https://api.example.com/users", path: "/users", domain: "api.example.com", status: 200 },
          ],
        },
      });

      const result = await generateSkill(data, tmpDir);
      const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");

      expect(skillMd).toContain("List resources");
    });
  });
});
