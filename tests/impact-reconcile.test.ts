// Plan node G4 — reconcile: the YOU numbers must agree across the two faces.
//
// The CLI's "you" cost_saved / time_saved come from the LOCAL impact-log
// (impactFromResult reads result.impact, which buildAgentImpact derives from
// `timing`). The frontend's "you" come from the backend, fed by the analytics
// session POST (buildAnalyticsSessionPayload, also derived from `timing`). If
// those two sinks ever read different numbers for the same run, the CLI and the
// dashboard disagree and the ledger is a lie.
//
// This test pins the invariant at the source: for ONE `timing`, the impact
// envelope (→ local log) and the analytics-session payload (→ backend) carry
// IDENTICAL time_saved_ms and cost_saved_uc. Both derive from `timing`, so they
// reconcile by construction — this guards against a future edit that sources one
// sink from somewhere else.
import { describe, it, expect } from "bun:test";
import { buildAgentImpact } from "../src/agent-outcome.js";
import { buildAnalyticsSessionPayload } from "../src/analytics-session.js";
import { impactFromResult } from "../src/impact-log.js";
import type { OrchestrationTiming } from "../src/types/index.js";

const timing = {
  source: "direct-document",
  cache_hit: false,
  baseline_total_ms: 22000,
  actual_total_ms: 3891,
  time_saved_ms: 18109,
  time_saved_pct: 82,
  tokens_saved: 23859,
  tokens_saved_pct: 80,
  baseline_cost_uc: 90000,
  actual_cost_uc: 18423,
  cost_saved_uc: 71577,
} as unknown as OrchestrationTiming;

describe("impact ↔ analytics-session reconcile (G4)", () => {
  it("the local-log impact and the backend session payload carry the SAME savings", () => {
    const impact = buildAgentImpact(timing)!;
    const session = buildAnalyticsSessionPayload(
      "trace-1",
      "2026-06-18T00:00:00Z",
      timing.source!,
      { completed_at: "2026-06-18T00:00:04Z", success: true, tokens_saved: timing.tokens_saved, tokens_saved_pct: timing.tokens_saved_pct, api_call_count: 1 },
      timing,
    );
    expect(session.time_saved_ms).toBe(impact.time_saved_ms);
    expect(session.cost_saved_uc).toBe(impact.cost_saved_uc);
    expect(session.time_saved_ms).toBe(18109);
    expect(session.cost_saved_uc).toBe(71577);
  });

  it("what the local impact-log persists equals what the session posts (end to end)", () => {
    // The orchestrator attaches `impact` (= buildAgentImpact(timing)) to its result;
    // impactFromResult is what actually gets written to ~/.unbrowse/impact-log.jsonl.
    const result = { impact: buildAgentImpact(timing), error: null };
    const logged = impactFromResult("get", result)!;
    const session = buildAnalyticsSessionPayload(
      "trace-2",
      "2026-06-18T00:00:00Z",
      timing.source!,
      { success: true, api_call_count: 1 },
      timing,
    );
    // The number the user sees in `unbrowse eval stats` (local log) and the number
    // the dashboard aggregates (session POST) are the same measurement.
    expect(logged.cost_saved_uc).toBe(session.cost_saved_uc);
    expect(logged.time_saved_ms).toBe(session.time_saved_ms);
  });

  it("a non-savings source yields no impact and no session savings (no fabrication)", () => {
    const none = { source: "browser-action", cache_hit: false } as unknown as OrchestrationTiming;
    const impact = buildAgentImpact(none);
    // browser-action is a real browse (nothing saved) — both sinks agree it's empty.
    const session = buildAnalyticsSessionPayload("t3", "2026-06-18T00:00:00Z", "browser-action", { api_call_count: 1 }, none);
    expect(session.cost_saved_uc).toBe(impact?.cost_saved_uc);
  });
});
