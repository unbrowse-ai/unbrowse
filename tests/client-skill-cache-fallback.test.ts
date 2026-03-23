import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function loadClientModule() {
  return import(`../src/client/index.ts?test=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  globalThis.fetch = ORIGINAL_FETCH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("client getSkill cache fallback", () => {
  it("returns the locally cached skill when the backend lookup misses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unbrowse-skill-cache-fallback-"));
    tempDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    process.env.UNBROWSE_SKILL_CACHE_DIR = dir;
    process.env.UNBROWSE_API_KEY = "test-key";

    writeFileSync(join(dir, "local-skill.json"), JSON.stringify({
      skill_id: "local-skill",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      name: "example.com",
      intent_signature: "search example",
      domain: "example.com",
      description: "cached local skill",
      owner_type: "agent",
      endpoints: [],
      intents: ["search example"],
      operation_graph: { operations: [], edges: [] },
    }));

    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v1/skills/local-skill")) {
        return jsonResponse({ error: "Skill not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { getSkill } = await loadClientModule();
    const skill = await getSkill("local-skill");

    expect(skill?.skill_id).toBe("local-skill");
    expect(skill?.description).toBe("cached local skill");
  });
});
