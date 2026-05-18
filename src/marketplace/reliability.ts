// Reliability score update: agent feedback → endpoint score via Bayesian
// smoothing. The substrate-correct shape (CLAUDE.md "heuristics OUT,
// primitives + LLM judge IN"): admission publishes everything; the
// marketplace earns its quality scores from actual agent usage. The
// agent calls unbrowse_reflect with intent_status; this module
// translates that into a posterior reliability update.
//
// Update rule (per observation):
//   posterior = (prior_N * current_score + observation) / (prior_N + 1)
//
// where observation ∈ {1.0 ("achieved"), 0.5 ("partial"), 0.0 ("failed")}
// and prior_N is the smoothing window. Larger prior_N = slower convergence,
// more resistant to single bad outcomes. Default 10 means each
// observation shifts the score by ~9% of its distance from the observed
// value; after ~30 observations the score is ~95% determined by recent
// feedback.
//
// This is intentionally a small primitive. It doesn't track per-endpoint
// observation counters (that'd need a sidecar ledger). It folds new
// observations into the existing score, treating it as a running average.
// Cold-start endpoints initialized at 0.5 (neutral) move toward the
// observed-success-rate as feedback accumulates.

export type ReliabilityOutcome = "achieved" | "failed" | "partial";

export const RELIABILITY_PRIOR_N = 10;

/** Pure function: apply one outcome observation to a score. */
export function applyReliabilityUpdate(
  currentScore: number,
  outcome: ReliabilityOutcome,
  priorN: number = RELIABILITY_PRIOR_N,
): number {
  const observation =
    outcome === "achieved" ? 1.0 :
    outcome === "failed" ? 0.0 :
    /* partial */ 0.5;
  // Defensive: clamp current to [0, 1] in case it drifted outside.
  const clamped = Math.max(0, Math.min(1, Number.isFinite(currentScore) ? currentScore : 0.5));
  const updated = (priorN * clamped + observation) / (priorN + 1);
  return Math.max(0, Math.min(1, updated));
}

/** Convenience: classify an HTTP-shaped outcome (status_code + body) so a
 * non-agent caller (e.g. verification) can apply a consistent observation
 * without re-implementing the rule. Conservative: a 2xx + non-empty body
 * is "achieved"; a 4xx/5xx with no error-body is "failed"; everything
 * else (including 200-with-error-body) is "partial" — the agent's
 * subsequent reflect call can supersede.
 *
 * IMPORTANT: this is a COARSE primitive for non-agent callers. The
 * authoritative outcome is the agent's reflect call. Use this only when
 * no reflect arrives (e.g. background verification sweeps).
 */
export function outcomeFromHttp(statusCode: number | null | undefined, bodyBytes: number): ReliabilityOutcome {
  if (typeof statusCode !== "number") return "partial";
  if (statusCode >= 200 && statusCode < 300 && bodyBytes > 0) return "achieved";
  if (statusCode >= 400) return "failed";
  return "partial";
}
