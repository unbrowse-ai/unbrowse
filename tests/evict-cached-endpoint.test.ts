// Regression for client-side cache invalidation. When the backend auto-deprecates
// an endpoint after repeated hard failures, the local route cache used to keep
// serving the dead endpoint until TTL expiry — agents would loop on the same
// stale URL across calls. evictCachedEndpoint() drops the offending endpoint from
// the in-memory + on-disk cache so the next resolve has to fetch fresh.

import { describe, expect, it, beforeEach } from "bun:test";
import { cachePublishedSkill, evictCachedEndpoint, getRecentLocalSkill } from "../src/client/index.js";
import type { SkillManifest, EndpointDescriptor } from "../src/types/skill.js";

function endpoint(id: string, url: string): EndpointDescriptor {
  return {
    endpoint_id: id,
    method: "GET",
    url_template: url,
    headers_template: {},
    query: {},
  } as EndpointDescriptor;
}

function skillFixture(skillId: string, endpoints: EndpointDescriptor[]): SkillManifest {
  return {
    skill_id: skillId,
    domain: "example.com",
    name: "example",
    description: "test fixture",
    version: 1,
    endpoints,
    auth: { type: "none" },
  } as unknown as SkillManifest;
}

describe("evictCachedEndpoint", () => {
  const skillId = `test-evict-${Date.now()}`;

  beforeEach(() => {
    const skill = skillFixture(skillId, [
      endpoint("ep-alive", "https://example.com/api/items"),
      endpoint("ep-dead", "https://example.com/api/deleted"),
    ]);
    cachePublishedSkill(skill);
  });

  it("removes the target endpoint from the cached manifest", () => {
    const removed = evictCachedEndpoint(skillId, "ep-dead");
    expect(removed).toBe(true);
    const after = getRecentLocalSkill(skillId);
    expect(after).not.toBeNull();
    expect(after!.endpoints.map((e) => e.endpoint_id)).toEqual(["ep-alive"]);
  });

  it("keeps the rest of the manifest intact (skill, domain, other endpoints)", () => {
    evictCachedEndpoint(skillId, "ep-dead");
    const after = getRecentLocalSkill(skillId);
    expect(after?.skill_id).toBe(skillId);
    expect(after?.domain).toBe("example.com");
    expect(after?.endpoints.find((e) => e.endpoint_id === "ep-alive")).toBeDefined();
  });

  it("returns false when the endpoint isn't in the manifest", () => {
    const removed = evictCachedEndpoint(skillId, "ep-never-existed");
    expect(removed).toBe(false);
    const after = getRecentLocalSkill(skillId);
    expect(after?.endpoints.length).toBe(2);
  });

  it("returns false when the skill itself isn't cached", () => {
    const removed = evictCachedEndpoint("nonexistent-skill-id", "ep-dead");
    expect(removed).toBe(false);
  });

  it("eviction survives a second read (persisted to disk, not just in-memory)", () => {
    evictCachedEndpoint(skillId, "ep-dead");
    const first = getRecentLocalSkill(skillId);
    const second = getRecentLocalSkill(skillId);
    expect(first?.endpoints.length).toBe(1);
    expect(second?.endpoints.length).toBe(1);
  });
});
