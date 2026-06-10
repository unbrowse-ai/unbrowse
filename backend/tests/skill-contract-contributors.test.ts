/**
 * The /contract projection (skillToContract) must carry multi-contributor delta
 * attribution. A skill accrues contributors[] (services/splits.ts mergeContributor)
 * with per-agent cumulative_delta + share, but skillToContract DROPPED them — the
 * canonical /contract form of a 3-contributor skill erased who built it. This
 * witness asserts the contract carries every contributor and their delta.
 *
 * Red under HEAD: AikoCompiledContract has no contributors field; skillToContract
 * never emits one.
 */
import { test, expect } from "bun:test";
import type { SkillManifest } from "../src/types";
import { skillToContract } from "../src/services/skill-contract";

function skillWithContributors(): SkillManifest {
  return {
    skill_id: "sk-multi",
    version: "1.0.0",
    schema_version: "1",
    name: "multi-contributor skill",
    intent_signature: "search the registry",
    domain: "example.com",
    description: "Three contributors each added delta.",
    owner_type: "agent",
    owner_agent_id: "agent-alice",
    execution_type: "http",
    lifecycle: "active",
    endpoints: [
      { endpoint_id: "ep1", method: "GET", url_template: "https://example.com/api/a", description: "A", idempotency: "safe", verification_status: "verified", reliability_score: 0.9 },
    ],
    contributors: [
      { agent_id: "agent-alice", wallet_address: "Wallet111", endpoints_contributed: 3, cumulative_delta: 12.5, share: 0.6, first_contributed_at: "2026-06-01T00:00:00Z", last_contributed_at: "2026-06-05T00:00:00Z" },
      { agent_id: "agent-bob", wallet_address: "Wallet222", endpoints_contributed: 2, cumulative_delta: 6.0, share: 0.3, first_contributed_at: "2026-06-02T00:00:00Z", last_contributed_at: "2026-06-04T00:00:00Z" },
    ],
  } as SkillManifest;
}

test("skillToContract surfaces every contributor with their delta + share", () => {
  const contract = skillToContract(skillWithContributors()) as Record<string, unknown>;
  const contributors = contract.contributors as Array<Record<string, unknown>> | undefined;
  expect(Array.isArray(contributors)).toBe(true);
  expect(contributors).toHaveLength(2);
  const alice = contributors!.find((c) => c.agent_id === "agent-alice");
  const bob = contributors!.find((c) => c.agent_id === "agent-bob");
  expect(alice?.cumulative_delta).toBe(12.5);
  expect(alice?.share).toBe(0.6);
  expect(bob?.agent_id).toBe("agent-bob");
  expect(bob?.cumulative_delta).toBe(6.0);
});

test("skillToContract omits contributors when the skill has none", () => {
  const solo = skillWithContributors();
  delete (solo as { contributors?: unknown }).contributors;
  const contract = skillToContract(solo) as Record<string, unknown>;
  expect(contract.contributors).toBeUndefined();
});
