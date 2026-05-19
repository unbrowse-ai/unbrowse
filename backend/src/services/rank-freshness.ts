/**
 * backend/src/services/rank-freshness.ts — Worker-portable copy of the
 * pure freshness signal at src/ranking/freshness.ts.
 *
 * Byte-identical math relocated for the Cloudflare Worker bundle
 * (backend tsconfig rootDir=src cannot import from ../../src/).
 * freshness(d) = 1 / (1 + d/30) — paper arXiv:2604.00694v1 §6.3.
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
