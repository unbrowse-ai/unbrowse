/**
 * Unit tests for success-tracker.ts
 *
 * Tests the SuccessTracker class:
 *   - recordExecution() — quality tracking
 *   - recordSale() — sale tracking and earnings
 *   - getStats() — stats retrieval
 *   - getLeaderboard() — ranking by success rate
 *   - getPendingPayouts() — payout eligibility
 *   - recordPayout() — payout recording
 *   - calculatePotentialEarnings() — earnings calculator
 *   - getQualityTier() — tier classification
 *   - getFailureAnalysis() — failure diagnostics
 *
 * Uses a temporary directory for file-based persistence.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SuccessTracker } from "../../success-tracker.js";

// ── Setup / Teardown ─────────────────────────────────────────────────────────

const testDir = join(tmpdir(), `success-tracker-test-${randomUUID()}`);
let tracker: SuccessTracker;

beforeEach(() => {
  // Fresh tracker for each test to avoid cross-contamination
  const subDir = join(testDir, randomUUID());
  tracker = new SuccessTracker(subDir);
});

afterAll(() => {
  try {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  } catch {
    // Cleanup best-effort
  }
});

// ── recordExecution ──────────────────────────────────────────────────────────

describe("recordExecution", () => {
  it("creates stats on first execution", () => {
    const result = tracker.recordExecution("my-skill", "api-package", true, 500);
    expect(result.newSuccessRate).toBe(1);
    expect(result.qualityTier).toBe("Gold");

    const stats = tracker.getStats("my-skill");
    expect(stats).not.toBeNull();
    expect(stats!.skillName).toBe("my-skill");
    expect(stats!.category).toBe("api-package");
    expect(stats!.totalExecutions).toBe(1);
    expect(stats!.successfulExecutions).toBe(1);
    expect(stats!.failedExecutions).toBe(0);
  });

  it("tracks successful executions", () => {
    tracker.recordExecution("skill-a", "api-package", true, 100);
    tracker.recordExecution("skill-a", "api-package", true, 200);
    tracker.recordExecution("skill-a", "api-package", true, 300);

    const stats = tracker.getStats("skill-a");
    expect(stats!.totalExecutions).toBe(3);
    expect(stats!.successfulExecutions).toBe(3);
    expect(stats!.failedExecutions).toBe(0);
    expect(stats!.successRate).toBe(1);
  });

  it("tracks failed executions", () => {
    tracker.recordExecution("skill-b", "api-package", true, 100);
    tracker.recordExecution("skill-b", "api-package", false, 200, 0, undefined, "Timeout");

    const stats = tracker.getStats("skill-b");
    expect(stats!.totalExecutions).toBe(2);
    expect(stats!.successfulExecutions).toBe(1);
    expect(stats!.failedExecutions).toBe(1);
    expect(stats!.successRate).toBe(0.5);
  });

  it("tracks failure steps", () => {
    tracker.recordExecution("skill-c", "workflow", false, 100, 0, undefined, "Error", "step-3");
    tracker.recordExecution("skill-c", "workflow", false, 100, 0, undefined, "Error", "step-3");
    tracker.recordExecution("skill-c", "workflow", false, 100, 0, undefined, "Error", "step-5");

    const stats = tracker.getStats("skill-c");
    expect(stats!.failuresByStep["step-3"]).toBe(2);
    expect(stats!.failuresByStep["step-5"]).toBe(1);
  });

  it("tracks failure errors (truncated to 50 chars)", () => {
    const longError = "A".repeat(100);
    tracker.recordExecution("skill-d", "api-package", false, 100, 0, undefined, longError);

    const stats = tracker.getStats("skill-d");
    const errorKeys = Object.keys(stats!.failuresByError);
    expect(errorKeys).toHaveLength(1);
    expect(errorKeys[0]).toHaveLength(50);
  });

  it("computes duration metrics", () => {
    tracker.recordExecution("skill-e", "api-package", true, 100);
    tracker.recordExecution("skill-e", "api-package", true, 300);
    tracker.recordExecution("skill-e", "api-package", true, 200);

    const stats = tracker.getStats("skill-e");
    expect(stats!.totalDuration).toBe(600);
    expect(stats!.avgDuration).toBe(200);
    expect(stats!.fastestExecution).toBe(100);
    expect(stats!.slowestExecution).toBe(300);
  });

  it("keeps at most 100 recent executions", () => {
    for (let i = 0; i < 110; i++) {
      tracker.recordExecution("skill-f", "api-package", true, 100);
    }

    const stats = tracker.getStats("skill-f");
    expect(stats!.recentExecutions).toHaveLength(100);
    expect(stats!.totalExecutions).toBe(110);
  });

  it("returns quality tier based on success rate", () => {
    // 1 success, 0 failures => 100% => Gold
    const result = tracker.recordExecution("gold-skill", "api-package", true, 100);
    expect(result.qualityTier).toBe("Gold");
  });
});

// ── recordSale ───────────────────────────────────────────────────────────────

describe("recordSale", () => {
  it("records sale and calculates creator earnings (70%)", () => {
    tracker.recordExecution("paid-skill", "api-package", true, 100, 5.0, "wallet123");
    const result = tracker.recordSale("paid-skill", 5.0);

    expect(result.creatorEarnings).toBe(3.5); // 70% of $5
    expect(result.totalSales).toBe(1);
  });

  it("accumulates earnings over multiple sales", () => {
    tracker.recordExecution("multi-sale", "api-package", true, 100, 10.0, "wallet");
    tracker.recordSale("multi-sale", 10.0);
    tracker.recordSale("multi-sale", 10.0);
    tracker.recordSale("multi-sale", 10.0);

    const stats = tracker.getStats("multi-sale");
    expect(stats!.totalEarningsUsdc).toBe(21.0); // 3 * 10 * 0.7
    expect(stats!.totalSales).toBe(3);
  });

  it("returns zero for nonexistent skill", () => {
    const result = tracker.recordSale("nonexistent", 5.0);
    expect(result.creatorEarnings).toBe(0);
    expect(result.totalSales).toBe(0);
  });
});

// ── getStats ─────────────────────────────────────────────────────────────────

describe("getStats", () => {
  it("returns null for nonexistent skill", () => {
    expect(tracker.getStats("no-such-skill")).toBeNull();
  });

  it("returns stats with all expected fields", () => {
    tracker.recordExecution("full-stats", "workflow", true, 250, 2.0, "wallet1");

    const stats = tracker.getStats("full-stats");
    expect(stats).not.toBeNull();
    expect(stats!.skillName).toBe("full-stats");
    expect(stats!.category).toBe("workflow");
    expect(stats!.creatorWallet).toBe("wallet1");
    expect(stats!.priceUsdc).toBe(2.0);
    expect(stats!.createdAt).toBeDefined();
    expect(stats!.lastExecutionAt).toBeDefined();
  });
});

// ── getLeaderboard ───────────────────────────────────────────────────────────

describe("getLeaderboard", () => {
  it("requires minimum 10 executions for ranking", () => {
    // Only 5 executions — should not appear on leaderboard
    for (let i = 0; i < 5; i++) {
      tracker.recordExecution("too-few", "api-package", true, 100);
    }

    const board = tracker.getLeaderboard();
    expect(board).toHaveLength(0);
  });

  it("ranks by success rate descending", () => {
    // Skill A: 10/10 = 100%
    for (let i = 0; i < 10; i++) {
      tracker.recordExecution("skill-perfect", "api-package", true, 100);
    }
    // Skill B: 8/10 = 80%
    for (let i = 0; i < 8; i++) {
      tracker.recordExecution("skill-ok", "api-package", true, 100);
    }
    for (let i = 0; i < 2; i++) {
      tracker.recordExecution("skill-ok", "api-package", false, 100);
    }

    const board = tracker.getLeaderboard();
    expect(board).toHaveLength(2);
    expect(board[0].skillName).toBe("skill-perfect");
    expect(board[1].skillName).toBe("skill-ok");
  });

  it("filters by category", () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordExecution("api-skill", "api-package", true, 100);
      tracker.recordExecution("wf-skill", "workflow", true, 100);
    }

    const apiBoard = tracker.getLeaderboard("api-package");
    expect(apiBoard).toHaveLength(1);
    expect(apiBoard[0].skillName).toBe("api-skill");

    const wfBoard = tracker.getLeaderboard("workflow");
    expect(wfBoard).toHaveLength(1);
    expect(wfBoard[0].skillName).toBe("wf-skill");
  });
});

// ── getPendingPayouts ────────────────────────────────────────────────────────

describe("getPendingPayouts", () => {
  it("returns skills above payout threshold with wallet", () => {
    tracker.recordExecution("payout-skill", "api-package", true, 100, 5.0, "walletABC");
    tracker.recordSale("payout-skill", 5.0); // $3.50 earnings (above $1 threshold)

    const payouts = tracker.getPendingPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0].skillName).toBe("payout-skill");
    expect(payouts[0].amount).toBe(3.5);
    expect(payouts[0].wallet).toBe("walletABC");
  });

  it("excludes skills without wallet", () => {
    tracker.recordExecution("no-wallet", "api-package", true, 100, 5.0);
    tracker.recordSale("no-wallet", 5.0);

    const payouts = tracker.getPendingPayouts();
    expect(payouts).toHaveLength(0);
  });

  it("excludes skills below payout threshold", () => {
    tracker.recordExecution("small-payout", "api-package", true, 100, 0.5, "wallet");
    tracker.recordSale("small-payout", 0.5); // $0.35 earnings (below $1)

    const payouts = tracker.getPendingPayouts();
    expect(payouts).toHaveLength(0);
  });

  it("sorts by amount descending", () => {
    tracker.recordExecution("big", "api-package", true, 100, 10, "w1");
    tracker.recordSale("big", 10.0); // $7.00
    tracker.recordExecution("small", "api-package", true, 100, 5, "w2");
    tracker.recordSale("small", 5.0); // $3.50

    const payouts = tracker.getPendingPayouts();
    expect(payouts[0].skillName).toBe("big");
    expect(payouts[1].skillName).toBe("small");
  });
});

// ── recordPayout ─────────────────────────────────────────────────────────────

describe("recordPayout", () => {
  it("decreases pending payout amount", () => {
    tracker.recordExecution("payout-test", "api-package", true, 100, 10, "wallet");
    tracker.recordSale("payout-test", 10.0); // $7.00 pending

    tracker.recordPayout("payout-test", 7.0, 1, "tx-sig-123");

    const stats = tracker.getStats("payout-test");
    expect(stats!.pendingPayoutUsdc).toBe(0);
    expect(stats!.lastPayoutTimestamp).toBeDefined();
  });
});

// ── calculatePotentialEarnings ───────────────────────────────────────────────

describe("calculatePotentialEarnings", () => {
  it("calculates 70/30 split correctly", () => {
    const earnings = tracker.calculatePotentialEarnings(10, 100);
    expect(earnings.total).toBe(1000);
    expect(earnings.creatorEarnings).toBe(700);
    expect(earnings.platformShare).toBe(300);
  });

  it("returns zero for zero price", () => {
    const earnings = tracker.calculatePotentialEarnings(0, 100);
    expect(earnings.total).toBe(0);
    expect(earnings.creatorEarnings).toBe(0);
    expect(earnings.platformShare).toBe(0);
  });

  it("returns zero for zero executions", () => {
    const earnings = tracker.calculatePotentialEarnings(10, 0);
    expect(earnings.total).toBe(0);
  });
});

// ── getQualityTier ───────────────────────────────────────────────────────────

describe("getQualityTier", () => {
  it("returns Gold for >= 95%", () => {
    expect(tracker.getQualityTier(0.95)).toEqual({ tier: "gold", label: "Gold", earningsMultiplier: 1.5 });
    expect(tracker.getQualityTier(1.0)).toEqual({ tier: "gold", label: "Gold", earningsMultiplier: 1.5 });
  });

  it("returns Silver for >= 85%", () => {
    expect(tracker.getQualityTier(0.85)).toEqual({ tier: "silver", label: "Silver", earningsMultiplier: 1.2 });
    expect(tracker.getQualityTier(0.94)).toEqual({ tier: "silver", label: "Silver", earningsMultiplier: 1.2 });
  });

  it("returns Bronze for >= 70%", () => {
    expect(tracker.getQualityTier(0.70)).toEqual({ tier: "bronze", label: "Bronze", earningsMultiplier: 1.0 });
    expect(tracker.getQualityTier(0.84)).toEqual({ tier: "bronze", label: "Bronze", earningsMultiplier: 1.0 });
  });

  it("returns Unranked for >= 50%", () => {
    expect(tracker.getQualityTier(0.50)).toEqual({ tier: "unranked", label: "Unranked", earningsMultiplier: 0.8 });
    expect(tracker.getQualityTier(0.69)).toEqual({ tier: "unranked", label: "Unranked", earningsMultiplier: 0.8 });
  });

  it("returns Poor for < 50%", () => {
    expect(tracker.getQualityTier(0.49)).toEqual({ tier: "poor", label: "Poor", earningsMultiplier: 0 });
    expect(tracker.getQualityTier(0)).toEqual({ tier: "poor", label: "Poor", earningsMultiplier: 0 });
  });
});

// ── getFailureAnalysis ───────────────────────────────────────────────────────

describe("getFailureAnalysis", () => {
  it("returns empty analysis for nonexistent skill", () => {
    const analysis = tracker.getFailureAnalysis("nonexistent");
    expect(analysis.topFailureSteps).toEqual([]);
    expect(analysis.topErrors).toEqual([]);
    expect(analysis.recommendations).toEqual([]);
  });

  it("returns top failure steps sorted by count", () => {
    tracker.recordExecution("fail-skill", "workflow", false, 100, 0, undefined, "err", "step-1");
    tracker.recordExecution("fail-skill", "workflow", false, 100, 0, undefined, "err", "step-1");
    tracker.recordExecution("fail-skill", "workflow", false, 100, 0, undefined, "err", "step-2");

    const analysis = tracker.getFailureAnalysis("fail-skill");
    expect(analysis.topFailureSteps[0].step).toBe("step-1");
    expect(analysis.topFailureSteps[0].count).toBe(2);
    expect(analysis.topFailureSteps[1].step).toBe("step-2");
  });

  it("recommends fixes for low success rate", () => {
    tracker.recordExecution("bad-skill", "api-package", true, 100);
    tracker.recordExecution("bad-skill", "api-package", false, 100, 0, undefined, "fail");
    tracker.recordExecution("bad-skill", "api-package", false, 100, 0, undefined, "fail");
    tracker.recordExecution("bad-skill", "api-package", false, 100, 0, undefined, "fail");

    const analysis = tracker.getFailureAnalysis("bad-skill");
    expect(analysis.recommendations.length).toBeGreaterThan(0);
    expect(analysis.recommendations.some(r => r.includes("50%"))).toBe(true);
  });

  it("recommends review for dominant failure step", () => {
    // 10 executions: 4 failures on same step (>30% of total)
    for (let i = 0; i < 6; i++) {
      tracker.recordExecution("dom-fail", "workflow", true, 100);
    }
    for (let i = 0; i < 4; i++) {
      tracker.recordExecution("dom-fail", "workflow", false, 100, 0, undefined, "err", "login-step");
    }

    const analysis = tracker.getFailureAnalysis("dom-fail");
    expect(analysis.recommendations.some(r => r.includes("login-step"))).toBe(true);
  });

  it("recommends optimization for slow executions", () => {
    tracker.recordExecution("slow-skill", "api-package", true, 35000);

    const analysis = tracker.getFailureAnalysis("slow-skill");
    expect(analysis.recommendations.some(r => r.includes("30 seconds"))).toBe(true);
  });
});
