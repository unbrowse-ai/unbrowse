import { describe, expect, it } from "bun:test";
import { promoteExplicitExecution } from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

const baseSkill: SkillManifest = {
  skill_id: "skill-1",
  version: "1.0.0",
  schema_version: "1",
  lifecycle: "active",
  execution_type: "http",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  name: "linkedin.com",
  intent_signature: "get company info",
  domain: "linkedin.com",
  description: "test",
  owner_type: "agent",
  endpoints: [],
  intents: ["get company info"],
};

describe("promoteExplicitExecution", () => {
  it("promotes semantically valid explicit execute results", () => {
    const ok = promoteExplicitExecution(
      "scope-1",
      "get company info",
      "https://www.linkedin.com/company/openai/about/",
      baseSkill,
      "endpoint-1",
      {
        name: "OpenAI",
        public_identifier: "openai",
        description: "AI company",
        industry: "Research",
        url: "https://www.linkedin.com/company/openai/",
      },
    );

    expect(ok).toBe(true);
  });

  it("still promotes skip-grade wrong-entity results", () => {
    const ok = promoteExplicitExecution(
      "scope-1",
      "get company info",
      "https://www.linkedin.com/company/openai/about/",
      baseSkill,
      "endpoint-1",
      {
        data: {
          elements: [{ mailboxId: "abc", unreadCount: 3 }],
        },
      },
    );

    expect(ok).toBe(true);
  });

  it("does not promote fail-grade explicit execute results", () => {
    const ok = promoteExplicitExecution(
      "scope-1",
      "get company info",
      "https://www.linkedin.com/company/openai/about/",
      baseSkill,
      "endpoint-1",
      { error: "backend exploded" },
    );

    expect(ok).toBe(false);
  });
});
