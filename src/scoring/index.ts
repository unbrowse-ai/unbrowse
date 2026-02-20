import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { EndpointStats, ExecutionTrace, VerificationStatus } from "../types/index.js";

const STATS_DIR = process.env.STATS_DIR ?? join(process.cwd(), "stats");

function ensureDir() {
  if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
}

function statsPath(skillId: string, endpointId: string): string {
  return join(STATS_DIR, `${skillId}--${endpointId}.json`);
}

export function getStats(skillId: string, endpointId: string): EndpointStats {
  const file = statsPath(skillId, endpointId);
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as EndpointStats;
    } catch { /* fall through */ }
  }
  return {
    total_executions: 0,
    successful_executions: 0,
    consecutive_failures: 0,
    avg_latency_ms: 0,
    feedback_sum: 0,
    feedback_count: 0,
    drift_count: 0,
  };
}

function saveStats(skillId: string, endpointId: string, stats: EndpointStats): void {
  ensureDir();
  writeFileSync(statsPath(skillId, endpointId), JSON.stringify(stats, null, 2));
}

/**
 * EMA-based reliability score.
 * - Base = success ratio (over total, EMA-weighted recent)
 * - Verification bonus/penalty
 * - Feedback adjustment
 * - Drift penalty
 * - Consecutive failure penalty
 */
export function computeReliabilityScore(
  stats: EndpointStats,
  verificationStatus: VerificationStatus = "unverified"
): number {
  if (stats.total_executions === 0) return 0.5; // prior for new endpoints

  // Base: success ratio with EMA weighting (alpha = 0.15)
  const alpha = 0.15;
  const rawRatio = stats.successful_executions / stats.total_executions;
  // EMA approximation: weight recent consecutive failures heavily
  const emaRatio = rawRatio * (1 - alpha * Math.min(stats.consecutive_failures, 5));
  let score = Math.max(0, emaRatio);

  // Verification bonus/penalty
  if (verificationStatus === "verified") score += 0.10;
  else if (verificationStatus === "failed") score -= 0.20;

  // Feedback adjustment: (avg_rating - 3) * 0.05
  if (stats.feedback_count > 0) {
    const avgRating = stats.feedback_sum / stats.feedback_count;
    score += (avgRating - 3) * 0.05;
  }

  // Drift penalty: -0.05 per drift occurrence, max 3
  score -= 0.05 * Math.min(stats.drift_count, 3);

  // Consecutive failure penalty: -0.10 per failure, max 3
  score -= 0.10 * Math.min(stats.consecutive_failures, 3);

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, score));
}

/**
 * Record an execution result and update the reliability score.
 */
export function recordExecution(
  skillId: string,
  endpointId: string,
  trace: ExecutionTrace,
  updateScore: (skillId: string, endpointId: string, score: number) => void
): void {
  const stats = getStats(skillId, endpointId);
  const latency = new Date(trace.completed_at).getTime() - new Date(trace.started_at).getTime();

  stats.total_executions++;
  stats.last_execution_at = trace.completed_at;

  if (trace.success) {
    stats.successful_executions++;
    stats.consecutive_failures = 0;
    stats.last_success_at = trace.completed_at;
  } else {
    stats.consecutive_failures++;
  }

  if (trace.drift?.drifted) {
    stats.drift_count++;
  }

  // Update running average latency
  stats.avg_latency_ms =
    stats.total_executions === 1
      ? latency
      : stats.avg_latency_ms + (latency - stats.avg_latency_ms) / stats.total_executions;

  saveStats(skillId, endpointId, stats);

  const score = computeReliabilityScore(stats);
  updateScore(skillId, endpointId, score);
}

/**
 * Record feedback and update reliability score.
 * Returns the new average rating.
 */
export function recordFeedback(
  skillId: string,
  endpointId: string,
  rating: number,
  updateScore: (skillId: string, endpointId: string, score: number, status?: VerificationStatus) => void
): number {
  const stats = getStats(skillId, endpointId);
  stats.feedback_sum += rating;
  stats.feedback_count++;
  saveStats(skillId, endpointId, stats);

  const avgRating = stats.feedback_sum / stats.feedback_count;
  const score = computeReliabilityScore(stats);

  // If avg rating drops below 2.0 over last 5+ entries, flag for re-verification
  const status = stats.feedback_count >= 5 && avgRating < 2.0 ? "pending" : undefined;
  updateScore(skillId, endpointId, score, status);

  return avgRating;
}