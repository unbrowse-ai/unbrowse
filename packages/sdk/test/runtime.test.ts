import { describe, test, expect } from "bun:test";
import {
  probeUnbrowseRuntime,
  spawnUnbrowseRuntime,
  locateUnbrowseBinary,
} from "../src/runtime.js";
import { RuntimeUnavailableError } from "../src/errors.js";

describe("runtime - Day 3 seeds", () => {
  // Painted-lamp guard: Day-3 stub returns null, Day-4 must keep returning
  // null when no binary is wired (or null if binary missing on PATH).
  test("locateUnbrowseBinary returns null when nothing wired", () => {
    expect(locateUnbrowseBinary()).toBeNull();
  });

  // Honest seed: Day 4 must probe a real runtime. Today the call throws
  // "not yet implemented" and the assertion below fails — this is the
  // failing-test-first contract for Luminaries.
  test("probeUnbrowseRuntime returns false against a closed port", async () => {
    const probed = await probeUnbrowseRuntime("http://127.0.0.1:1", 250);
    expect(probed).toBe(false);
  });

  // Honest seed: Day 4 must surface RuntimeUnavailableError instead of a
  // bare Error. Today's stub throws Error("not yet implemented"), so the
  // assertion below fails until Day 4 wires the spawn ladder.
  test("spawnUnbrowseRuntime throws RuntimeUnavailableError when binary missing", async () => {
    await expect(
      spawnUnbrowseRuntime({ binaryPath: "/nonexistent/unbrowse-bin" }),
    ).rejects.toBeInstanceOf(RuntimeUnavailableError);
  });

  // Pure contract test: error class carries `cause` and `attemptedPort`.
  // Passes today; pins the typed-error shape so Day 4 cannot regress it.
  test("RuntimeUnavailableError carries cause and attemptedPort", () => {
    const e = new RuntimeUnavailableError("probe failed", "probe_failed", 6969);
    expect(e.cause).toBe("probe_failed");
    expect(e.attemptedPort).toBe(6969);
    expect(e).toBeInstanceOf(RuntimeUnavailableError);
  });
});
