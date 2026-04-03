import type { ExecutionTrace, OrchestrationTiming } from "./types/index.js";

export interface AnalyticsSessionPayload {
  session_id: string;
  started_at: string;
  completed_at?: string;
  trace_version?: string;
  api_calls: number;
  discovery_queries: number;
  cached_skill_calls: number;
  fresh_index_calls: number;
  browser_mode: "default" | "replaced" | "manual" | "unknown";
  success?: boolean;
  source?: string;
  time_saved_ms?: number;
  time_saved_pct?: number;
  tokens_saved?: number;
  tokens_saved_pct?: number;
  cost_saved_uc?: number;
}

export function buildAnalyticsSessionPayload(
  sessionId: string,
  startedAt: string,
  source: OrchestrationTiming["source"] | "first-pass",
  trace: Pick<ExecutionTrace, "completed_at" | "trace_version" | "success" | "tokens_saved" | "tokens_saved_pct"> & {
    network_events?: unknown[];
  },
  timing?: Pick<OrchestrationTiming, "time_saved_ms" | "time_saved_pct" | "cost_saved_uc">,
): AnalyticsSessionPayload {
  const cacheLike = source === "marketplace" || source === "route-cache";
  const browserMode = source === "live-capture" || source === "browser-action"
    ? "default"
    : source === "first-pass"
      ? "default"
      : "replaced";
  return {
    session_id: sessionId,
    started_at: startedAt,
    completed_at: trace.completed_at,
    trace_version: trace.trace_version,
    api_calls: Math.max(1, trace.network_events?.length ?? 0),
    discovery_queries: cacheLike ? 1 : 0,
    cached_skill_calls: cacheLike ? 1 : 0,
    fresh_index_calls: source === "live-capture" || source === "first-pass" || source === "browser-action" ? 1 : 0,
    browser_mode: browserMode,
    success: trace.success ?? true,
    source,
    time_saved_ms: timing?.time_saved_ms,
    time_saved_pct: timing?.time_saved_pct,
    tokens_saved: trace.tokens_saved,
    tokens_saved_pct: trace.tokens_saved_pct,
    cost_saved_uc: timing?.cost_saved_uc,
  };
}
