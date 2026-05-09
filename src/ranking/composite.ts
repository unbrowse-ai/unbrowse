/**
 * src/ranking/composite.ts — P2 Wave-1 (Composite Scoring 40/30/15/15).
 *
 * Pure-function implementation of the paper's stated composite-score
 * weights from arXiv:2604.00694v1 §3.3:
 *
 *   composite(sim, reliability, freshness, verification)
 *     = 0.40·sim + 0.30·reliability + 0.15·freshness + 0.15·verification
 *
 * This file is the GREPPABLE source of truth for the four weights — see
 * `PAPER_PLAN.md` §P2 done-when L95: `grep -n "0\\.4\\|0\\.3\\|0\\.15"
 * src/ranking/` MUST show the four constants in one file.
 *
 * NOT YET WIRED INTO RUNTIME RANKING. Wiring is P1 Wave-3 (extract
 * deltas) + P2 Wave-2 (replace inline rankEndpoints scoring with this
 * composite). This module ships only the math.
 *
 * Inputs are expected in [0, 1]. Output in [0, 1] when inputs are. The
 * function does not clamp — clamping is the caller's responsibility, so
 * regression fixtures (P1 W4) can detect out-of-range upstream signals.
 */

export const WEIGHT_SIM = 0.4;
export const WEIGHT_RELIABILITY = 0.3;
export const WEIGHT_FRESHNESS = 0.15;
export const WEIGHT_VERIFICATION = 0.15;

export const COMPOSITE_WEIGHTS = {
  sim: WEIGHT_SIM,
  reliability: WEIGHT_RELIABILITY,
  freshness: WEIGHT_FRESHNESS,
  verification: WEIGHT_VERIFICATION,
} as const;

export function composite(
  sim: number,
  reliability: number,
  freshness: number,
  verification: number,
): number {
  return (
    WEIGHT_SIM * sim +
    WEIGHT_RELIABILITY * reliability +
    WEIGHT_FRESHNESS * freshness +
    WEIGHT_VERIFICATION * verification
  );
}

export function weightsSumToOne(): boolean {
  const sum =
    WEIGHT_SIM + WEIGHT_RELIABILITY + WEIGHT_FRESHNESS + WEIGHT_VERIFICATION;
  return Math.abs(sum - 1) < 1e-9;
}
