// Regression test: `unbrowse resolve --domain <d>` must find a skill this
// machine already captured, even though it was never published to the
// marketplace (the backend has no visibility into unpublished local
// captures at all). Reproduces the bug reported in this session: resolve
// against a domain with a real, populated local skill-cache entry returned
// 0 candidates and fell through to web search every time.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { localShortlistForDomain } from "../src/cli-v7/eval/resolve.js";
import type { SkillManifest } from "../src/types/skill.js";

let dir: string;
let prevDir: string | undefined;

function skillFixture(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: "test-skill-1",
    version: "1.0.0",
    schema_version: "1",
    name: "example.com",
    intent_signature: "browse example.com",
    domain: "example.com",
    description: "test skill",
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    endpoints: [
      {
        endpoint_id: "ep-safe",
        method: "GET",
        url_template: "https://example.com/page",
        description: "Page content",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.7,
      },
      {
        endpoint_id: "ep-unsafe",
        method: "POST",
        url_template: "https://example.com/submit",
        description: "Mutating endpoint",
        idempotency: "unsafe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
    ],
    ...overrides,
  } as SkillManifest;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unbrowse-eval-resolve-local-cache-"));
  prevDir = process.env.UNBROWSE_SKILL_CACHE_DIR;
  process.env.UNBROWSE_SKILL_CACHE_DIR = dir;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.UNBROWSE_SKILL_CACHE_DIR;
  else process.env.UNBROWSE_SKILL_CACHE_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("localShortlistForDomain", () => {
  test("finds a locally-cached skill for a matching domain", () => {
    writeFileSync(join(dir, "test-skill-1.json"), JSON.stringify(skillFixture()));
    const shortlist = localShortlistForDomain("example.com", 10);
    expect(shortlist.length).toBe(1);
    expect(shortlist[0]).toMatchObject({
      skill_id: "test-skill-1",
      endpoint_id: "ep-safe",
      url: "https://example.com/page",
      source: "local_cache",
    });
  });

  test("excludes unsafe (mutating) endpoints — resolve only auto-executes safe GETs", () => {
    writeFileSync(join(dir, "test-skill-1.json"), JSON.stringify(skillFixture()));
    const shortlist = localShortlistForDomain("example.com", 10);
    expect(shortlist.some((e) => e.endpoint_id === "ep-unsafe")).toBe(false);
  });

  test("returns empty for a domain with no local capture", () => {
    writeFileSync(join(dir, "test-skill-1.json"), JSON.stringify(skillFixture()));
    expect(localShortlistForDomain("other-domain.com", 10)).toEqual([]);
  });

  test("matches by registrable domain, not exact subdomain string", () => {
    writeFileSync(
      join(dir, "test-skill-1.json"),
      JSON.stringify(skillFixture({ domain: "www.example.com" })),
    );
    const shortlist = localShortlistForDomain("example.com", 10);
    expect(shortlist.length).toBe(1);
  });

  test("respects the limit parameter", () => {
    writeFileSync(join(dir, "test-skill-1.json"), JSON.stringify(skillFixture()));
    writeFileSync(
      join(dir, "test-skill-2.json"),
      JSON.stringify(skillFixture({ skill_id: "test-skill-2" })),
    );
    expect(localShortlistForDomain("example.com", 1).length).toBe(1);
  });
});
