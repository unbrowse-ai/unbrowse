import type { Env, EndpointStats, ExecutionTrace, VerificationStatus } from "../types.js";
import { updateEndpointScore } from "./marketplace.js";
import { statsKV } from "./kv.js";

export const DEPRECATION_THRESHOLD = {
  consecutive_failures: 5,
  min_score: 0.2,
} as const;

function statsKey(skillId: string, endpointId: string): string {
  return `stats:${skillId}--${endpointId}`;
}

export async function getStats(env: Env, skillId: string, endpointId: string): Promise<EndpointStats> {
  const raw = await statsKV(env).get(statsKey(skillId, endpointId)) as string | null;
  if (raw) {
    try { return JSON.parse(raw) as EndpointStats; } catch { /* fall through */ }
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

async function saveStats(env: Env, skillId: string, endpointId: string, stats: EndpointStats): Promise<void> {
  await statsKV(env).put(statsKey(skillId, endpointId), JSON.stringify(stats));
}

export function computeReliabilityScore(
  stats: EndpointStats,
  verificationStatus: VerificationStatus = "unverified"
): number {
  if (stats.total_executions === 0) return 0.5;

  const alpha = 0.15;
  const rawRatio = stats.successful_executions / stats.total_executions;
  const emaRatio = rawRatio * (1 - alpha * Math.min(stats.consecutive_failures, 5));
  let score = Math.max(0, emaRatio);

  if (verificationStatus === "verified") score += 0.10;
  else if (verificationStatus === "failed" || verificationStatus === "disabled") score -= 0.20;

  if (stats.feedback_count > 0) {
    const avgRating = stats.feedback_sum / stats.feedback_count;
    score += (avgRating - 3) * 0.05;
  }

  score -= 0.05 * Math.min(stats.drift_count, 3);
  score -= 0.10 * Math.min(stats.consecutive_failures, 3);

  return Math.max(0, Math.min(1, score));
}

export async function recordExecution(
  env: Env,
  skillId: string,
  endpointId: string,
  trace: ExecutionTrace
): Promise<void> {
  const stats = await getStats(env, skillId, endpointId);
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

  stats.avg_latency_ms =
    stats.total_executions === 1
      ? latency
      : stats.avg_latency_ms + (latency - stats.avg_latency_ms) / stats.total_executions;

  await saveStats(env, skillId, endpointId, stats);

  const score = computeReliabilityScore(stats);
  const shouldDisable = stats.consecutive_failures >= DEPRECATION_THRESHOLD.consecutive_failures && score < DEPRECATION_THRESHOLD.min_score;
  if (shouldDisable && !stats.auto_deprecated_at) {
    stats.auto_deprecated_at = new Date().toISOString();
    await saveStats(env, skillId, endpointId, stats);
  }
  await updateEndpointScore(env, skillId, endpointId, score, shouldDisable ? "disabled" : undefined);
}

export async function recordFeedback(
  env: Env,
  skillId: string,
  endpointId: string,
  rating: number
): Promise<number> {
  const stats = await getStats(env, skillId, endpointId);
  stats.feedback_sum += rating;
  stats.feedback_count++;
  await saveStats(env, skillId, endpointId, stats);

  const avgRating = stats.feedback_sum / stats.feedback_count;
  const score = computeReliabilityScore(stats);

  const status = stats.feedback_count >= 5 && avgRating < 2.0 ? "pending" as const : undefined;
  await updateEndpointScore(env, skillId, endpointId, score, status);

  return avgRating;
}

/** Composite search score combining vector similarity, reliability, freshness, and verification */
export function computeCompositeSearchScore(
  vectorSimilarity: number,
  reliability: number,
  updatedAt: string | Date,
  verifiedRatio: number,
): number {
  const daysSince = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  const freshness = 1 / (1 + daysSince / 30);
  const raw = 0.4 * vectorSimilarity + 0.3 * reliability + 0.15 * freshness + 0.15 * verifiedRatio;
  return Math.max(0, Math.min(1, raw));
}
