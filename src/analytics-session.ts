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
}

export function buildAnalyticsSessionPayload(
  sessionId: string,
  startedAt: string,
  source: OrchestrationTiming["source"],
  trace: Pick<ExecutionTrace, "completed_at" | "network_events" | "trace_version">,
): AnalyticsSessionPayload {
  const cacheLike = source === "marketplace" || source === "route-cache" || source === "first-pass";
  return {
    session_id: sessionId,
    started_at: startedAt,
    completed_at: trace.completed_at,
    trace_version: trace.trace_version,
    api_calls: Math.max(1, trace.network_events?.length ?? 0),
    discovery_queries: cacheLike ? 1 : 0,
    cached_skill_calls: cacheLike ? 1 : 0,
    fresh_index_calls: source === "live-capture" ? 1 : 0,
    browser_mode: "unknown",
  };
}
