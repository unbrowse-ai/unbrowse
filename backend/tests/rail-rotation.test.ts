import { describe, expect, it } from "bun:test";
import { pickRail, railHintHeader } from "../src/services/rail-rotation.js";

// L2 unbrowse-payments-faremeter wave 1. Pure-function tests, no mocks,
// no IO. Same input always gives the same output.

const ENV_DEFAULT = {} as { PAYAI_ROTATION_BPS?: string };
const ENV_BPS = (n: number) => ({ PAYAI_ROTATION_BPS: String(n) });

describe("L2 pickRail — monotonic 0 to 10000 flip", () => {
  it("PAYAI_ROTATION_BPS=0 makes every agent see flex first", () => {
    for (const agent of ["agentA", "agentB", "agentC", "1234"]) {
      const r = pickRail(ENV_BPS(0), agent);
      expect(r.primary).toBe("flex");
      expect(r.effective_bps).toBe(0);
    }
  });

  it("PAYAI_ROTATION_BPS=10000 makes every agent see payai first", () => {
    for (const agent of ["agentA", "agentB", "agentC", "1234"]) {
      const r = pickRail(ENV_BPS(10000), agent);
      expect(r.primary).toBe("payai");
      expect(r.effective_bps).toBe(10000);
    }
  });

  it("missing env falls back to 5000 (50/50)", () => {
    const r = pickRail(ENV_DEFAULT, "agentX");
    expect(r.effective_bps).toBe(5000);
  });

  it("non-numeric env falls back to 5000", () => {
    const r = pickRail({ PAYAI_ROTATION_BPS: "not-a-number" }, "agentX");
    expect(r.effective_bps).toBe(5000);
  });

  it("clamps below zero to 0", () => {
    const r = pickRail(ENV_BPS(-100), "agentX");
    expect(r.effective_bps).toBe(0);
    expect(r.primary).toBe("flex");
  });

  it("clamps above 10000 to 10000", () => {
    const r = pickRail(ENV_BPS(99999), "agentX");
    expect(r.effective_bps).toBe(10000);
    expect(r.primary).toBe("payai");
  });
});

describe("L2 pickRail — deterministic per agent (latency comparisons hold)", () => {
  it("same agent_id with same env always lands in the same bucket", () => {
    const env = ENV_BPS(5000);
    const r1 = pickRail(env, "agent-stable-1");
    const r2 = pickRail(env, "agent-stable-1");
    const r3 = pickRail(env, "agent-stable-1");
    expect(r1.bucket).toBe(r2.bucket);
    expect(r2.bucket).toBe(r3.bucket);
    expect(r1.primary).toBe(r2.primary);
  });

  it("anonymous (undefined agent_id) lands in bucket 0 (flex-leaning under 50/50)", () => {
    const r = pickRail(ENV_BPS(5000), undefined);
    expect(r.bucket).toBe(0);
    expect(r.primary).toBe("flex");
  });

  it("empty agent_id (falsy) lands in bucket 0", () => {
    const r = pickRail(ENV_BPS(5000), "");
    expect(r.bucket).toBe(0);
    expect(r.primary).toBe("flex");
  });

  it("buckets are spread across [0, 9999) across many agent ids", () => {
    // Hash-bucket distribution sanity: 1000 agents shouldn't all land
    // in one decile of the bucket space. (Not a uniform-distribution
    // test; just a smoke test against a degenerate hash.)
    const buckets = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const r = pickRail(ENV_BPS(5000), `agent-${i}`);
      buckets.add(r.bucket);
    }
    // Heuristic: with FNV-1a + 1000 distinct keys, we expect well over
    // 700 distinct buckets.
    expect(buckets.size).toBeGreaterThan(700);
  });

  it("at bps=5000 a population of agents splits ~50/50 across rails", () => {
    let payai = 0;
    let flex = 0;
    for (let i = 0; i < 1000; i++) {
      const r = pickRail(ENV_BPS(5000), `agent-${i}`);
      if (r.primary === "payai") payai++;
      else flex++;
    }
    // Wide tolerance; FNV-1a is not a uniform hash but a 35/65 split
    // would suggest something is wrong.
    expect(payai).toBeGreaterThan(350);
    expect(payai).toBeLessThan(650);
    expect(flex).toBeGreaterThan(350);
    expect(flex).toBeLessThan(650);
    expect(payai + flex).toBe(1000);
  });
});

describe("L2 railHintHeader", () => {
  it("emits the right header for each rail", () => {
    expect(railHintHeader("flex")).toEqual({ "X-Unbrowse-Rail-Hint": "flex" });
    expect(railHintHeader("payai")).toEqual({ "X-Unbrowse-Rail-Hint": "payai" });
  });
});
