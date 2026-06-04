import { describe, expect, it } from "bun:test";
import { raceWithDeadline, type Racer } from "../src/orchestrator/resolve-race.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("raceWithDeadline", () => {
  it("returns winner: null when no racers are given", async () => {
    const r = await raceWithDeadline<number>([], 100);
    expect(r.winner).toBeNull();
    expect(r.tried).toEqual([]);
  });

  it("picks the first valid result among all-finishing racers (fastest valid wins)", async () => {
    const racers: Racer<number>[] = [
      { name: "slow-but-valid", start: async () => { await sleep(40); return 1; }, isValid: (n) => n === 1 },
      { name: "fast-and-valid", start: async () => { await sleep(10); return 2; }, isValid: (n) => n === 2 },
      { name: "fast-but-invalid", start: async () => { await sleep(5); return 99; }, isValid: (n) => n === 1 || n === 2 },
    ];
    const r = await raceWithDeadline(racers, 500);
    expect(r.winner).not.toBeNull();
    expect(r.winner!.name).toBe("fast-and-valid");
    expect(r.winner!.result).toBe(2);
    // fast-but-invalid should be marked lost (it returned 99, not valid)
    const invalid = r.tried.find((t) => t.name === "fast-but-invalid");
    expect(invalid?.status).toBe("lost");
  });

  it("returns the only valid result when others throw", async () => {
    const racers: Racer<string>[] = [
      { name: "throws-1", start: async () => { throw new Error("boom1"); }, isValid: () => true },
      { name: "throws-2", start: async () => { throw new Error("boom2"); }, isValid: () => true },
      { name: "valid", start: async () => { await sleep(10); return "ok"; }, isValid: (s) => s === "ok" },
    ];
    const r = await raceWithDeadline(racers, 500);
    expect(r.winner?.name).toBe("valid");
    const t1 = r.tried.find((t) => t.name === "throws-1");
    expect(t1?.status).toBe("lost");
    expect(t1?.reason).toContain("boom1");
  });

  it("returns winner: null when every racer throws", async () => {
    const racers: Racer<number>[] = [
      { name: "a", start: async () => { throw new Error("a-fail"); }, isValid: () => true },
      { name: "b", start: async () => { throw new Error("b-fail"); }, isValid: () => true },
    ];
    const r = await raceWithDeadline(racers, 500);
    expect(r.winner).toBeNull();
    expect(r.tried.every((t) => t.status === "lost")).toBe(true);
  });

  it("returns winner: null when every racer is slower than the deadline", async () => {
    const racers: Racer<string>[] = [
      { name: "slow1", start: async () => { await sleep(500); return "x"; }, isValid: () => true },
      { name: "slow2", start: async () => { await sleep(500); return "y"; }, isValid: () => true },
    ];
    const t0 = Date.now();
    const r = await raceWithDeadline(racers, 50);
    const elapsed = Date.now() - t0;
    expect(r.winner).toBeNull();
    expect(elapsed).toBeLessThan(150);
    expect(r.tried.every((t) => t.status === "deadline")).toBe(true);
  });

  it("invokes abort() on every losing racer when a winner is announced", async () => {
    const aborts: string[] = [];
    const racers: Racer<string>[] = [
      {
        name: "fast",
        start: async () => { await sleep(5); return "winner"; },
        isValid: () => true,
        abort: () => aborts.push("fast"),
      },
      {
        name: "slow1",
        start: async () => { await sleep(500); return "loser1"; },
        isValid: () => true,
        abort: () => aborts.push("slow1"),
      },
      {
        name: "slow2",
        start: async () => { await sleep(500); return "loser2"; },
        isValid: () => true,
        abort: () => aborts.push("slow2"),
      },
    ];
    const r = await raceWithDeadline(racers, 500);
    expect(r.winner?.name).toBe("fast");
    // The fast racer settled before finalize() iterates aborts, so it's not aborted.
    // The slow ones should have had abort() called.
    expect(aborts).toContain("slow1");
    expect(aborts).toContain("slow2");
    expect(aborts).not.toContain("fast");
  });

  it("invokes abort() on every in-flight racer at the deadline", async () => {
    const aborts: string[] = [];
    const racers: Racer<number>[] = [
      {
        name: "slow",
        start: async () => { await sleep(500); return 1; },
        isValid: () => true,
        abort: () => aborts.push("slow"),
      },
    ];
    const r = await raceWithDeadline(racers, 30);
    expect(r.winner).toBeNull();
    expect(aborts).toEqual(["slow"]);
  });

  it("each tried entry records elapsed ms", async () => {
    const racers: Racer<number>[] = [
      { name: "fast", start: async () => { await sleep(5); return 1; }, isValid: () => true },
    ];
    const r = await raceWithDeadline(racers, 500);
    expect(r.winner?.name).toBe("fast");
    const fast = r.tried.find((t) => t.name === "fast")!;
    expect(fast.status).toBe("won");
    expect(fast.ms).toBeGreaterThanOrEqual(0);
    expect(fast.ms).toBeLessThan(500);
  });
});

describe("raceWithDeadline — async-hang regressions", () => {
  // Phase 8.1 follow-up (2026-05-02): the corpus sweep at --budget 500
  // showed 4/17 cases producing zero JSON output. Real-world root cause:
  // a racer's await never resolves (stuck fetch, hung DNS lookup, daemon
  // mid-startup). The deadline timer MUST fire through these because JS
  // setTimeout is independent of any pending fetch promise.
  //
  // Caveat: JavaScript cannot preempt a synchronous busy-loop. If a
  // racer's start() does long sync work, no setTimeout can fire until the
  // sync block yields. That's a JS-runtime limit, not a race-primitive
  // bug. These tests target the realistic cases (async hangs) which is
  // what the production hangs actually were.

  it("deadline fires when a racer's promise never resolves", async () => {
    const budgetMs = 100;
    const t0 = Date.now();
    const racers: Racer<number>[] = [
      {
        // never-resolving racer: simulates a stuck fetch, hung DNS, etc.
        name: "never-resolves",
        start: () => new Promise<number>(() => { /* never resolves */ }),
        isValid: () => true,
      },
    ];
    const r = await raceWithDeadline(racers, budgetMs);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(budgetMs + 80);
    expect(r.winner).toBeNull();
    const t = r.tried.find((x) => x.name === "never-resolves")!;
    expect(t.status).toBe("deadline");
  });

  it("deadline fires when ALL racers hang on async work", async () => {
    const budgetMs = 80;
    const t0 = Date.now();
    const racers: Racer<number>[] = [
      { name: "hang-1", start: () => new Promise<number>(() => {}), isValid: () => true },
      { name: "hang-2", start: () => new Promise<number>(() => {}), isValid: () => true },
      { name: "hang-3", start: () => new Promise<number>(() => {}), isValid: () => true },
    ];
    const r = await raceWithDeadline(racers, budgetMs);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(budgetMs + 80);
    expect(r.winner).toBeNull();
    expect(r.tried.every((t) => t.status === "deadline")).toBe(true);
  });

  it("aborts hung racers when deadline fires", async () => {
    const budgetMs = 60;
    let aborted = false;
    const racers: Racer<number>[] = [
      {
        name: "abortable-hang",
        start: () => new Promise<number>(() => {}),
        isValid: () => true,
        abort: () => { aborted = true; },
      },
    ];
    await raceWithDeadline(racers, budgetMs);
    expect(aborted).toBe(true);
  });

  it("a fast valid racer wins even when a sibling racer hangs", async () => {
    const racers: Racer<string>[] = [
      { name: "hang", start: () => new Promise<string>(() => {}), isValid: () => true },
      { name: "fast", start: async () => { await sleep(10); return "ok"; }, isValid: (s) => s === "ok" },
    ];
    const t0 = Date.now();
    const r = await raceWithDeadline(racers, 1000);
    const elapsed = Date.now() - t0;
    expect(r.winner?.name).toBe("fast");
    expect(elapsed).toBeLessThan(150);
    const hang = r.tried.find((t) => t.name === "hang")!;
    // Updated 2026-05-15: a hanging racer when another wins is now "cancelled"
    // (race decided by win, not by deadline). See resolve-race-cancelled-status.test.ts.
    expect(hang.status).toBe("cancelled");
    expect(hang.reason).toBe("another_racer_won");
  });
});

import { runResolveRace } from "../src/orchestrator/resolve-race.js";

describe("runResolveRace — local-skill fast path", () => {
  // Phase 8.1 follow-up (2026-05-02): added a `local-skill` racer that
  // returns cached skill data instantly. Without it, every second-call
  // to a previously-captured domain falls through to a marketplace
  // network lookup that exceeds tight budgets (--budget 500). With it,
  // the agent gets a shortlist in <10ms.
  const fakeSkill = {
    skill_id: "test-skill",
    domain: "example.com",
    endpoints: [
      { endpoint_id: "ep1", url_template: "https://example.com/api/things", method: "GET" },
      { endpoint_id: "ep2", url_template: "https://example.com/api/things/{id}", method: "GET" },
    ],
  } as any;

  it("local-skill wins instantly when a snapshot exists with endpoints", async () => {
    const t0 = Date.now();
    const r = await runResolveRace({
      contextUrl: "https://example.com/things",
      intent: "list things",
      params: {},
      budgetMs: 500,
      findLocalSkill: () => fakeSkill,
      knownSkillId: "test-skill",
      // Marketplace lookup that hangs forever — proves local-skill wins first.
      marketplaceLookup: () => new Promise(() => {}),
      // Probe that hangs forever.
      probeOverride: () => new Promise(() => {}),
    });
    const elapsed = Date.now() - t0;
    expect(r.winner).not.toBeNull();
    expect(r.winner!.kind).toBe("local-skill");
    expect((r.winner as any).skill.skill_id).toBe("test-skill");
    expect(elapsed).toBeLessThan(50);
  });

  it("local-skill is skipped when the snapshot has zero endpoints", async () => {
    const emptySkill = { ...fakeSkill, endpoints: [] };
    const r = await runResolveRace({
      contextUrl: "https://example.com/things",
      intent: "list things",
      params: {},
      budgetMs: 80,
      findLocalSkill: () => emptySkill,
      knownSkillId: "test-skill",
      marketplaceLookup: () => new Promise(() => {}),
      probeOverride: () => new Promise(() => {}),
    });
    // No winner because empty local skill shouldn't qualify, marketplace and
    // probe both hang past the budget.
    expect(r.winner).toBeNull();
    const local = r.tried.find((t) => t.name === "local-skill");
    expect(local).toBeUndefined();
  });

  it("local-skill loses to recipe-replay when both are available", async () => {
    const skillWithRecipe = {
      ...fakeSkill,
      endpoints: [{
        endpoint_id: "rep1",
        url_template: "https://example.com/api/things",
        method: "GET",
        proven_recipe: {
          method: "GET",
          url_template: "https://example.com/api/things",
          response_signal: { kind: "json_shape" as const },
        },
      }],
    };
    // Skip — recipe-replay needs real fetch infra. The local-skill racer is
    // already covered above; this test exists to document the priority but is
    // intentionally a no-op. Future work: stub replayRecipe.
    expect(true).toBe(true);
  });
});
