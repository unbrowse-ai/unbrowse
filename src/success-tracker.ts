/**
 * Success Tracker — Tracks skill execution success for quality metrics.
 *
 * Payment model:
 * - Creators earn per SALE (download) — buyers own the skill forever
 * - Success tracking is for quality metrics and marketplace ranking
 * - High success rate skills rank higher and get more visibility/sales
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SkillCategory } from "./workflow-types.js";

/** Execution record for a single run */
interface ExecutionRecord {
  timestamp: string;
  success: boolean;
  duration: number;
  error?: string;
  failedStep?: string;
  /** USDC earned from this execution (if successful and paid skill) */
  earned?: number;
}

/** Aggregate stats for a skill */
interface SkillStats {
  skillName: string;
  category: SkillCategory;
  creatorWallet?: string;
  priceUsdc: number;

  // Sales metrics (earnings come from sales, not executions)
  totalSales?: number;

  // Execution metrics (for quality tracking)
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;

  // Time metrics
  totalDuration: number;
  avgDuration: number;
  fastestExecution: number;
  slowestExecution: number;

  // Earnings (based on successful executions)
  totalEarningsUsdc: number;
  pendingPayoutUsdc: number;
  lastPayoutTimestamp?: string;

  // Recent history
  recentExecutions: ExecutionRecord[];
  createdAt: string;
  lastExecutionAt?: string;

  // Failure analysis
  failuresByStep: Record<string, number>;
  failuresByError: Record<string, number>;
}

/** Payout record */
interface PayoutRecord {
  timestamp: string;
  amountUsdc: number;
  skillName: string;
  executionCount: number;
  txSignature?: string;
}

export class SuccessTracker {
  private dataDir: string;
  private statsFile: string;
  private payoutsFile: string;

  // Revenue share percentages (applied at time of SALE, not execution)
  private readonly CREATOR_SHARE = 0.70;
  private readonly PLATFORM_SHARE = 0.30;

  // Minimum success rate for marketplace visibility boost
  private readonly HIGH_QUALITY_THRESHOLD = 0.85;

  // Payout threshold (minimum pending to trigger payout)
  private readonly PAYOUT_THRESHOLD = 1.0; // $1 USDC

  constructor(dataDir?: string) {
    this.dataDir = dataDir || join(homedir(), ".openclaw", "success-tracking");
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    this.statsFile = join(this.dataDir, "stats.json");
    this.payoutsFile = join(this.dataDir, "payouts.json");
  }

  /** Record a skill execution (for quality tracking, NOT earnings) */
  recordExecution(
    skillName: string,
    category: SkillCategory,
    success: boolean,
    duration: number,
    priceUsdc: number = 0,
    creatorWallet?: string,
    error?: string,
    failedStep?: string
  ): { newSuccessRate: number; qualityTier: string } {
    const stats = this.loadStats();

    if (!stats[skillName]) {
      stats[skillName] = this.createEmptyStats(skillName, category, priceUsdc, creatorWallet);
    }

    const skill = stats[skillName];
    skill.totalExecutions++;

    const record: ExecutionRecord = {
      timestamp: new Date().toISOString(),
      success,
      duration,
      error,
      failedStep,
    };

    // Track success/failure for quality metrics (NOT for earnings)
    if (success) {
      skill.successfulExecutions++;
    } else {
      skill.failedExecutions++;

      // Track failure points for debugging
      if (failedStep) {
        skill.failuresByStep[failedStep] = (skill.failuresByStep[failedStep] || 0) + 1;
      }
      if (error) {
        const errorKey = error.slice(0, 50); // Truncate long errors
        skill.failuresByError[errorKey] = (skill.failuresByError[errorKey] || 0) + 1;
      }
    }

    // Update metrics
    skill.successRate = skill.successfulExecutions / skill.totalExecutions;
    skill.totalDuration += duration;
    skill.avgDuration = skill.totalDuration / skill.totalExecutions;
    skill.fastestExecution = Math.min(skill.fastestExecution, duration);
    skill.slowestExecution = Math.max(skill.slowestExecution, duration);
    skill.lastExecutionAt = record.timestamp;

    // Keep recent executions (last 100)
    skill.recentExecutions.push(record);
    if (skill.recentExecutions.length > 100) {
      skill.recentExecutions = skill.recentExecutions.slice(-100);
    }

    this.saveStats(stats);

    const tier = this.getQualityTier(skill.successRate);
    return {
      newSuccessRate: skill.successRate,
      qualityTier: tier.label,
    };
  }

  /** Record a sale (when someone downloads/purchases a skill) */
  recordSale(
    skillName: string,
    priceUsdc: number,
    buyerWallet?: string
  ): { creatorEarnings: number; totalSales: number } {
    const stats = this.loadStats();
    const skill = stats[skillName];

    if (!skill) {
      return { creatorEarnings: 0, totalSales: 0 };
    }

    const creatorEarnings = priceUsdc * this.CREATOR_SHARE;
    skill.totalEarningsUsdc += creatorEarnings;
    skill.pendingPayoutUsdc += creatorEarnings;

    // Track sale count (reuse totalExecutions field or add new)
    if (!skill.totalSales) skill.totalSales = 0;
    skill.totalSales++;

    this.saveStats(stats);

    return {
      creatorEarnings,
      totalSales: skill.totalSales,
    };
  }

  /** Get stats for a skill */
  getStats(skillName: string): SkillStats | null {
    const stats = this.loadStats();
    return stats[skillName] || null;
  }

  /** Get all skills sorted by success rate */
  getLeaderboard(category?: SkillCategory): SkillStats[] {
    const stats = this.loadStats();
    let skills = Object.values(stats);

    if (category) {
      skills = skills.filter((s) => s.category === category);
    }

    return skills
      .filter((s) => s.totalExecutions >= 10) // Minimum executions for ranking
      .sort((a, b) => b.successRate - a.successRate);
  }

  /** Get skills eligible for payout */
  getPendingPayouts(): Array<{ skillName: string; amount: number; wallet: string }> {
    const stats = this.loadStats();
    const pending: Array<{ skillName: string; amount: number; wallet: string }> = [];

    for (const skill of Object.values(stats)) {
      if (
        skill.pendingPayoutUsdc >= this.PAYOUT_THRESHOLD &&
        skill.creatorWallet
      ) {
        pending.push({
          skillName: skill.skillName,
          amount: skill.pendingPayoutUsdc,
          wallet: skill.creatorWallet,
        });
      }
    }

    return pending.sort((a, b) => b.amount - a.amount);
  }

  /** Record a payout (after Solana transaction) */
  recordPayout(
    skillName: string,
    amountUsdc: number,
    executionCount: number,
    txSignature?: string
  ): void {
    const stats = this.loadStats();
    const skill = stats[skillName];

    if (skill) {
      skill.pendingPayoutUsdc -= amountUsdc;
      skill.lastPayoutTimestamp = new Date().toISOString();
      this.saveStats(stats);
    }

    // Record in payouts log
    const payouts = this.loadPayouts();
    payouts.push({
      timestamp: new Date().toISOString(),
      amountUsdc,
      skillName,
      executionCount,
      txSignature,
    });
    this.savePayouts(payouts);
  }

  /** Calculate earnings for a hypothetical number of successful executions */
  calculatePotentialEarnings(priceUsdc: number, successfulExecutions: number): {
    creatorEarnings: number;
    platformShare: number;
    total: number;
  } {
    const total = priceUsdc * successfulExecutions;
    return {
      creatorEarnings: total * this.CREATOR_SHARE,
      platformShare: total * this.PLATFORM_SHARE,
      total,
    };
  }

  /** Get quality tier for a skill based on success rate */
  getQualityTier(successRate: number): {
    tier: "gold" | "silver" | "bronze" | "unranked" | "poor";
    label: string;
    earningsMultiplier: number;
  } {
    if (successRate >= 0.95) {
      return { tier: "gold", label: "Gold", earningsMultiplier: 1.5 };
    }
    if (successRate >= 0.85) {
      return { tier: "silver", label: "Silver", earningsMultiplier: 1.2 };
    }
    if (successRate >= 0.70) {
      return { tier: "bronze", label: "Bronze", earningsMultiplier: 1.0 };
    }
    if (successRate >= 0.50) {
      return { tier: "unranked", label: "Unranked", earningsMultiplier: 0.8 };
    }
    return { tier: "poor", label: "Poor", earningsMultiplier: 0 };
  }

  /** Get failure analysis for a skill */
  getFailureAnalysis(skillName: string): {
    topFailureSteps: Array<{ step: string; count: number }>;
    topErrors: Array<{ error: string; count: number }>;
    recommendations: string[];
  } {
    const stats = this.getStats(skillName);
    if (!stats) {
      return { topFailureSteps: [], topErrors: [], recommendations: [] };
    }

    const topFailureSteps = Object.entries(stats.failuresByStep)
      .map(([step, count]) => ({ step, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const topErrors = Object.entries(stats.failuresByError)
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const recommendations: string[] = [];

    if (stats.successRate < 0.5) {
      recommendations.push("Success rate below 50%. Skill is not earning. Fix the most common failures.");
    }

    if (topFailureSteps[0]?.count > stats.totalExecutions * 0.3) {
      recommendations.push(
        `Step "${topFailureSteps[0].step}" fails in ${Math.round(
          (topFailureSteps[0].count / stats.totalExecutions) * 100
        )}% of executions. Review this step.`
      );
    }

    if (stats.avgDuration > 30000) {
      recommendations.push("Average execution time is over 30 seconds. Consider optimizing slow steps.");
    }

    return { topFailureSteps, topErrors, recommendations };
  }

  /** Create empty stats object */
  private createEmptyStats(
    skillName: string,
    category: SkillCategory,
    priceUsdc: number,
    creatorWallet?: string
  ): SkillStats {
    return {
      skillName,
      category,
      creatorWallet,
      priceUsdc,
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      successRate: 0,
      totalDuration: 0,
      avgDuration: 0,
      fastestExecution: Infinity,
      slowestExecution: 0,
      totalEarningsUsdc: 0,
      pendingPayoutUsdc: 0,
      recentExecutions: [],
      createdAt: new Date().toISOString(),
      failuresByStep: {},
      failuresByError: {},
    };
  }

  /** Load stats from file */
  private loadStats(): Record<string, SkillStats> {
    if (!existsSync(this.statsFile)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(this.statsFile, "utf-8"));
    } catch {
      return {};
    }
  }

  /** Save stats to file */
  private saveStats(stats: Record<string, SkillStats>): void {
    writeFileSync(this.statsFile, JSON.stringify(stats, null, 2), "utf-8");
  }

  /** Load payouts from file */
  private loadPayouts(): PayoutRecord[] {
    if (!existsSync(this.payoutsFile)) {
      return [];
    }
    try {
      return JSON.parse(readFileSync(this.payoutsFile, "utf-8"));
    } catch {
      return [];
    }
  }

  /** Save payouts to file */
  private savePayouts(payouts: PayoutRecord[]): void {
    writeFileSync(this.payoutsFile, JSON.stringify(payouts, null, 2), "utf-8");
  }
}

/** Singleton instance */
let trackerInstance: SuccessTracker | null = null;

export function getSuccessTracker(dataDir?: string): SuccessTracker {
  if (!trackerInstance) {
    trackerInstance = new SuccessTracker(dataDir);
  }
  return trackerInstance;
}
