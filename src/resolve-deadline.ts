/**
 * computeResolveDeadlineMs — the outer CLI deadline for /v1/intent/resolve.
 *
 * Must cover the orchestrator's cold-resolve escalation, which runs full browser
 * live-capture up to UNBROWSE_LIVE_CAPTURE_TIMEOUT_MS (default 120s). The old
 * budget_ms+30s (=38s default) abandoned that work mid-flight and emitted a false
 * cli_timeout (#838). Floor the deadline at the live-capture ceiling + 20s margin so
 * the orchestrator returns a real result before the CLI's race fires; fast paths are
 * unaffected (it's an upper cap). UNBROWSE_API_TIMEOUT_MS overrides everything.
 *
 * Pure + env-injectable so it's unit-testable without booting the CLI.
 */
export function computeResolveDeadlineMs(
  budgetMs: number | undefined,
  env: { UNBROWSE_API_TIMEOUT_MS?: string; UNBROWSE_LIVE_CAPTURE_TIMEOUT_MS?: string } = process.env,
): number {
  const apiOverride = Number(env.UNBROWSE_API_TIMEOUT_MS);
  if (Number.isFinite(apiOverride) && apiOverride > 0) return apiOverride;
  const liveCaptureCeilingMs = Number(env.UNBROWSE_LIVE_CAPTURE_TIMEOUT_MS) || 120_000;
  const base = (typeof budgetMs === "number" ? budgetMs : 8000) + 30_000;
  return Math.max(base, liveCaptureCeilingMs + 20_000);
}
