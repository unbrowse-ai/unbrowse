import { describe, expect, it } from "bun:test";
import { attributeLifecycle } from "../src/runtime/lifecycle.js";
import type { LifecycleEvent, LifecyclePhase } from "../src/runtime/lifecycle.js";

describe("attributeLifecycle", () => {
  it("sums duration_ms per phase for a single event per phase", () => {
    const events: LifecycleEvent[] = [
      { phase: "capture", skill_id: "s1", timestamp: "2026-01-01T00:00:00Z", duration_ms: 500, source: "live-capture" },
      { phase: "resolve", skill_id: "s1", timestamp: "2026-01-01T00:00:01Z", duration_ms: 200, source: "marketplace" },
      { phase: "publish", skill_id: "s1", timestamp: "2026-01-01T00:00:02Z", duration_ms: 100, source: "marketplace" },
    ];
    const totals = attributeLifecycle(events);
    expect(totals.get("capture")).toBe(500);
    expect(totals.get("resolve")).toBe(200);
    expect(totals.get("publish")).toBe(100);
  });

  it("accumulates multiple events in the same phase", () => {
    const events: LifecycleEvent[] = [
      { phase: "execute", skill_id: "s1", timestamp: "2026-01-01T00:00:00Z", duration_ms: 100, source: "cache" },
      { phase: "execute", skill_id: "s1", timestamp: "2026-01-01T00:00:01Z", duration_ms: 250, source: "cache" },
      { phase: "execute", skill_id: "s1", timestamp: "2026-01-01T00:00:02Z", duration_ms: 50, source: "cache" },
    ];
    const totals = attributeLifecycle(events);
    expect(totals.get("execute")).toBe(400);
  });

  it("returns empty map for empty events array", () => {
    const totals = attributeLifecycle([]);
    expect(totals.size).toBe(0);
  });

  it("handles all five lifecycle phases", () => {
    const phases: LifecyclePhase[] = ["discover", "capture", "resolve", "execute", "publish"];
    const events: LifecycleEvent[] = phases.map((phase, i) => ({
      phase,
      skill_id: "s1",
      timestamp: `2026-01-01T00:00:0${i}Z`,
      duration_ms: (i + 1) * 100,
      source: "live-capture" as const,
    }));
    const totals = attributeLifecycle(events);
    expect(totals.size).toBe(5);
    expect(totals.get("discover")).toBe(100);
    expect(totals.get("capture")).toBe(200);
    expect(totals.get("resolve")).toBe(300);
    expect(totals.get("execute")).toBe(400);
    expect(totals.get("publish")).toBe(500);
  });

  it("handles events from different sources in the same phase", () => {
    const events: LifecycleEvent[] = [
      { phase: "resolve", skill_id: "s1", timestamp: "2026-01-01T00:00:00Z", duration_ms: 50, source: "cache" },
      { phase: "resolve", skill_id: "s1", timestamp: "2026-01-01T00:00:01Z", duration_ms: 300, source: "marketplace" },
    ];
    const totals = attributeLifecycle(events);
    expect(totals.get("resolve")).toBe(350);
  });

  it("handles zero-duration events", () => {
    const events: LifecycleEvent[] = [
      { phase: "publish", skill_id: "s1", timestamp: "2026-01-01T00:00:00Z", duration_ms: 0, source: "cache" },
    ];
    const totals = attributeLifecycle(events);
    expect(totals.get("publish")).toBe(0);
  });

  it("handles events across different skill_ids", () => {
    const events: LifecycleEvent[] = [
      { phase: "capture", skill_id: "s1", timestamp: "2026-01-01T00:00:00Z", duration_ms: 100, source: "live-capture" },
      { phase: "capture", skill_id: "s2", timestamp: "2026-01-01T00:00:01Z", duration_ms: 200, source: "live-capture" },
    ];
    const totals = attributeLifecycle(events);
    // attributeLifecycle sums by phase regardless of skill_id
    expect(totals.get("capture")).toBe(300);
  });
});
