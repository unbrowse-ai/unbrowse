import { describe, test, expect } from "bun:test";

const DEPRECATION_THRESHOLD = 5;
const DRIFT_DEPRECATION_THRESHOLD = 3;

describe("#99 consecutive failures deprecation", () => {
  function shouldAutoDeprecate(stats: { consecutive_failures: number }): boolean {
    return stats.consecutive_failures >= DEPRECATION_THRESHOLD;
  }

  test("below threshold does not deprecate", () => {
    expect(shouldAutoDeprecate({ consecutive_failures: 3 })).toBe(false);
  });

  test("at threshold deprecates", () => {
    expect(shouldAutoDeprecate({ consecutive_failures: 5 })).toBe(true);
  });

  test("above threshold deprecates", () => {
    expect(shouldAutoDeprecate({ consecutive_failures: 10 })).toBe(true);
  });
});

describe("#101 schema drift deprecation", () => {
  function shouldDriftDeprecate(stats: { drift_count: number }): boolean {
    return stats.drift_count >= DRIFT_DEPRECATION_THRESHOLD;
  }

  test("no drift does not deprecate", () => {
    expect(shouldDriftDeprecate({ drift_count: 0 })).toBe(false);
  });

  test("at drift threshold deprecates", () => {
    expect(shouldDriftDeprecate({ drift_count: 3 })).toBe(true);
  });

  test("drift triggers re-verification need", () => {
    const stats = { drift_count: 3, verification_status: "verified" as const };
    const needsReverification = stats.drift_count >= DRIFT_DEPRECATION_THRESHOLD && stats.verification_status === "verified";
    expect(needsReverification).toBe(true);
  });
});
