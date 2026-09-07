import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  validatePublishGate,
  MIN_SUCCESS_RATE,
  MIN_VERIFIED_ENDPOINTS,
} from "../src/publish/validate.js";

describe("P6 Pre-Publish Validation Gate (paper §6.1)", () => {
  test("rejects skill with 49% success rate", () => {
    const result = validatePublishGate({
      skill_id: "synthetic-49",
      endpoints: Array.from({ length: 100 }, (_, i) => ({
        success_rate: i < 49 ? 1.0 : 0.0,
        verified: false,
      })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.next_action).toBe("publish_rejected");
    expect(result.reason).toBe("success_rate_below_floor");
    expect(result.mean_success_rate).toBeLessThan(MIN_SUCCESS_RATE);
    expect(result.detail).toContain("UNBROWSE_PUBLISH_NAMESPACE=sandbox");
  });

  test("rejects skill with 51% success and zero verified endpoints", () => {
    const result = validatePublishGate({
      skill_id: "synthetic-51-unverified",
      endpoints: [
        { success_rate: 0.6, verified: false },
        { success_rate: 0.5, verified: false },
        { success_rate: 0.45, verified: false },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.next_action).toBe("publish_rejected");
    expect(result.reason).toBe("no_verified_endpoints");
    expect(result.mean_success_rate).toBeGreaterThanOrEqual(MIN_SUCCESS_RATE);
    expect(result.verified_count).toBe(0);
  });

  test("accepts skill with 51% success and one verified endpoint", () => {
    const result = validatePublishGate({
      skill_id: "synthetic-51-verified",
      endpoints: [
        { success_rate: 0.6, verified: true },
        { success_rate: 0.5, verified: false },
        { success_rate: 0.45, verified: false },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.mean_success_rate).toBeGreaterThanOrEqual(MIN_SUCCESS_RATE);
    expect(result.verified_count).toBeGreaterThanOrEqual(MIN_VERIFIED_ENDPOINTS);
  });

  test("rejects skill with zero endpoints", () => {
    const result = validatePublishGate({
      skill_id: "synthetic-empty",
      endpoints: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("no_endpoints");
  });

  test("accepts edge case at exactly 50% mean success with one verified", () => {
    const result = validatePublishGate({
      skill_id: "synthetic-edge-50",
      endpoints: [
        { success_rate: 0.5, verified: true },
        { success_rate: 0.5, verified: false },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("source tree contains zero --force-publish escape hatches", () => {
    const out = execSync(
      "grep -rn 'force-publish' src/ packages/ 2>/dev/null || true",
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(out.trim()).toBe("");
  });
});
