/**
 * src/ranking/clamps.ts — P1 W3 cleanup wedge (hard-clamp cluster).
 *
 * Score-shaping floors applied AFTER signals fire and AFTER filters reject.
 * The third semantic kind in src/ranking/, sibling to:
 *   - signals/  — what counts (positive scoring contributions)
 *   - filters/  — what doesn't (drops before scoring)
 *   - clamps    — score-reshaping floors (this file)
 *
 * Origin: relocates 3 inline `score = Math.min(...)` statements from
 * `src/execution/index.ts:rankEndpoints` (was at L3758, L3776, L3882) into
 * named constants + one pure function. Behavior is byte-identical:
 *
 *   Math.min(score - 800, -2000)  →  clampToFloor(score, PAGE_ARTIFACT_DEMOTION, HARD_NEGATIVE_FLOOR)
 *   Math.min(score, -400)         →  clampToFloor(score, 0, WEAK_NEGATIVE_FLOOR)
 *
 * Cluster discipline: clamps are NOT signals — they don't add or subtract a
 * delta computed from features; they snap the running score to a guaranteed
 * upper bound (because all floors are negative). A future loop wanting per-
 * feature gating belongs in signals/, not here.
 *
 * Inoculation #2 binds: floors were tuned to bury captured page artifacts
 * under real API siblings; do not adjust without a reproducible benchmark
 * showing the regression they prevented (cluster #1 sibling-coupled API
 * picker).
 */

/**
 * Hardest negative floor — captured page artifacts that have a real API
 * sibling in the corpus get pinned here so the API picker always picks the
 * API. Paired with PAGE_ARTIFACT_DEMOTION at two call sites.
 */
export const HARD_NEGATIVE_FLOOR = -2000;

/**
 * Softer negative floor — comms-intent (DMs, notifications, inbox) on a
 * captured page artifact, where the page might still hold useful skeleton
 * but a real API would always win.
 */
export const WEAK_NEGATIVE_FLOOR = -400;

/**
 * Demotion subtracted from the running score before clamping at
 * HARD_NEGATIVE_FLOOR. Two negative floors and one paired demotion cover
 * every observed clamp call site as of this loop.
 */
export const PAGE_ARTIFACT_DEMOTION = 800;

/**
 * Empty normalized entity bags are SPA/runtime state, not content. They
 * should lose to real timeline/search APIs and often trigger a clean handoff.
 */
export const EMPTY_ENTITY_BAG_DEMOTION = 650;
export const EMPTY_ENTITY_BAG_FLOOR = -700;

/**
 * Pure clamp: subtract `demotion` from `score`, then snap to `floor` as the
 * upper bound (since `floor` is negative, `Math.min` is the right primitive
 * — the clamped score will be ≤ floor regardless of how high the input was).
 *
 * Caller-responsibility: NaN propagates (NaN - n = NaN, Math.min(NaN, n) =
 * NaN). The runtime ranker filters NaN scores upstream; this module does
 * not absorb that contract.
 */
export function clampToFloor(score: number, demotion: number, floor: number): number {
  return Math.min(score - demotion, floor);
}
