import { describe, expect, it } from "bun:test";
import { withBrowserOpenedTruth, type OrchestratorResult } from "../src/orchestrator/index.js";

function result(browserOpened: boolean): OrchestratorResult {
  return {
    result: {},
    trace: { success: true, latency_ms: 0 },
    source: "route-cache",
    skill: { skill_id: "test", version: "1", schema_version: "1", name: "test", intent_signature: "test", domain: "test", description: "test", owner_type: "agent", owner_id: "test", endpoints: [], auth: { type: "none" }, trust: { score: 1, verified: false }, created_at: "2026-08-02T00:00:00.000Z", updated_at: "2026-08-02T00:00:00.000Z" },
    timing: {
      search_ms: 0, get_skill_ms: 0, execute_ms: 0, browser_opened: browserOpened,
      total_ms: 1, source: "route-cache", cache_hit: true, candidates_found: 1,
      candidates_tried: 1, tokens_saved: 0, response_bytes: 0, time_saved_pct: 0,
      tokens_saved_pct: 0,
    },
  };
}

describe("canonical browser-open telemetry", () => {
  it("projects an explicit false for stateless/cache tasks", () => {
    expect(withBrowserOpenedTruth(result(false)).browser_opened).toBe(false);
  });

  it("projects true from the runtime observation without exposing browser state", () => {
    const projected = withBrowserOpenedTruth(result(true));
    expect(projected.browser_opened).toBe(true);
    expect(Object.keys(projected)).not.toContain("browser");
    expect(Object.keys(projected)).not.toContain("session");
  });
});
