import type { ToolDeps } from "./deps.js";
import { WORKFLOW_STATS_SCHEMA } from "./shared.js";

export function makeUnbrowseWorkflowStatsTool(deps: ToolDeps) {
  const { logger } = deps;

  return {
name: "unbrowse_workflow_stats",
label: "Workflow Stats",
description:
"View success rates, earnings, and failure analysis for skills. Shows leaderboard of " +
"best-performing skills or detailed stats for a specific skill. Skills with higher success " +
"rates earn more (creators paid per successful execution, not per download).",
parameters: WORKFLOW_STATS_SCHEMA,
async execute(_toolCallId: string, params: unknown) {
const p = params as { skillName?: string; category?: "api-package" | "workflow" };

const { getSuccessTracker } = await import("../../success-tracker.js");
const tracker = getSuccessTracker();

if (p.skillName) {
  // Show detailed stats for specific skill
  const stats = tracker.getStats(p.skillName);
  if (!stats) {
    return { content: [{ type: "text", text: `No stats found for: ${p.skillName}` }] };
  }

  const tier = tracker.getQualityTier(stats.successRate);
  const analysis = tracker.getFailureAnalysis(p.skillName);

  const lines = [
    `Stats: ${stats.skillName}`,
    `Category: ${stats.category}`,
    `Quality tier: ${tier.label} (${tier.earningsMultiplier}x earnings)`,
    "",
    `Total executions: ${stats.totalExecutions}`,
    `Successful: ${stats.successfulExecutions}`,
    `Failed: ${stats.failedExecutions}`,
    `Success rate: ${Math.round(stats.successRate * 100)}%`,
    "",
    `Avg duration: ${Math.round(stats.avgDuration)}ms`,
    `Fastest: ${stats.fastestExecution === Infinity ? "N/A" : stats.fastestExecution + "ms"}`,
    `Slowest: ${stats.slowestExecution}ms`,
    "",
    `Total earnings: $${stats.totalEarningsUsdc.toFixed(2)} USDC`,
    `Pending payout: $${stats.pendingPayoutUsdc.toFixed(2)} USDC`,
  ];

  if (analysis.topFailureSteps.length > 0) {
    lines.push("", "Top failure points:");
    for (const fp of analysis.topFailureSteps.slice(0, 3)) {
      lines.push(`  ${fp.step}: ${fp.count} failures`);
    }
  }

  if (analysis.recommendations.length > 0) {
    lines.push("", "Recommendations:");
    for (const rec of analysis.recommendations) {
      lines.push(`  - ${rec}`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
} else {
  // Show leaderboard
  const leaderboard = tracker.getLeaderboard(p.category);
  if (leaderboard.length === 0) {
    return { content: [{ type: "text", text: "No skills with enough executions for ranking yet." }] };
  }

  const lines = [
    `Skill Leaderboard${p.category ? ` (${p.category})` : ""}`,
    "─".repeat(50),
  ];

  for (let i = 0; i < Math.min(leaderboard.length, 10); i++) {
    const s = leaderboard[i];
    const tier = tracker.getQualityTier(s.successRate);
    lines.push(
      `${i + 1}. ${s.skillName} [${tier.label}]`,
      `   ${Math.round(s.successRate * 100)}% success | ${s.totalExecutions} runs | $${s.totalEarningsUsdc.toFixed(2)} earned`
    );
  }

  const pending = tracker.getPendingPayouts();
  if (pending.length > 0) {
    lines.push("", "Pending payouts:");
    for (const p of pending.slice(0, 5)) {
      lines.push(`  ${p.skillName}: $${p.amount.toFixed(2)} USDC → ${p.wallet.slice(0, 8)}...`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
},
};
}
