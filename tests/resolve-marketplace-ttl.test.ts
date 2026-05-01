import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

// In-memory backing store for the mocked client.getSkill — tests adjust it.
let calls = 0;
let backendImpl: (skillId: string, scope?: string) => Promise<unknown | null> = async (skillId: string) => ({
  skill_id: skillId,
  name: skillId,
  domain: "example.com",
  intent_signature: "test",
  description: "",
  endpoints: [],
  confidence: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  version: "1.0.0",
});

mock.module("../src/client/index.js", () => ({
  getSkill: async (skillId: string, scope?: string) => {
    calls++;
    return backendImpl(skillId, scope);
  },
  cachePublishedSkill: () => {},
  publishSkill: async () => ({}),
  isLocalOnlyMode: () => true,
  listSkills: async () => [],
  updateEndpointScore: async () => {},
}));

// Late import so the mocked module is captured
const {
  getSkillCached,
  invalidateMarketplaceCache,
  _clearMarketplaceCacheForTests,
  _marketplaceCacheSizeForTests,
} = await import("../src/marketplace/index.js");

beforeEach(() => {
  calls = 0;
  _clearMarketplaceCacheForTests();
  backendImpl = async (skillId: string) => ({
    skill_id: skillId,
    name: skillId,
    domain: "example.com",
    intent_signature: "test",
    description: "",
    endpoints: [],
    confidence: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: "1.0.0",
  });
});

afterEach(() => {
  _clearMarketplaceCacheForTests();
});

describe("marketplace TTL cache", () => {
  it("hits backend on first call, cache on second within TTL", async () => {
    const a = await getSkillCached("skill-x", "scope-a");
    const b = await getSkillCached("skill-x", "scope-a");
    expect((a as { skill_id: string }).skill_id).toBe("skill-x");
    expect((b as { skill_id: string }).skill_id).toBe("skill-x");
    expect(calls).toBe(1);
  });

  it("scopes are isolated", async () => {
    await getSkillCached("skill-x", "scope-a");
    await getSkillCached("skill-x", "scope-b");
    expect(calls).toBe(2);
  });

  it("invalidate by skill_id drops the entry across scopes", async () => {
    await getSkillCached("skill-x", "scope-a");
    await getSkillCached("skill-x", "scope-b");
    expect(_marketplaceCacheSizeForTests()).toBe(2);
    invalidateMarketplaceCache("skill-x");
    expect(_marketplaceCacheSizeForTests()).toBe(0);
    await getSkillCached("skill-x", "scope-a");
    expect(calls).toBe(3);
  });

  it("invalidate by domain drops every entry whose stored skill matches", async () => {
    await getSkillCached("skill-1", "scope-a");
    await getSkillCached("skill-2", "scope-a");
    expect(_marketplaceCacheSizeForTests()).toBe(2);
    invalidateMarketplaceCache("example.com");
    expect(_marketplaceCacheSizeForTests()).toBe(0);
  });

  it("returns null without caching when backend returns null", async () => {
    backendImpl = async () => null;
    const r = await getSkillCached("missing", "scope-a");
    expect(r).toBeNull();
    expect(_marketplaceCacheSizeForTests()).toBe(0);
  });
});
