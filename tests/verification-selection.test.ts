import { describe, expect, it } from "bun:test";
import { selectVerificationCandidates } from "../src/verification/candidates.js";
import type { SkillManifest } from "../src/types/index.js";

function makeSkill(): SkillManifest {
  return {
    skill_id: "skill-verify",
    name: "Verify Skill",
    description: "desc",
    domain: "www.linkedin.com",
    intent_signature: "get timeline",
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: "1.0.0",
    endpoints: [
      {
        endpoint_id: "fresh-get",
        method: "GET",
        url_template: "https://www.linkedin.com/fresh",
        description: "fresh",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        last_verified_at: new Date("2026-04-03T00:00:00Z").toISOString(),
      },
      {
        endpoint_id: "failed-get",
        method: "GET",
        url_template: "https://www.linkedin.com/failed",
        description: "failed",
        idempotency: "safe",
        verification_status: "failed",
        reliability_score: 0.1,
      },
      {
        endpoint_id: "low-get",
        method: "GET",
        url_template: "https://www.linkedin.com/low",
        description: "low",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.1,
      },
      {
        endpoint_id: "post-write",
        method: "POST",
        url_template: "https://www.linkedin.com/write",
        description: "write",
        idempotency: "unsafe",
        verification_status: "unverified",
        reliability_score: 0.5,
      },
    ],
  };
}

describe("verification candidate selection", () => {
  it("filters to stale GET endpoints and respects limit", () => {
    const skill = makeSkill();
    const picked = selectVerificationCandidates(skill, {
      staleOnly: true,
      limit: 1,
      now: new Date("2026-04-03T01:00:00Z").getTime(),
    });
    expect(picked).toHaveLength(1);
    expect(["failed-get", "low-get"]).toContain(picked[0]?.endpoint_id);
  });

  it("returns all GET endpoints when staleOnly is false", () => {
    const skill = makeSkill();
    const picked = selectVerificationCandidates(skill);
    expect(picked.map((endpoint) => endpoint.endpoint_id)).toEqual([
      "fresh-get",
      "failed-get",
      "low-get",
    ]);
  });
});
