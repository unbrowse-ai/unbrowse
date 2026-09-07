import { describe, expect, test } from "bun:test";
import { publishSkill } from "../src/client/index.js";

describe("publishSkill", () => {
  test("skips remote publish for empty endpoint drafts", async () => {
    const published = await publishSkill({
      skill_id: "empty-skill",
      version: "1.0.0",
      domain: "example.com",
      intent_signature: "get nothing",
      description: "empty test",
      execution_type: "http",
      auth_profile_ref: null,
      endpoints: [],
      intents: ["get nothing"],
      examples: [],
      lifecycle: "active",
      operation_graph: { operations: [], edges: [] },
    } as any);

    expect(published.skill_id).toBe("empty-skill");
    expect(published.endpoints).toEqual([]);
    expect(published.warnings).toContain("skipped_publish_empty_endpoints");
  });
});
