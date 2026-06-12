// Day 4 (Luminaries) failing test for AC1 — Marketplace racer gate.
// FAILS today (knownSkillId gate skips marketplace for cold hosts).
// Day 5 (Creatures) lays the rock by adding a host-gated marketplace racer;
// this test flips green.
//
// Real-code-paths-only: hits runResolveRace through its public DI seams
// (marketplaceLookup, findLocalSkill, probeOverride). No mocks of the SUT.

import { describe, expect, it } from "bun:test";
import { runResolveRace } from "../src/orchestrator/resolve-race.js";
import type { SkillManifest } from "../src/types/index.js";

describe("runResolveRace — marketplace fires on host even without knownSkillId (AC1)", () => {
  it("invokes marketplaceLookup when contextUrl has a host but knownSkillId is null", async () => {
    const calls: Array<{ skillIdOrHost: string; scope?: string }> = [];

    // A real async function (not a mock framework) acting as the DI seam.
    // The current impl gates this entire racer on args.knownSkillId, so it
    // must be invoked zero times today. The Day-5 fix will route by host
    // and invoke this at least once.
    const marketplaceLookup = async (
      skillIdOrHost: string,
      scope?: string,
    ): Promise<SkillManifest | null> => {
      calls.push({ skillIdOrHost, scope });
      // Return a usable host-skill manifest so the racer can also win and
      // appear in `tried` with status="won".
      return {
        skill_id: "reddit.com",
        domain: "reddit.com",
        endpoints: [
          {
            endpoint_id: "ep-listing",
            url_template: "https://www.reddit.com/r/{subreddit}.json",
            method: "GET",
          } as any,
        ],
      } as any;
    };

    const result = await runResolveRace({
      contextUrl: "https://www.reddit.com/r/programming",
      intent: "list top posts in r/programming",
      params: {},
      budgetMs: 500,
      // No local skill snapshot — this is a cold-resolve scenario.
      findLocalSkill: () => null,
      // No pre-known skill_id — this is the gate we want to remove.
      knownSkillId: null,
      marketplaceLookup,
      // Probe hangs forever so it can't accidentally win the race.
      probeOverride: () => new Promise(() => {}),
    });

    // AC1 desired behavior: marketplaceLookup MUST be invoked because the
    // host (reddit.com) is a valid index key, even without a known skill_id.
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // AC1 desired behavior: a `marketplace` racer must appear in tried[].
    const marketplaceAttempt = result.tried.find((t) => t.name === "marketplace");
    expect(marketplaceAttempt).toBeDefined();

    // And given the lookup returned a valid skill, marketplace should win.
    expect(result.winner).not.toBeNull();
    expect(result.winner!.kind).toBe("marketplace");
  });
});
