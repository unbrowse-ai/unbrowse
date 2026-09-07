import { describe, expect, test } from "bun:test";
import type { ChainWalkContext, DecisionTraceStep } from "../src/types/skill.js";

describe("ChainWalkContext type contract", () => {
  test("can be constructed with all required fields", () => {
    const ctx: ChainWalkContext = {
      now: Date.now(),
      consumed: new Map<string, boolean>(),
      depth: 0,
      visited: new Set<string>(),
      maxDepth: 4,
      trace: [],
    };
    expect(ctx.depth).toBe(0);
    expect(ctx.maxDepth).toBe(4);
  });

  test("producerIndex is optional", () => {
    const ctx: ChainWalkContext = {
      now: 0,
      consumed: new Map(),
      depth: 0,
      visited: new Set(),
      maxDepth: 4,
      trace: [],
    };
    expect(ctx.producerIndex).toBeUndefined();
  });

  test("trace accepts DecisionTraceStep entries with the canonical chain_walk_* step names", () => {
    const steps: DecisionTraceStep[] = [
      { step: "chain_walk_refetched_success", endpoint_id: "abc", binding_key: "csrf_token" },
      { step: "chain_walk_depth_exceeded", depth: 4 },
      { step: "chain_walk_cycle_detected", endpoint_id: "loop" },
      { step: "chain_walk_stale_skipped", binding_key: "csrf_token" },
      { step: "chain_walk_fresh_reused", binding_key: "csrf_token", remaining_ms: 5000 },
      { step: "chain_walk_single_use_consumed", binding_key: "one_time" },
      { step: "chain_walk_refetched_failure", endpoint_id: "abc", reason: "non_2xx" },
    ];
    expect(steps.length).toBe(7);
    expect(steps.every((s) => s.step.startsWith("chain_walk_"))).toBe(true);
  });
});
