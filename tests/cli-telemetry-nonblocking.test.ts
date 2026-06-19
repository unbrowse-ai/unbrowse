/**
 * Luminary / regression guard: CLI hot-path telemetry must be FIRE-AND-FORGET.
 *
 * `recordFunnelTelemetryEvent` → `postTelemetry` is a fetch with a 5s timeout; with
 * no backend reachable, AWAITING it on a hot path stalled warm search/run/execute by
 * up to 5s per call (the bug fixed 2026-06-20). The events resolve_started/
 * resolve_completed/search_started/search_completed are hot-path-exclusive, so they
 * must always be `void recordFunnelTelemetryEvent(...).catch(...)`, never `await`ed.
 * This test fails the instant someone re-introduces the blocking pattern.
 *   bun test tests/cli-telemetry-nonblocking.test.ts
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");

describe("CLI hot-path telemetry is fire-and-forget (latency regression guard)", () => {
  for (const ev of ["resolve_started", "resolve_completed", "search_started", "search_completed"]) {
    it(`never awaits ${ev} telemetry`, () => {
      expect(cli).not.toMatch(new RegExp(`await\\s+recordFunnelTelemetryEvent\\(\\s*["']${ev}["']`));
    });
  }
  it("hot-path events are still fired (fire-and-forget), not dropped", () => {
    expect(cli).toMatch(/void recordFunnelTelemetryEvent\(\s*["']resolve_started["']/);
    expect(cli).toMatch(/void recordFunnelTelemetryEvent\(\s*["']search_started["']/);
  });
});
