/**
 * Integration smoke test for `@unbrowse/sdk` v6.15.0.
 *
 * Exercises the SDK end-to-end against a real spawned `unbrowse` binary.
 * Guarded with `it.skipIf(!locateUnbrowseBinary())` so CI without unbrowse
 * installed stays green.
 *
 * Ports 7990-7992 are used to avoid clashing with the default 6969 daemon
 * a developer may have running.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  locateUnbrowseBinary,
  probeUnbrowseRuntime,
  spawnUnbrowseRuntime,
} from "../src/runtime.js";
import { RuntimeUnavailableError } from "../src/errors.js";
import { Unbrowse } from "../src/client.js";

const BINARY = locateUnbrowseBinary();
const READY_TIMEOUT_MS = 60_000;
const PER_TEST_TIMEOUT_MS = 120_000;

/** Wait until `probeUnbrowseRuntime(baseUrl)` returns the expected liveness. */
async function waitForPortLiveness(
  baseUrl: string,
  expectAlive: boolean,
  maxWaitMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const alive = await probeUnbrowseRuntime(baseUrl, 200);
    if (alive === expectAlive) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Pull `status` and a version-shaped field off a HealthResponse for assertions. */
function readHealth(h: unknown): { status: unknown; version: unknown } {
  const obj = (h ?? {}) as { status?: unknown; package_version?: unknown; version?: unknown };
  return { status: obj.status, version: obj.package_version ?? obj.version };
}

describe("integration smoke - v6.15.0 SDK against real binary", () => {
  beforeAll(() => {
    if (!BINARY) {
      // eslint-disable-next-line no-console
      console.log(
        "[integration.smoke] no unbrowse binary found on PATH or via require.resolve — skipping suite",
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(`[integration.smoke] using binary: ${BINARY}`);
    }
  });

  // Golden 1: Unbrowse.local() spawns when nothing is listening, returns a
  // working client, and .close() tears it down.
  it.skipIf(!BINARY)(
    "Golden 1 — Unbrowse.local() probes then spawns",
    async () => {
      const port = 7990;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Sanity check the port is dead before we begin.
      const aliveBefore = await probeUnbrowseRuntime(baseUrl, 250);
      expect(aliveBefore).toBe(false);

      const client = await Unbrowse.local({ port, readyTimeoutMs: READY_TIMEOUT_MS });
      try {
        expect(client).toBeInstanceOf(Unbrowse);
        expect(client.baseUrl).toBe(baseUrl);

        const health = await client.health();
        expect(health).toBeTruthy();
        const { status, version } = readHealth(health);
        // `status` is the only pinned HealthResponse field.
        expect(status).toBe("ok");
        // The running runtime emits either `package_version` (current
        // releases) or `version`; either satisfies the SDK contract.
        expect(typeof version).toBe("string");
      } finally {
        await client.close();
      }

      // After close, the port should be dead within the graceful-shutdown window.
      const died = await waitForPortLiveness(baseUrl, false, 5_000);
      expect(died).toBe(true);
    },
    PER_TEST_TIMEOUT_MS,
  );

  // Golden 2: Unbrowse.connect() does NOT own the daemon. The spawned handle
  // outlives client.close(); only handle.kill() actually stops the process.
  it.skipIf(!BINARY)(
    "Golden 2 — Unbrowse.connect() does not own the daemon",
    async () => {
      const port = 7991;
      const baseUrl = `http://127.0.0.1:${port}`;

      const aliveBefore = await probeUnbrowseRuntime(baseUrl, 250);
      expect(aliveBefore).toBe(false);

      const handle = await spawnUnbrowseRuntime({ port, readyTimeoutMs: READY_TIMEOUT_MS });
      try {
        expect(handle.owned).toBe(true);
        expect(handle.baseUrl).toBe(baseUrl);

        const client = await Unbrowse.connect(baseUrl);
        const health = await client.health();
        const { status, version } = readHealth(health);
        expect(status).toBe("ok");
        expect(typeof version).toBe("string");

        // connect() doesn't own the daemon -> close is a no-op against it.
        await client.close();
        const stillAlive = await probeUnbrowseRuntime(baseUrl, 1_000);
        expect(stillAlive).toBe(true);
      } finally {
        await handle.kill();
      }

      const died = await waitForPortLiveness(baseUrl, false, 5_000);
      expect(died).toBe(true);
    },
    PER_TEST_TIMEOUT_MS,
  );

  // Edge 1: probe against a port nothing listens on never throws and returns false.
  // Not gated on the binary — pure network primitive.
  it(
    "Edge 1 — probeUnbrowseRuntime returns false against a closed port",
    async () => {
      const result = await probeUnbrowseRuntime("http://127.0.0.1:1", 250);
      expect(result).toBe(false);
    },
    10_000,
  );

  // Edge 2: explicit bogus binary path -> RuntimeUnavailableError with
  // cause=binary_missing. Not gated on the binary because we override it.
  it(
    "Edge 2 — spawnUnbrowseRuntime throws RuntimeUnavailableError when binary missing",
    async () => {
      try {
        await spawnUnbrowseRuntime({
          binaryPath: "/no/such/binary",
          // 19998 is unlikely to be occupied; if it IS, the adopt path
          // short-circuits before the binary check.
          port: 19998,
        });
        throw new Error("expected spawnUnbrowseRuntime to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(RuntimeUnavailableError);
        expect((e as RuntimeUnavailableError).cause).toBe("binary_missing");
      }
    },
    10_000,
  );

  // Adversarial 1: two concurrent Unbrowse.local() calls on the same port
  // must NOT race-spawn two daemons. Both must succeed; only one process
  // ends up bound to the port; both .close() calls are safe.
  //
  // If this test fails because two spawns collide on the same port, the
  // lost sheep is in runtime.ts — it needs an in-flight map keyed by port
  // so the second caller awaits the first probe-then-spawn promise.
  it.skipIf(!BINARY)(
    "Adversarial 1 — concurrent local() calls don't double-spawn",
    async () => {
      const port = 7992;
      const baseUrl = `http://127.0.0.1:${port}`;

      const aliveBefore = await probeUnbrowseRuntime(baseUrl, 250);
      expect(aliveBefore).toBe(false);

      const [a, b] = await Promise.all([
        Unbrowse.local({ port, readyTimeoutMs: READY_TIMEOUT_MS }),
        Unbrowse.local({ port, readyTimeoutMs: READY_TIMEOUT_MS }),
      ]);

      try {
        expect(a).toBeInstanceOf(Unbrowse);
        expect(b).toBeInstanceOf(Unbrowse);
        expect(a.baseUrl).toBe(baseUrl);
        expect(b.baseUrl).toBe(baseUrl);

        const ha = await a.health();
        const hb = await b.health();
        expect(readHealth(ha).status).toBe("ok");
        expect(readHealth(hb).status).toBe("ok");
      } finally {
        // First close should kill the owned runtime (if any). Second close
        // must be safe — no double-kill, no throw.
        await a.close();
        await b.close();
      }

      // After both closes, the port must be dead. If two daemons were
      // spawned, the second one would still be holding the port even
      // after both closes ran. (One of them isn't tracked by either
      // client because the second spawn would have lost the bind and
      // either failed or stayed orphaned.)
      const died = await waitForPortLiveness(baseUrl, false, 8_000);
      expect(died).toBe(true);
    },
    PER_TEST_TIMEOUT_MS,
  );
});
