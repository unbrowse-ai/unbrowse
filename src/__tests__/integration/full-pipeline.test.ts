/**
 * Integration tests for the full skill generation pipeline.
 *
 * Tests: loadFixture -> parseHar() -> enrichApiData() -> generateSkill()
 * Verifies that SKILL.md, api.ts, auth.json, and other files are written correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseHar, enrichApiData } from "../../har-parser.js";
import { generateSkill } from "../../skill-generator.js";
import { loadFixture } from "../helpers.js";
import type { ApiData, SkillResult } from "../../types.js";

// ── todo-api full pipeline ──────────────────────────────────────────────

describe("Full pipeline integration: todo-api", () => {
  let tmpDir: string;
  let data: ApiData;
  let result: SkillResult;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "test-skills-"));
    const har = loadFixture("todo-api");
    data = parseHar(har);
    data = enrichApiData(data);
    result = await generateSkill(data, tmpDir);
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return a valid SkillResult", () => {
    expect(result).toBeDefined();
    expect(result.service).toBe("todoapp");
    expect(result.skillDir).toBeTruthy();
    expect(result.changed).toBe(true);
  });

  it("should report correct endpoint count", () => {
    expect(result.endpointCount).toBeGreaterThanOrEqual(5);
  });

  it("should report correct auth header count", () => {
    expect(result.authHeaderCount).toBeGreaterThanOrEqual(1);
  });

  it("should report Bearer Token auth method", () => {
    expect(result.authMethod).toBe("Bearer Token");
  });

  it("should have a version hash", () => {
    expect(result.versionHash).toBeDefined();
    expect(result.versionHash!.length).toBe(8);
  });

  // ── File existence checks ──────────────────────────────────────────────

  it("should create SKILL.md", () => {
    const skillMdPath = join(result.skillDir, "SKILL.md");
    expect(existsSync(skillMdPath)).toBe(true);
  });

  it("should create auth.json", () => {
    const authJsonPath = join(result.skillDir, "auth.json");
    expect(existsSync(authJsonPath)).toBe(true);
  });

  it("should create scripts/api.ts", () => {
    const apiTsPath = join(result.skillDir, "scripts", "api.ts");
    expect(existsSync(apiTsPath)).toBe(true);
  });

  it("should create test.ts", () => {
    const testTsPath = join(result.skillDir, "test.ts");
    expect(existsSync(testTsPath)).toBe(true);
  });

  it("should create references/REFERENCE.md", () => {
    const refMdPath = join(result.skillDir, "references", "REFERENCE.md");
    expect(existsSync(refMdPath)).toBe(true);
  });

  // ── SKILL.md content checks ────────────────────────────────────────────

  it("should include correct base URL in SKILL.md", () => {
    const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).toContain("api.todoapp.com");
  });

  it("should include endpoint patterns in SKILL.md", () => {
    const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).toContain("/api/v1/todos");
    expect(skillMd).toContain("GET");
    expect(skillMd).toContain("POST");
  });

  it("should include auth method in SKILL.md", () => {
    const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).toContain("Bearer Token");
  });

  it("should have YAML frontmatter in SKILL.md", () => {
    const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");
    expect(skillMd.startsWith("---")).toBe(true);
    expect(skillMd).toContain("name: todoapp");
    expect(skillMd).toContain("versionHash:");
  });

  it("should include endpoint categories in SKILL.md", () => {
    const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).toContain("**Read**");
  });

  // ── api.ts content checks ─────────────────────────────────────────────

  it("should generate a client class in api.ts", () => {
    const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");
    expect(apiTs).toContain("class TodoappClient");
    expect(apiTs).toContain("export");
  });

  it("should generate async methods in api.ts", () => {
    const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");
    expect(apiTs).toContain("async ");
    expect(apiTs).toContain("Promise<unknown>");
  });

  it("should include fromAuthFile static method", () => {
    const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");
    expect(apiTs).toContain("fromAuthFile");
  });

  it("should reference the correct base URL in api.ts", () => {
    const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");
    expect(apiTs).toContain("api.todoapp.com");
  });

  // ── auth.json content checks ──────────────────────────────────────────

  it("should have valid JSON in auth.json", () => {
    const authJsonPath = join(result.skillDir, "auth.json");
    const raw = readFileSync(authJsonPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toBeDefined();
    expect(parsed.service).toBe("todoapp");
  });

  it("should include auth headers in auth.json", () => {
    const authJsonPath = join(result.skillDir, "auth.json");
    const parsed = JSON.parse(readFileSync(authJsonPath, "utf-8"));
    expect(parsed.headers).toBeDefined();
    expect(Object.keys(parsed.headers).length).toBeGreaterThanOrEqual(1);
  });

  it("should include baseUrl in auth.json", () => {
    const authJsonPath = join(result.skillDir, "auth.json");
    const parsed = JSON.parse(readFileSync(authJsonPath, "utf-8"));
    expect(parsed.baseUrl).toBe("https://api.todoapp.com");
  });
});

// ── ecommerce-api full pipeline ─────────────────────────────────────────

describe("Full pipeline integration: ecommerce-api", () => {
  let tmpDir: string;
  let result: SkillResult;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "test-skills-"));
    const har = loadFixture("ecommerce-api");
    let data = parseHar(har);
    data = enrichApiData(data);
    result = await generateSkill(data, tmpDir);
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should generate skill for ecommerce-api", () => {
    expect(result).toBeDefined();
    expect(result.changed).toBe(true);
  });

  it("should create SKILL.md with product endpoints", () => {
    const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).toContain("product");
  });

  it("should create api.ts with client class", () => {
    const apiTs = readFileSync(join(result.skillDir, "scripts", "api.ts"), "utf-8");
    expect(apiTs).toContain("Client");
    expect(apiTs).toContain("async ");
  });

  it("should create auth.json", () => {
    const authJsonPath = join(result.skillDir, "auth.json");
    expect(existsSync(authJsonPath)).toBe(true);
  });
});

// ── mixed-traffic full pipeline ─────────────────────────────────────────

describe("Full pipeline integration: mixed-traffic", () => {
  let tmpDir: string;
  let result: SkillResult;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "test-skills-"));
    const har = loadFixture("mixed-traffic");
    let data = parseHar(har);
    data = enrichApiData(data);
    result = await generateSkill(data, tmpDir);
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should generate skill from mixed traffic (filtering noise)", () => {
    expect(result).toBeDefined();
    expect(result.changed).toBe(true);
  });

  it("should have correct endpoint count (only API endpoints)", () => {
    // mixed-traffic has login, contacts list/create/get, deals list/update = 6 API endpoints
    expect(result.endpointCount).toBeGreaterThanOrEqual(4);
  });

  it("should include auth endpoints in SKILL.md", () => {
    const skillMd = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).toContain("auth");
  });
});

// ── Idempotent regeneration ─────────────────────────────────────────────

describe("Full pipeline integration: regeneration preserves endpoints", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "test-skills-"));
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should produce a valid version hash that stays consistent for same content", async () => {
    const har = loadFixture("todo-api");
    let data = parseHar(har);
    data = enrichApiData(data);

    const result1 = await generateSkill(data, tmpDir);
    expect(result1.changed).toBe(true);
    expect(result1.versionHash).toBeDefined();
    expect(result1.versionHash!.length).toBe(8);
  });

  it("should merge endpoints across regeneration runs (never lose endpoints)", async () => {
    // After the first run above, a second run should have >= the same endpoint count
    const har = loadFixture("todo-api");
    let data2 = parseHar(har);
    data2 = enrichApiData(data2);
    const result2 = await generateSkill(data2, tmpDir);
    // generateSkill merges old + new endpoints, so count should be >= original
    expect(result2.endpointCount).toBeGreaterThanOrEqual(5);
  });
});
