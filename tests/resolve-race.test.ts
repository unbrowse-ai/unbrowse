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
