import { describe, expect, test } from "bun:test";
import { validatePublishGate } from "../src/publish/validate.js";

describe("P6 Pre-Publish Validation Gate — adversarial / divers diseases", () => {
  test("NaN success_rate must not be treated as ≥ 0.5", () => {
    const result = validatePublishGate({
      skill_id: "adversarial-nan",
      endpoints: [{ success_rate: Number.NaN, verified: true }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("success_rate_below_floor");
  });

  test("negative success_rate must reject (clamps below floor)", () => {
    const result = validatePublishGate({
      skill_id: "adversarial-negative",
      endpoints: [{ success_rate: -1, verified: true }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("success_rate_below_floor");
  });

  test("success_rate above 1.0 (impossibly high) still validates structurally", () => {
    // The gate should not silently reject impossible-but-passing values;
    // upstream telemetry is the place to clamp. Gate's job is the floor.
    const result = validatePublishGate({
      skill_id: "adversarial-overflow",
      endpoints: [{ success_rate: 99, verified: true }],
    });
    expect(result.ok).toBe(true);
  });

  test("missing endpoints field (undefined) is treated as zero endpoints", () => {
    const result = validatePublishGate({
      skill_id: "adversarial-undefined",
      endpoints: undefined as unknown as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("no_endpoints");
  });

  test("input is not mutated by the gate", () => {
    const input = {
      skill_id: "purity-test",
      endpoints: [
        { success_rate: 0.6, verified: true },
        { success_rate: 0.4, verified: false },
      ],
    };
    const snapshot = JSON.stringify(input);
    validatePublishGate(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("very large endpoint list (10k) does not throw and computes mean correctly", () => {
    const endpoints = Array.from({ length: 10_000 }, (_, i) => ({
      success_rate: i % 2 === 0 ? 1.0 : 0.0,
      verified: i === 0,
    }));
    const result = validatePublishGate({
      skill_id: "scale-10k",
      endpoints,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.mean_success_rate).toBeCloseTo(0.5, 5);
  });

  test("all endpoints fail (success_rate=0) is rejected", () => {
    const result = validatePublishGate({
      skill_id: "all-zero",
      endpoints: Array.from({ length: 10 }, () => ({
        success_rate: 0,
        verified: true,
      })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("success_rate_below_floor");
  });

  test("verified=true with success_rate=0 still fails the floor", () => {
    // Adversarial: a malicious publisher marking a dead endpoint verified
    // to slip past the verified-count check. The success-rate floor must
    // catch it first.
    const result = validatePublishGate({
      skill_id: "verified-but-dead",
      endpoints: [
        { success_rate: 0, verified: true },
        { success_rate: 0, verified: true },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("success_rate_below_floor");
  });
});
