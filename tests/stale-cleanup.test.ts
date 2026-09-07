import { describe, expect, it } from "bun:test";
import {
  applyVerificationResults,
  countStaleEndpoints,
  pruneLocalCacheStateForSkill,
  type LocalCacheState,
} from "../src/stale-cleanup.js";
import type { SkillManifest } from "../src/types/index.js";

function makeSkill(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: "skill-1",
    name: "Test Skill",
    description: "desc",
    domain: "x.com",
    intent_signature: "get timeline",
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: "1.0.0",
    endpoints: [
      {
        endpoint_id: "good",
        method: "GET",
        url_template: "https://x.com/i/api/good",
        description: "good",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
      {
        endpoint_id: "bad",
        method: "GET",
        url_template: "https://x.com/i/api/bad",
        description: "bad",
        idempotency: "safe",
        verification_status: "failed",
        reliability_score: 0.1,
      },
    ],
    ...overrides,
  };
}

function makeCaches(skill: SkillManifest): LocalCacheState {
  return {
    capturedDomainCache: new Map([
      ["global:x.com", { skill, endpointId: "bad", expires: Date.now() + 1_000 }],
      ["global:x.com:good", { skill, endpointId: "good", expires: Date.now() + 1_000 }],
    ]),
    skillRouteCache: new Map([
      ["global:x.com:bad", { skillId: skill.skill_id, domain: skill.domain, endpointId: "bad", ts: Date.now() }],
      ["global:x.com:good", { skillId: skill.skill_id, domain: skill.domain, endpointId: "good", ts: Date.now() }],
    ]),
    routeResultCache: new Map([
      ["global:x.com:bad", { skill, endpointId: "bad", result: {}, trace: {}, expires: Date.now() + 1_000 }],
      ["global:x.com:good", { skill, endpointId: "good", result: {}, trace: {}, expires: Date.now() + 1_000 }],
    ]),
    domainSkillCache: new Map([
      ["x.com", { skillId: skill.skill_id, endpointId: "bad", ts: Date.now() }],
      ["good.x.com", { skillId: skill.skill_id, endpointId: "good", ts: Date.now() }],
    ]),
  };
}

describe("stale cleanup", () => {
  it("counts stale endpoints from failed or low-reliability state", () => {
    expect(countStaleEndpoints(makeSkill())).toBe(1);
    expect(countStaleEndpoints(makeSkill({
      endpoints: [
        {
          endpoint_id: "low",
          method: "GET",
          url_template: "https://x.com/low",
          description: "low",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.19,
        },
      ],
    }))).toBe(1);
  });

  it("prunes only stale cache entries for a skill", () => {
    const skill = makeSkill();
    const caches = makeCaches(skill);

    const summary = pruneLocalCacheStateForSkill(skill, caches);

    expect(summary).toEqual({
      route_cache_entries_removed: 1,
      domain_cache_entries_removed: 1,
      route_result_entries_removed: 1,
      captured_domain_entries_removed: 1,
    });
    expect([...caches.skillRouteCache.keys()]).toEqual(["global:x.com:good"]);
    expect([...caches.routeResultCache.keys()]).toEqual(["global:x.com:good"]);
    expect([...caches.capturedDomainCache.keys()]).toEqual(["global:x.com:good"]);
    expect([...caches.domainSkillCache.keys()]).toEqual(["good.x.com"]);
  });

  it("applies verification recovery to disabled endpoints", () => {
    const skill = makeSkill({
      endpoints: [
        {
          endpoint_id: "recover",
          method: "GET",
          url_template: "https://x.com/recover",
          description: "recover",
          idempotency: "safe",
          verification_status: "disabled",
          reliability_score: 0.1,
        },
      ],
    });

    const refreshed = applyVerificationResults(skill, { recover: "verified" });

    expect(refreshed.endpoints[0]?.verification_status).toBe("verified");
    expect(refreshed.endpoints[0]?.reliability_score).toBe(0.5);
  });
});
