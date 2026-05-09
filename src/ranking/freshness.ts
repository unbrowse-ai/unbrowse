/**
 * src/ranking/freshness.ts — P2 Wave-1 (freshness decay).
 *
 * Implements the paper's freshness function from arXiv:2604.00694v1 §6.3:
 *
 *     freshness(d) = 1 / (1 + d/30)     where d = days since last update
 *
 * Properties enforced by `tests/composite-scoring.test.ts`:
 *   - freshness(0)        === 1.0
 *   - freshness(30)       === 0.5
 *   - freshness(Infinity) → 0
 *   - monotonically non-increasing in `daysAgo`
 *   - never returns < 0 for any non-negative `daysAgo`
 *
 * Negative `daysAgo` (a future timestamp) is clamped to 0 so the function
 * never returns > 1.
 *
 * NOT YET WIRED INTO RUNTIME RANKING. P2 W2 consumes this from the
 * unified ranker after P1 W2-W4 land.
 */

const FRESHNESS_HALF_LIFE_DAYS = 30;

export function freshness(daysAgo: number): number {
  if (!Number.isFinite(daysAgo)) return 0;
  const d = Math.max(0, daysAgo);
  return 1 / (1 + d / FRESHNESS_HALF_LIFE_DAYS);
}

export function freshnessFromDate(
  lastSeen: Date | string | number,
  now: Date | number = Date.now(),
): number {
  const lastMs =
    lastSeen instanceof Date
      ? lastSeen.getTime()
      : typeof lastSeen === "number"
        ? lastSeen
        : Date.parse(lastSeen);
  if (!Number.isFinite(lastMs)) return 0;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const daysAgo = (nowMs - lastMs) / (1000 * 60 * 60 * 24);
  return freshness(daysAgo);
}
