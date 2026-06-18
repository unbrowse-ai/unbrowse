// Pure metric helpers for the contributor dashboard's Network-impact panel. Extracted
// from contributor-dashboard.tsx so the your-share math, bar clamp, and compact number
// formatting are unit-testable (the component itself has no test harness).

/** Compact display of large network counts: 3,120,000 → "3.1M". Rounds for
 *  legibility, never invents a number. */
export function formatCompact(value: number | undefined): string {
  const n = value ?? 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Your share of network executions, as a percentage. Honest ratio of two real
 *  counts; 0 when the network has no executions (no division by zero). */
export function networkSharePct(youExecutions: number, networkExecutions: number): number {
  return networkExecutions > 0 ? (youExecutions / networkExecutions) * 100 : 0;
}

/** Width % for the share bar: a non-zero share stays visible (floor 1.5%) without
 *  ever exceeding 100% or misreporting the underlying number. */
export function shareBarWidth(sharePct: number): number {
  return sharePct <= 0 ? 0 : Math.min(100, Math.max(sharePct, 1.5));
}
