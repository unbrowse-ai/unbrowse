import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("findExistingSkillForDomain intent compatibility", () => {
  test("search captures do not reuse unrelated root/feed skills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unbrowse-skill-cache-"));
    mkdirSync(dir, { recursive: true });
    const prev = process.env.UNBROWSE_SKILL_CACHE_DIR;
    process.env.UNBROWSE_SKILL_CACHE_DIR = dir;

    writeFileSync(join(dir, "feed.json"), JSON.stringify({
      skill_id: "feed-skill",
      domain: "www.linkedin.com",
      execution_type: "http",
      intent_signature: "get feed",
      intents: ["get feed"],
      endpoints: [],
    }));
    writeFileSync(join(dir, "people.json"), JSON.stringify({
      skill_id: "people-skill",
      domain: "www.linkedin.com",
      execution_type: "http",
      intent_signature: "search people",
      intents: ["search people"],
      endpoints: [],
    }));

    const { findExistingSkillForDomain } = await import("../src/client/index.js");
    const found = findExistingSkillForDomain("www.linkedin.com", "search people");
    expect(found?.skill_id).toBe("people-skill");

    if (prev == null) delete process.env.UNBROWSE_SKILL_CACHE_DIR;
    else process.env.UNBROWSE_SKILL_CACHE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test("intent-scoped lookup returns null when only unrelated domain skills exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unbrowse-skill-cache-"));
    mkdirSync(dir, { recursive: true });
    const prev = process.env.UNBROWSE_SKILL_CACHE_DIR;
    process.env.UNBROWSE_SKILL_CACHE_DIR = dir;

    writeFileSync(join(dir, "feed.json"), JSON.stringify({
      skill_id: "feed-skill",
      domain: "www.linkedin.com",
      execution_type: "http",
      intent_signature: "get feed",
      intents: ["get feed"],
      endpoints: [],
    }));

    const { findExistingSkillForDomain } = await import("../src/client/index.js");
    const found = findExistingSkillForDomain("www.linkedin.com", "search people");
    expect(found).toBeNull();

    if (prev == null) delete process.env.UNBROWSE_SKILL_CACHE_DIR;
    else process.env.UNBROWSE_SKILL_CACHE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
});
