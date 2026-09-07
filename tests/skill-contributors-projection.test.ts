/**
 * Multi-contributor delta attribution must survive the skill's canonical
 * projections — the agentskills.io SKILL.md export and the /contract form.
 *
 * A skill already accrues contributors[] (src/payments / backend splits.ts:
 * mergeContributor) with per-agent cumulative_delta + share. But the two
 * representations a skill is published AS — the SKILL.md (agentskills.io spec)
 * and the /contract tree (skillToContract) — both DROPPED that attribution: a
 * 3-contributor skill rendered as if it had one author. This witness asserts
 * both projections carry every contributor and their delta.
 *
 * This file covers the SKILL.md (src/skillmd.ts) half; the /contract half is
 * backend/tests/skill-contract-contributors.test.ts. Red under HEAD — neither
 * projection emits contributors yet.
 */
import { describe, expect, it } from "bun:test";
import { renderSkillMd } from "../src/skillmd.js";
import type { SkillManifest } from "../src/types/skill.js";

function skillWithContributors(): SkillManifest {
  return {
    skill_id: "sk-multi",
    version: "1.0.0",
    schema_version: "1",
    name: "multi-contributor skill",
    intent_signature: "search the registry",
    domain: "example.com",
    description: "A skill with three contributors who each added delta.",
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    updated_at: "2026-06-05T00:00:00Z",
    endpoints: [
      { endpoint_id: "ep1", method: "GET", url_template: "https://example.com/api/a", description: "A", idempotency: "safe", verification_status: "verified", reliability_score: 0.9 },
    ],
    contributors: [
      { agent_id: "agent-alice", wallet_address: "Wallet111", endpoints_contributed: 3, cumulative_delta: 12.5, share: 0.6, first_contributed_at: "2026-06-01T00:00:00Z", last_contributed_at: "2026-06-05T00:00:00Z" },
      { agent_id: "agent-bob", wallet_address: "Wallet222", endpoints_contributed: 2, cumulative_delta: 6.0, share: 0.3, first_contributed_at: "2026-06-02T00:00:00Z", last_contributed_at: "2026-06-04T00:00:00Z" },
      { agent_id: "agent-carol", endpoints_contributed: 1, cumulative_delta: 2.0, share: 0.1, first_contributed_at: "2026-06-03T00:00:00Z", last_contributed_at: "2026-06-03T00:00:00Z" },
    ],
  } as SkillManifest;
}

describe("SKILL.md (agentskills.io) surfaces multi-contributor delta", () => {
  it("renders agentskills.io-required frontmatter (name + description)", () => {
    const md = renderSkillMd(skillWithContributors());
    expect(md).toMatch(/^---\n[\s\S]*\n---/);
    expect(md).toMatch(/^name:\s*\S/m);
    expect(md).toMatch(/^description:\s*\S/m);
  });

  it("emits a metadata.contributors block listing every contributor + their delta", () => {
    const md = renderSkillMd(skillWithContributors());
    // agentskills.io spec: `metadata` is the free-form frontmatter object.
    expect(md).toMatch(/^metadata:/m);
    for (const id of ["agent-alice", "agent-bob", "agent-carol"]) {
      expect(md).toContain(id);
    }
    // the delta numbers must be present (attribution, not just identity)
    expect(md).toContain("12.5");
    expect(md).toContain("6");
    expect(md).toContain("2");
  });

  it("does not invent contributors when none exist (single-author skill)", () => {
    const solo = skillWithContributors();
    delete (solo as { contributors?: unknown }).contributors;
    const md = renderSkillMd(solo);
    expect(md).not.toContain("agent-alice");
  });
});
