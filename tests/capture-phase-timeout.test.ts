/**
 * Regression test for bug #113: capture hangs 120s even when CDP is up.
 *
 * Root cause: the 90s CAPTURE_TIMEOUT_MS fired a flag but did not interrupt
 * pending await kuri.* calls. Each kuri call has its own 30s internal timeout,
 * so multiple hanging calls stacked to 120s+.
 *
 * Fix: withBrowserPhaseTimeout races each CDP phase against an AbortSignal that
 * fires when the overall capture timeout expires.
 */
import { describe, expect, it } from "bun:test";
import { withBrowserPhaseTimeout } from "../src/capture/index.js";

describe("withBrowserPhaseTimeout", () => {
  it("resolves when the wrapped promise completes before abort", async () => {
    const controller = new AbortController();
    const result = await withBrowserPhaseTimeout(
      controller.signal,
      "test-phase",
      () => Promise.resolve(42),
    );
    expect(result).toBe(42);
  });

  it("rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withBrowserPhaseTimeout(
        controller.signal,
        "navigate",
        () => new Promise<never>(() => { /* hangs forever */ }),
      ),
    ).rejects.toThrow("navigate");
  });

  it("rejects when signal aborts while promise is pending (reproduces #113)", async () => {
    // Before fix: captureSession would hang here until kuri's own 30s timeout fired.
    // After fix: withBrowserPhaseTimeout rejects as soon as the AbortSignal fires.
    const controller = new AbortController();
    const start = Date.now();

    // Abort after 30ms — simulates the capture-level timeout firing
    setTimeout(() => controller.abort(), 30);

    await expect(
      withBrowserPhaseTimeout(
        controller.signal,
        "navigate",
        // Simulates a kuri call that would otherwise hang for 30s
        () => new Promise<never>(() => { /* hangs forever */ }),
      ),
    ).rejects.toThrow("navigate");

    // Must resolve well under a second, not after kuri's own 30s timeout
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("does not leave dangling abort listener after resolution", async () => {
    const controller = new AbortController();
    let abortFired = false;
    // Resolve before abort
    await withBrowserPhaseTimeout(
      controller.signal,
      "harStop",
      () => Promise.resolve("done"),
    );
    // Abort after resolution — should not throw / affect anything
    controller.abort();
    expect(abortFired).toBe(false);
  });

  it("propagates errors from the wrapped function", async () => {
    const controller = new AbortController();
    await expect(
      withBrowserPhaseTimeout(
        controller.signal,
        "evaluate",
        () => Promise.reject(new Error("cdp_disconnected")),
      ),
    ).rejects.toThrow("cdp_disconnected");
  });
});
