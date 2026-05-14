import { describe, test, expect, it } from "bun:test";
import {
  probeUnbrowseRuntime,
  spawnUnbrowseRuntime,
  locateUnbrowseBinary,
} from "../src/runtime.js";
import { RuntimeUnavailableError } from "../src/errors.js";

describe("runtime - Day 4 wiring", () => {
  // Type contract: returns either a string path or null. We do not pin the
  // exact value because it depends on PATH / the local install state.
  test("locateUnbrowseBinary returns a string path or null", () => {
    const result = locateUnbrowseBinary();
    expect(result === null || typeof result === "string").toBe(true);
  });

  // Real network probe against a deliberately-closed port. Must return
  // false, never throw.
  test("probeUnbrowseRuntime returns false against a closed port", async () => {
    const probed = await probeUnbrowseRuntime("http://127.0.0.1:1", 250);
    expect(probed).toBe(false);
  });

  // Honest seed turned green: Day 4 surfaces RuntimeUnavailableError with
  // cause="binary_missing" when the binary path is bogus.
  test("spawnUnbrowseRuntime throws RuntimeUnavailableError when binary missing", async () => {
    try {
      await spawnUnbrowseRuntime({
        binaryPath: "/nonexistent/unbrowse-bin",
        // Pick an unlikely-to-be-listening port so the adopt-existing
        // short-circuit doesn't accidentally succeed.
        port: 19999,
      });
      throw new Error("expected spawnUnbrowseRuntime to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RuntimeUnavailableError);
      expect((e as RuntimeUnavailableError).cause).toBe("binary_missing");
    }
  });

  // Pure contract test: error class carries `cause` and `attemptedPort`.
  test("RuntimeUnavailableError carries cause and attemptedPort", () => {
    const e = new RuntimeUnavailableError("probe failed", "probe_failed", 6969);
    expect(e.cause).toBe("probe_failed");
    expect(e.attemptedPort).toBe(6969);
    expect(e).toBeInstanceOf(RuntimeUnavailableError);
  });

  // Real spawn: only runs when an unbrowse binary is locatable. Picks a
  // non-default port so it never clashes with a daemon a developer is
  // running. Guarded with skipIf so CI without unbrowse installed stays
  // green.
  const binary = locateUnbrowseBinary();
  it.skipIf(!binary)(
    "spawnUnbrowseRuntime can start and stop a real unbrowse runtime",
    async () => {
      // Per-process port so a leaked daemon from a prior run cannot collide.
      const port = 18000 + (process.pid % 1000);
      const handle = await spawnUnbrowseRuntime({
        port,
        readyTimeoutMs: 60_000,
      });
      try {
        expect(handle.owned).toBe(true);
        expect(handle.baseUrl).toBe(`http://127.0.0.1:${port}`);
        expect(typeof handle.pid).toBe("number");
        const alive = await probeUnbrowseRuntime(handle.baseUrl, 1_000);
        expect(alive).toBe(true);
      } finally {
        await handle.kill();
      }
      // After kill, the listener should release within a short window.
      // Poll for up to ~3s — fastify's graceful shutdown can take a moment.
      let aliveAfter = true;
      for (let i = 0; i < 30 && aliveAfter; i++) {
        await new Promise((r) => setTimeout(r, 100));
        aliveAfter = await probeUnbrowseRuntime(`http://127.0.0.1:${port}`, 200);
      }
      expect(aliveAfter).toBe(false);
    },
    120_000,
  );
});
