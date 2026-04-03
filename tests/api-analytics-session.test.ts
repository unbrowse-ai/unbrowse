import { describe, expect, it } from "bun:test";
import { buildAnalyticsSessionPayload } from "../src/api/routes.js";

describe("buildAnalyticsSessionPayload", () => {
  it("derives a browser-backed session payload from live capture results", () => {
    const payload = buildAnalyticsSessionPayload({
      source: "live-capture",
      timing: {
        source: "live-capture",
        time_saved_ms: 4200,
        time_saved_pct: 81,
        tokens_saved: 1200,
        tokens_saved_pct: 40,
        cost_saved_uc: 2500,
      },
      trace: {
        trace_id: "trace-1",
        endpoint_id: "endpoint-1",
        started_at: "2026-04-02T10:00:00.000Z",
        completed_at: "2026-04-02T10:00:01.000Z",
        trace_version: "trace-v1",
        success: true,
      },
    }, {
      discovery_queries: 1,
    });

    expect(payload).toEqual({
      session_id: "trace-1",
      started_at: "2026-04-02T10:00:00.000Z",
      completed_at: "2026-04-02T10:00:01.000Z",
      trace_version: "trace-v1",
      api_calls: 1,
      discovery_queries: 1,
      cached_skill_calls: 0,
      fresh_index_calls: 1,
      browser_mode: "default",
      success: true,
      source: "live-capture",
      time_saved_ms: 4200,
      time_saved_pct: 81,
      tokens_saved: 1200,
      tokens_saved_pct: 40,
      cost_saved_uc: 2500,
    });
  });

  it("defaults missing optional fields safely for manual execute sessions", () => {
    const payload = buildAnalyticsSessionPayload({
      trace: {
        trace_id: "trace-2",
        started_at: "2026-04-02T10:00:00.000Z",
        endpoint_id: undefined,
        completed_at: undefined,
        trace_version: undefined,
        success: undefined,
      },
    }, {
      browser_mode: "manual",
      discovery_queries: 0,
      cached_skill_calls: 0,
      fresh_index_calls: 0,
    });

    expect(payload.session_id).toBe("trace-2");
    expect(payload.api_calls).toBe(0);
    expect(payload.browser_mode).toBe("manual");
    expect(payload.cached_skill_calls).toBe(0);
    expect(payload.fresh_index_calls).toBe(0);
    expect(payload.success).toBe(true);
  });
});
