// AC1 — the marketplace racer must consult a published skill for a COLD host
// (no knownSkillId). Issue #454: the by-host racer used to pass the hostname to
// marketplaceLookup (a skill_id seam) — the real getSkillCached can never match a
// hostname, so the racer always lost and cold-domain resolves fell to no_match. The
// fix routes the by-host racer through the dedicated `marketplaceByHost` seam.
//
// Real-code-paths-only: hits runResolveRace through its public DI seams. No mocks of the SUT.

import { describe, expect, it } from "bun:test";
import { runResolveRace } from "../src/orchestrator/resolve-race.js";
import type { SkillManifest } from "../src/types/index.js";

const hostSkill = (): SkillManifest => ({
  skill_id: "Zr9kQ2pLmN3xY7vBcD1aF",
  domain: "reddit.com",
  endpoints: [
    { endpoint_id: "ep-listing", url_template: "https://www.reddit.com/r/{subreddit}.json", method: "GET" } as any,
  ],
} as any);

describe("runResolveRace — marketplace fires on host via the host-aware seam (issue #454)", () => {
  it("invokes marketplaceByHost (NOT the skill_id lookup) for a cold host and wins", async () => {
    const byHostCalls: Array<{ host: string; intent: string }> = [];
    const skillIdCalls: string[] = [];

    const result = await runResolveRace({
      contextUrl: "https://www.reddit.com/r/programming",
      intent: "list top posts in r/programming",
      params: {},
      budgetMs: 500,
      findLocalSkill: () => null, // cold resolve
      knownSkillId: null, // no pre-known skill_id
      // The skill_id seam must NOT be called with a hostname (the #454 bug).
      marketplaceLookup: async (skillId) => { skillIdCalls.push(skillId); return null; },
      // The correct host-aware seam resolves the published skill for the domain.
      marketplaceByHost: async (host, intent) => { byHostCalls.push({ host, intent }); return hostSkill(); },
      probeOverride: () => new Promise(() => {}), // probe hangs so it can't win
    });

    // The host-aware seam is consulted with the HOST (reddit.com), not a skill_id.
    expect(byHostCalls.length).toBeGreaterThanOrEqual(1);
    expect(byHostCalls[0].host).toBe("www.reddit.com");
    // The skill_id seam was never fed the hostname (the bug is gone).
    expect(skillIdCalls).not.toContain("www.reddit.com");
    // The marketplace racer wins via the host path.
    expect(result.winner).not.toBeNull();
    expect(result.winner!.kind).toBe("marketplace");
  });

  it("SKIPS the by-host racer when no marketplaceByHost is wired (no doomed hostname lookup)", async () => {
    const skillIdCalls: string[] = [];
    const result = await runResolveRace({
      contextUrl: "https://www.reddit.com/r/programming",
      intent: "list top posts",
      params: {},
      budgetMs: 300,
      findLocalSkill: () => null,
      knownSkillId: null,
      marketplaceLookup: async (skillId) => { skillIdCalls.push(skillId); return null; },
      // marketplaceByHost intentionally absent.
      probeOverride: () => new Promise(() => {}),
    });
    // No marketplace racer fired (skipped), so the hostname was never passed to a skill_id lookup.
    expect(skillIdCalls).not.toContain("www.reddit.com");
    expect(result.tried.find((t) => t.name === "marketplace")).toBeUndefined();
  });
});
