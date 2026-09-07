// Regression: raceWithDeadline labels in-flight racers as "deadline" when
// another racer wins the race, even though the deadline timer never fired.
// The agent reads `decision_trace.budget_race.tried[i].status = "deadline"`
// and concludes the marketplace timed out (8s budget exhausted) when actually
// it was cancelled in ~30ms because probe won first. Misleading provenance.

import { describe, expect, it } from "bun:test";
import { raceWithDeadline, type Racer } from "../src/orchestrator/resolve-race.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("raceWithDeadline: cancelled status when another racer wins", () => {
  it("marks an in-flight slow racer as 'cancelled', not 'deadline', when a fast one wins", async () => {
    const racers: Racer<string>[] = [
      { name: "slow-marketplace", start: async () => { await sleep(2000); return "marketplace"; }, isValid: () => true },
      { name: "fast-probe", start: async () => { await sleep(10); return "probe"; }, isValid: () => true },
    ];
    const r = await raceWithDeadline(racers, 5000);
    expect(r.winner?.name).toBe("fast-probe");
    const slow = r.tried.find((t) => t.name === "slow-marketplace");
    expect(slow).toBeDefined();
    // The bug: pre-fix slow.status === "deadline" with ms ~10 (cancelled by
    // the win, never settled, retained its initialization label). Post-fix
    // the status accurately reflects that this racer was aborted by a win,
    // not by the budget exhausting.
    expect(slow!.status).toBe("cancelled");
    expect(slow!.ms).toBeLessThan(100);
    expect(slow!.reason).toBe("another_racer_won");
  });

  it("still uses 'deadline' when the budget actually exhausts (no winner)", async () => {
    const racers: Racer<string>[] = [
      { name: "slow-a", start: async () => { await sleep(5000); return "a"; }, isValid: () => true },
      { name: "slow-b", start: async () => { await sleep(5000); return "b"; }, isValid: () => true },
    ];
    const r = await raceWithDeadline(racers, 30);
    expect(r.winner).toBeNull();
    // Real deadline elapsed; both racers remain in-flight.
    expect(r.tried.every((t) => t.status === "deadline")).toBe(true);
    expect(r.tried.every((t) => t.ms >= 30 && t.ms < 500)).toBe(true);
  });

  it("preserves 'lost' for racers that settled with invalid results before another won", async () => {
    const racers: Racer<string>[] = [
      { name: "fast-invalid", start: async () => { await sleep(5); return "wrong"; }, isValid: (s) => s === "right" },
      { name: "slow-valid", start: async () => { await sleep(40); return "right"; }, isValid: (s) => s === "right" },
    ];
    const r = await raceWithDeadline(racers, 500);
    expect(r.winner?.name).toBe("slow-valid");
    const invalid = r.tried.find((t) => t.name === "fast-invalid");
    // "lost" wins over "cancelled" because this racer fully settled (just
    // with an invalid result); it was not cancelled mid-flight.
    expect(invalid!.status).toBe("lost");
  });

  it("preserves 'lost' for racers that threw before another won", async () => {
    const racers: Racer<string>[] = [
      { name: "fast-throw", start: async () => { await sleep(5); throw new Error("boom"); }, isValid: () => true },
      { name: "slow-valid", start: async () => { await sleep(40); return "ok"; }, isValid: () => true },
    ];
    const r = await raceWithDeadline(racers, 500);
    expect(r.winner?.name).toBe("slow-valid");
    const thrower = r.tried.find((t) => t.name === "fast-throw");
    expect(thrower!.status).toBe("lost");
    expect(thrower!.reason).toContain("boom");
  });
});
