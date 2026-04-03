import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillManifest } from "../src/types/index.js";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];
const originalLocalOnly = process.env.UNBROWSE_LOCAL_ONLY;
const originalConfigDir = process.env.UNBROWSE_CONFIG_DIR;

function makeBrowserCaptureSkill(intent = "search hacker news"): SkillManifest {
  const now = new Date().toISOString();
  return {
    skill_id: "browser-capture",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "browser-capture",
    created_at: now,
    updated_at: now,
    name: "browser-capture",
    intent_signature: intent,
    domain: "hn.algolia.com",
    description: "browser capture skill",
    owner_type: "agent",
    endpoints: [],
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalOnly == null) delete process.env.UNBROWSE_LOCAL_ONLY;
  else process.env.UNBROWSE_LOCAL_ONLY = originalLocalOnly;
  if (originalConfigDir == null) delete process.env.UNBROWSE_CONFIG_DIR;
  else process.env.UNBROWSE_CONFIG_DIR = originalConfigDir;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow artifact persistence for seeded flows", () => {
  it("writes a workflow artifact for canonical structured replay seeds", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unbrowse-workflow-seeded-"));
    tempDirs.push(tmp);
    process.env.UNBROWSE_LOCAL_ONLY = "1";
    process.env.UNBROWSE_CONFIG_DIR = tmp;

    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/v1/validate")) {
        return new Response(JSON.stringify({ valid: true, hardErrors: [], softWarnings: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v1/skills")) {
        return new Response(JSON.stringify({
          skill_id: "seeded-skill",
          version: "1.0.0",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          warnings: [],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(url).toContain("https://hn.algolia.com/api/v1/search?query=openai&tags=story");
      return new Response(JSON.stringify({
        hits: [{ title: "OpenAI story", url: "https://example.com/openai", author: "tester" }],
        nbHits: 1,
        page: 0,
        hitsPerPage: 20,
        processingTimeMS: 1,
        query: "openai",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const { executeSkill } = await import(`../src/execution/index.js?workflow-seeded=${Date.now()}`);
    const result = await executeSkill(makeBrowserCaptureSkill(), {
      url: "https://hn.algolia.com/",
      intent: "search hacker news",
      q: "openai",
      cookies: [{ name: "session", value: "seeded", domain: ".hn.algolia.com" }],
    });

    expect(result.trace.success).toBe(true);
    expect((result.result as Record<string, unknown>).seeded_from).toBe("canonical_document");

    const artifactDir = join(tmp, "workflow-artifacts");
    const files = readdirSync(artifactDir).filter((entry) => entry.endsWith(".json"));
    expect(files.length).toBe(1);

    const artifact = JSON.parse(readFileSync(join(artifactDir, files[0]!), "utf-8")) as {
      domain: string;
      evidence: { observed_request_urls: string[] };
      recipes: Array<{ steps: Array<{ strategy: string }> }>;
    };
    expect(artifact.domain).toBe("algolia.com");
    expect(artifact.evidence.observed_request_urls[0]).toContain("/api/v1/search");
    expect(artifact.recipes[0]?.steps.some((step) => step.strategy === "server")).toBe(true);

    const exportDir = join(tmp, "workflow-exports");
    const exportFiles = readdirSync(exportDir).filter((entry) => entry.endsWith(".json"));
    expect(exportFiles.length).toBe(1);
  });
});
