import type { Env, EndpointStats, ExecutionTrace, VerificationStatus } from "../types.js";
import { getSkill, updateEndpointScore } from "./marketplace.js";
import { statsKV } from "./kv.js";

export const DEPRECATION_THRESHOLD = {
  consecutive_failures: 5,
  min_score: 0.2,
} as const;

export function executionFailureWeight(trace: ExecutionTrace): number {
  const status = trace.status_code ?? 0;
  if (status === 401 || status === 403 || status === 404 || status === 410 || status === 429 || status >= 500) {
    return 3;
  }
  const err = typeof trace.error === "string" ? trace.error : "";
  // Hard "this endpoint is broken/gone" signals — weight as 404-class so two strikes auto-deprecate.
  if (
    err === "stale_endpoint" ||
    err === "endpoint_not_found" ||
    err === "trigger_timeout" ||
    err.includes("vendor_blocked")
  ) {
    return 3;
  }
  return 1;
}

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
  trace: ExecutionTrace,
  executorAgentId?: string,
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
    stats.consecutive_failures += executionFailureWeight(trace);
  }

  if (trace.drift?.drifted) {
    stats.drift_count++;
  }

  stats.avg_latency_ms =
    stats.total_executions === 1
      ? latency
      : stats.avg_latency_ms + (latency - stats.avg_latency_ms) / stats.total_executions;

  // Track version-keyed verification history for public coverage dashboard
  if (trace.trace_version) {
    if (!stats.version_history) stats.version_history = [];
    const existing = stats.version_history.find((v) => v.version === trace.trace_version);
    const entry = { version: trace.trace_version, status: trace.success ? "pass" as const : "fail" as const, verified_at: trace.completed_at, agent_id: executorAgentId };
    if (existing) {
      // Update to latest result for this version
      Object.assign(existing, entry);
    } else {
      stats.version_history.push(entry);
      // Cap history at 50 versions
      if (stats.version_history.length > 50) stats.version_history.shift();
    }
  }

  await saveStats(env, skillId, endpointId, stats);

  const score = computeReliabilityScore(stats);
  const shouldDisable = stats.consecutive_failures >= DEPRECATION_THRESHOLD.consecutive_failures && score < DEPRECATION_THRESHOLD.min_score;
  if (shouldDisable && !stats.auto_deprecated_at) {
    stats.auto_deprecated_at = new Date().toISOString();
    await saveStats(env, skillId, endpointId, stats);
  }

  // Promote unverified → verified when a DIFFERENT agent executes successfully
  let newStatus: VerificationStatus | undefined = shouldDisable ? "disabled" : undefined;
  if (trace.success && executorAgentId && !shouldDisable) {
    const skill = await getSkill(env, skillId);
    const indexerId = skill?.indexer_id;
    if (indexerId && executorAgentId !== indexerId) {
      const endpoint = skill?.endpoints?.find((ep: { endpoint_id: string; verification_status?: string }) => ep.endpoint_id === endpointId);
      if (endpoint?.verification_status === "unverified") {
        newStatus = "verified";
      }
    }
  }

  await updateEndpointScore(env, skillId, endpointId, score, newStatus);
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

export interface ServerReliability {
  reliability_score: number;
  verification_status: VerificationStatus;
  stale: boolean;
  auto_deprecated_at?: string;
  total_observations: number;
}

/**
 * Server-authoritative reliability for a (skill, endpoint).
 *
 * Reliability and staleness are inherently CROSS-USER aggregates: a single
 * client only sees its own outcomes and cannot observe the population. The
 * server holds the canonical EndpointStats and the persisted
 * computeReliabilityScore result, so this is the value resolve should surface
 * as evidence and the value the client should adopt after a reflect outcome,
 * not a locally re-derived guess.
 *
 * It reports the persisted score, the live verification_status, whether the
 * endpoint is server-side stale (the same EVIDENCE-derived predicate the
 * marketplace auto-deprecation gate uses: disabled/failed status, an explicit
 * auto_deprecated_at stamp, or score below the deprecation floor), and the
 * observation count behind the aggregate so the caller can weigh confidence.
 * Never a prescribed verdict, purely a read of observed execution outcomes
 * plus age.
 */
export async function getServerReliability(
  env: Env,
  skillId: string,
  endpointId: string
): Promise<ServerReliability | null> {
  const skill = await getSkill(env, skillId);
  if (!skill) return null;
  const endpoint = skill.endpoints.find((e) => e.endpoint_id === endpointId);
  if (!endpoint) return null;
  const stats = await getStats(env, skillId, endpointId);
  const verificationStatus = (endpoint.verification_status ?? "unverified") as VerificationStatus;
  const reliabilityScore =
    typeof endpoint.reliability_score === "number"
      ? endpoint.reliability_score
      : computeReliabilityScore(stats, verificationStatus);
  const stale =
    verificationStatus === "disabled" ||
    verificationStatus === "failed" ||
    Boolean(stats.auto_deprecated_at) ||
    reliabilityScore < DEPRECATION_THRESHOLD.min_score;
  return {
    reliability_score: reliabilityScore,
    verification_status: verificationStatus,
    stale,
    auto_deprecated_at: stats.auto_deprecated_at,
    total_observations: stats.total_executions + stats.feedback_count,
  };
}

/**
 * Apply one agent reflect outcome (achieved | partial | failed) to the
 * server-authoritative aggregate, then return the recomputed authoritative
 * reliability. The Bayesian-smoothed update is the SAME population machinery
 * recordFeedback runs: a reflect outcome is an observation-bearing feedback
 * signal mapped onto the 1-5 rating scale (achieved=5, partial=3, failed=1).
 * Keeping the smoothing server-side is the point: the client cannot see the
 * population, so it must not compute the aggregate itself.
 */
export async function recordReflectionOutcome(
  env: Env,
  skillId: string,
  endpointId: string,
  outcome: "achieved" | "partial" | "failed"
): Promise<ServerReliability | null> {
  const skill = await getSkill(env, skillId);
  if (!skill) return null;
  const endpoint = skill.endpoints.find((e) => e.endpoint_id === endpointId);
  if (!endpoint) return null;
  // A reflect outcome IS an observed execution result for (skill, endpoint),
  // so it flows through the SAME population channel recordExecution drives:
  // EndpointStats.consecutive_failures + the auto-deprecation gate +
  // computeReliabilityScore. Routing through feedback alone would never move
  // the score (computeReliabilityScore short-circuits at total_executions===0)
  // and would never trip auto-deprecation; staleness has to be observable
  // from real outcomes. achieved => success; failed/partial => non-success
  // (partial carries a soft, weight-1 error so it nudges down without the
  // hard 3x acceleration a 4xx/5xx execution would apply). Plus the rating
  // signal (achieved=5, partial=3, failed=1) so the feedback term tracks too.
  const now = new Date().toISOString();
  const trace: ExecutionTrace = {
    trace_id: `reflect-${skillId}-${endpointId}-${Date.now()}`,
    skill_id: skillId,
    endpoint_id: endpointId,
    started_at: now,
    completed_at: now,
    success: outcome === "achieved",
    ...(outcome === "achieved" ? {} : { error: outcome === "partial" ? "reflect_partial" : "reflect_failed" }),
  };
  await recordExecution(env, skillId, endpointId, trace);
  const rating = outcome === "achieved" ? 5 : outcome === "partial" ? 3 : 1;
  await recordFeedback(env, skillId, endpointId, rating);
  return getServerReliability(env, skillId, endpointId);
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

/**
 * Boost applied to a skill's composite search score when its domain exactly
 * matches the request's domain context.
 */
export const DOMAIN_AFFINITY_BOOST = 0.08;

/**
 * Returns a domain-affinity score bonus in [0, DOMAIN_AFFINITY_BOOST] for use
 * in composite search scoring.  A non-zero bonus is returned only when
 * `skillDomain` and `requestDomain` share the same registrable domain
 * (e.g. "shop.example.com" and "example.com" both yield "example.com").
 */
export function computeDomainAffinityBoost(
  skillDomain: string,
  requestDomain?: string | null,
): number {
  if (!requestDomain) return 0;
  const registrable = (d: string): string => {
    const host = d.replace(/^[a-z]+:\/\//, "").split("/")[0]?.split("?")[0] ?? "";
    const parts = host.replace(/^www\./, "").toLowerCase().split(".").filter(Boolean);
    if (parts.length >= 3) {
      const last2 = parts.slice(-2).join(".");
      if (new Set([
        "co.uk", "co.nz", "co.jp", "co.kr", "co.in",
        "com.br", "com.au", "com.cn", "com.mx", "com.ar", "com.tw",
        "org.uk", "gov.uk", "ac.uk", "net.au", "org.au",
      ]).has(last2)) return parts.slice(-3).join(".");
    }
    return parts.slice(-2).join(".");
  };
  return registrable(skillDomain) === registrable(requestDomain) ? DOMAIN_AFFINITY_BOOST : 0;
}
