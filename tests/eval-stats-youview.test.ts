// G1 `unbrowse eval stats` you-view: the four ledger quantities, local-first with
// graceful remote degrade. shapeYouView is the pure contract — cost/time from the
// local impact log, payouts+contributions from the dashboard when present else 0,
// never null, never fabricated.
import { describe, it, expect } from "bun:test";
import { shapeYouView, type YouViewLocal } from "../src/cli-v7/eval/stats.js";

const local: YouViewLocal = {
  total_cost_saved_uc: 758_165_901, // → $758.165901
  total_time_saved_ms: 188_729_000, // → 52.4247h
  total_tokens_saved: 252_721_967,
  total_runs: 20_522,
};

describe("shapeYouView — G1 you-view contract", () => {
  it("local-only (no dashboard) → savings from local, payouts/contributions 0, unauth", () => {
    const you = shapeYouView(local, null, "/tmp/impact.jsonl");
    expect(you.cost_saved_usd).toBe(758.165901);
    expect(you.time_saved_hours).toBe(52.4247);
    expect(you.tokens_saved).toBe(252_721_967);
    expect(you.contributions).toBe(0);
    expect(you.payouts_usd).toBe(0);
    expect(you.authenticated).toBe(false);
    expect(you.impact_log_path).toBe("/tmp/impact.jsonl");
  });

  it("with dashboard → payouts + contributions count from remote, authenticated", () => {
    const you = shapeYouView(local, {
      economics: { total_earned_usd: 0.42 },
      contributions: [{ skill_id: "a" }, { skill_id: "b" }, { skill_id: "c" }],
    }, "/p");
    expect(you.payouts_usd).toBe(0.42);
    expect(you.contributions).toBe(3);
    expect(you.authenticated).toBe(true);
  });

  it("all four witness fields are always non-null (the gate the loop asserts)", () => {
    for (const dash of [null, { economics: {}, contributions: [] }]) {
      const you = shapeYouView(local, dash, "/p");
      for (const k of ["cost_saved_usd", "time_saved_hours", "contributions", "payouts_usd"]) {
        expect(you[k]).not.toBeNull();
        expect(you[k]).not.toBeUndefined();
      }
    }
  });

  it("zero local + no dashboard → all zeros, still non-null", () => {
    const you = shapeYouView({ total_cost_saved_uc: 0, total_time_saved_ms: 0, total_tokens_saved: 0, total_runs: 0 }, null, "/p");
    expect(you.cost_saved_usd).toBe(0);
    expect(you.payouts_usd).toBe(0);
  });
});
