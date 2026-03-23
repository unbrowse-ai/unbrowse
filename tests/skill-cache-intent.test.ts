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

  test("path-scoped lookup does not reuse a different entity page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unbrowse-skill-cache-"));
    mkdirSync(dir, { recursive: true });
    const prev = process.env.UNBROWSE_SKILL_CACHE_DIR;
    process.env.UNBROWSE_SKILL_CACHE_DIR = dir;

    writeFileSync(join(dir, "openclaw.json"), JSON.stringify({
      skill_id: "openclaw-skill",
      domain: "lu.ma",
      execution_type: "http",
      intent_signature: "register RSVP for this event",
      intents: ["register RSVP for this event"],
      endpoints: [{
        endpoint_id: "event-page",
        method: "GET",
        url_template: "https://luma.com/sgszalnv",
        trigger_url: "https://luma.com/sgszalnv",
      }],
    }));

    const { findExistingSkillForDomain } = await import("../src/client/index.js");
    const found = findExistingSkillForDomain(
      "lu.ma",
      "register RSVP for this event",
      "https://lu.ma/sgaifoundersdinner",
    );
    expect(found).toBeNull();

    if (prev == null) delete process.env.UNBROWSE_SKILL_CACHE_DIR;
    else process.env.UNBROWSE_SKILL_CACHE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test("path-scoped lookup reuses the matching entity page across canonical hosts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unbrowse-skill-cache-"));
    mkdirSync(dir, { recursive: true });
    const prev = process.env.UNBROWSE_SKILL_CACHE_DIR;
    process.env.UNBROWSE_SKILL_CACHE_DIR = dir;

    writeFileSync(join(dir, "event.json"), JSON.stringify({
      skill_id: "event-skill",
      domain: "lu.ma",
      execution_type: "http",
      intent_signature: "register RSVP for this event",
      intents: ["register RSVP for this event"],
      endpoints: [{
        endpoint_id: "event-page",
        method: "GET",
        url_template: "https://luma.com/sgaifoundersdinner",
        trigger_url: "https://luma.com/sgaifoundersdinner",
      }],
    }));

    const { findExistingSkillForDomain } = await import("../src/client/index.js");
    const found = findExistingSkillForDomain(
      "lu.ma",
      "register RSVP for this event",
      "https://lu.ma/sgaifoundersdinner",
    );
    expect(found?.skill_id).toBe("event-skill");

    if (prev == null) delete process.env.UNBROWSE_SKILL_CACHE_DIR;
    else process.env.UNBROWSE_SKILL_CACHE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
});
