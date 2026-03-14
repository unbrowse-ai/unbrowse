import { describe, expect, it } from "bun:test";
import { executeSkill } from "../src/execution/index.js";
import type { SkillManifest } from "../src/types/index.js";

function makeSkill(): SkillManifest {
  const now = new Date().toISOString();
  return {
    skill_id: "skill-action",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: now,
    updated_at: now,
    name: "action-skill",
    intent_signature: "create note",
    domain: "example.com",
    description: "action skill",
    owner_type: "agent",
    endpoints: [
      {
        endpoint_id: "create-note",
        method: "POST",
        url_template: "https://example.com/api/notes",
        body: {
          title: "{title}",
          description: "{description}",
          completed: false,
        },
        body_params: {
          title: "hello",
          description: "world",
        },
        idempotency: "unsafe",
        verification_status: "verified",
        reliability_score: 1,
      },
    ],
  };
}

describe("execution body param defaults", () => {
  it("uses reverse-engineered body param defaults during dry run", async () => {
    const out = await executeSkill(makeSkill(), {}, undefined, { dry_run: true });
    expect((out.result as Record<string, unknown>).dry_run).toBe(true);
    expect((out.result as Record<string, any>).would_execute.body).toEqual({
      title: "hello",
      description: "world",
      completed: false,
    });
  });
});
