import { describe, expect, it } from "bun:test";
import { buildCanonicalDocumentEndpoint } from "../src/execution/index.js";
import { hasUsableEndpoints, shouldBypassLiveCaptureQueue } from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

describe("canonical live-capture fast path", () => {
  it("bypasses queue for reddit canonical document routes", () => {
    expect(shouldBypassLiveCaptureQueue("https://www.reddit.com/r/programming/")).toBe(true);
    expect(shouldBypassLiveCaptureQueue("https://www.reddit.com/search/?q=openai")).toBe(true);
  });

  it("keeps normal queueing for non-canonical routes", () => {
    expect(shouldBypassLiveCaptureQueue("https://x.com/OpenAI")).toBe(false);
    expect(shouldBypassLiveCaptureQueue("https://www.linkedin.com/search/results/people/?keywords=openai")).toBe(false);
  });

  it("treats canonical replay endpoints as usable", () => {
    const endpoint = buildCanonicalDocumentEndpoint("https://www.npmjs.com/package/express", "get package info");
    if (!endpoint) throw new Error("expected canonical endpoint");
    const skill: SkillManifest = {
      skill_id: "skill-canonical",
      version: "1.0.0",
      schema_version: "1",
      name: "npmjs",
      lifecycle: "active",
      intent_signature: "get package info",
      domain: "npmjs.com",
      description: "test skill",
      execution_type: "http",
      owner_type: "agent",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      endpoints: [endpoint],
      operation_graph: { version: "1", operations: [], edges: [] },
      intents: ["get package info"],
    };
    expect(hasUsableEndpoints(skill)).toBe(true);
  });
});
