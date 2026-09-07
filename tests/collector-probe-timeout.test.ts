// W0: per-probe timeout wrapper for scripts/mcp-gate-parallel-collect.ts.
// The collector hung 3+ runs at random points on auth-cookies and
// hostile lanes (browse-strict phase=run elapsed=470116ms), killing the
// whole collector and leaving gate.json unmeasurable. The wrapper races
// each probe against UNBROWSE_GATE_PROBE_TIMEOUT_MS (default 90s) so a
// stuck probe records a crashed_during_collect marker and the worker
// pool keeps moving.
//
// Real-runtime, no mocks: actual setTimeout against actual promises.

import { describe, expect, test } from "bun:test";
import {
  ProbeTimeoutError,
  parseProbeTimeoutMs,
  withProbeTimeout,
} from "../scripts/mcp-gate-parallel-helpers.js";

describe("W0: per-probe timeout wrapper", () => {
  test("fast task resolves with its real value before the timeout fires", async () => {
    const result = await withProbeTimeout("probe-fast", 1000, async () => {
      return { done: true, payload: "real-data" };
    });
    expect(result).toEqual({ done: true, payload: "real-data" });
  });

  test("slow task exceeding timeout rejects with ProbeTimeoutError", async () => {
    let rejected: unknown = null;
    try {
      await withProbeTimeout("probe-slow", 50, async () => {
        await new Promise((r) => setTimeout(r, 500));
        return "should-never-return";
      });
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeInstanceOf(ProbeTimeoutError);
    expect((rejected as ProbeTimeoutError).probe_id).toBe("probe-slow");
    expect((rejected as ProbeTimeoutError).ms).toBe(50);
    expect((rejected as Error).message).toContain("probe-slow");
    expect((rejected as Error).message).toContain("50");
  });

  test("timeout clears its setTimeout when task resolves first (no zombie timer)", async () => {
    // Run a fast task; if the timer was not cleared, the test would
    // exit-hang waiting for the 60s timeout to fire. Bun's test runner
    // would report a slow test, which counts as a regression.
    const t0 = Date.now();
    await withProbeTimeout("probe-clean", 60_000, async () => "fast");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
  });
});

describe("W0: parseProbeTimeoutMs", () => {
  test("returns default 90000 for unset / empty / non-numeric", () => {
    expect(parseProbeTimeoutMs(undefined)).toBe(90_000);
    expect(parseProbeTimeoutMs(null)).toBe(90_000);
    expect(parseProbeTimeoutMs("")).toBe(90_000);
    expect(parseProbeTimeoutMs("not-a-number")).toBe(90_000);
    expect(parseProbeTimeoutMs("0")).toBe(90_000);
    expect(parseProbeTimeoutMs("-1000")).toBe(90_000);
  });

  test("returns the requested value when given a numeric string above the floor", () => {
    expect(parseProbeTimeoutMs("30000")).toBe(30_000);
    expect(parseProbeTimeoutMs("120000")).toBe(120_000);
    expect(parseProbeTimeoutMs(" 10000 ")).toBe(10_000);
  });

  test("floors values below 5000ms at 5000ms (cannot accidentally pass too-small)", () => {
    expect(parseProbeTimeoutMs("1")).toBe(5_000);
    expect(parseProbeTimeoutMs("4999")).toBe(5_000);
    expect(parseProbeTimeoutMs("5000")).toBe(5_000);
    expect(parseProbeTimeoutMs("5001")).toBe(5_001);
  });
});
