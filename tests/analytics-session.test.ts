import { describe, expect, it } from "bun:test";
import { buildAnalyticsSessionPayload } from "../src/analytics-session.js";

describe("analytics session payload", () => {
  it("treats marketplace paths as cached discovery-backed sessions", () => {
    const payload = buildAnalyticsSessionPayload(
      "sess-1",
      "2026-04-02T00:00:00.000Z",
      "marketplace",
      {
        completed_at: "2026-04-02T00:00:01.000Z",
        network_events: [{}, {}],
        success: true,
        tokens_saved: 2200,
        tokens_saved_pct: 73,
      },
      {
        time_saved_ms: 18000,
        time_saved_pct: 82,
        cost_saved_uc: 900,
      },
    );

    expect(payload).toEqual({
      session_id: "sess-1",
      started_at: "2026-04-02T00:00:00.000Z",
      completed_at: "2026-04-02T00:00:01.000Z",
      trace_version: undefined,
      api_calls: 2,
      discovery_queries: 1,
      cached_skill_calls: 1,
      fresh_index_calls: 0,
      browser_mode: "replaced",
      success: true,
      source: "marketplace",
      time_saved_ms: 18000,
      time_saved_pct: 82,
      tokens_saved: 2200,
      tokens_saved_pct: 73,
      cost_saved_uc: 900,
    });
  });

  it("treats live capture as fresh indexing work", () => {
    const payload = buildAnalyticsSessionPayload("sess-2", "2026-04-02T00:00:00.000Z", "live-capture", {
      completed_at: "2026-04-02T00:00:05.000Z",
      network_events: [],
      trace_version: "abc123@def456",
      success: true,
    });

    expect(payload.api_calls).toBe(1);
    expect(payload.trace_version).toBe("abc123@def456");
    expect(payload.discovery_queries).toBe(0);
    expect(payload.cached_skill_calls).toBe(0);
    expect(payload.fresh_index_calls).toBe(1);
    expect(payload.browser_mode).toBe("default");
    expect(payload.success).toBe(true);
    expect(payload.source).toBe("live-capture");
  });
});
