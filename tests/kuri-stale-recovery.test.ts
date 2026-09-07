/**
 * tests/kuri-stale-recovery.test.ts
 *
 * Verifies that after a kuri broker process is force-killed (kill -9), a
 * fresh broker can bind the SAME port and become healthy within a short
 * deadline. This is the recovery edge that CLAUDE.md flags: stale procs
 * are the #1 cause of "works from source, broken from package".
 *
 * Constraints:
 *  - HEADLESS=true so the managed Chrome that kuri spawns is invisible.
 *  - High random port (30000-40000) to avoid colliding with running services.
 *  - afterAll always pkills kuri/chrome.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const KURI_BIN = "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/packages/skill/vendor/kuri/darwin-arm64/kuri";
const RECOVERY_DEADLINE_MS = 5_000;
const STARTUP_DEADLINE_MS = 15_000;

function pickPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

function killEverything() {
  spawnSync("pkill", ["-9", "-f", "kuri|chrome"], { stdio: "ignore" });
}

async function waitHealthy(port: number, deadlineMs: number): Promise<{ ok: boolean; elapsedMs: number }> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(400),
      });
      if (res.ok) return { ok: true, elapsedMs: Date.now() - start };
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, elapsedMs: Date.now() - start };
}

function spawnKuri(port: number) {
  return spawn(KURI_BIN, [], {
    env: {
      ...process.env,
      HEADLESS: "true",
      PORT: String(port),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeAll(() => {
  if (!existsSync(KURI_BIN)) {
    throw new Error(`kuri binary missing at ${KURI_BIN}`);
  }
  killEverything();
});

afterAll(() => {
  killEverything();
});

test("kuri rebinds port immediately after kill -9 of a previous broker", async () => {
  const port = pickPort();

  // --- run 1 ---
  const proc1 = spawnKuri(port);
  const ready1 = await waitHealthy(port, STARTUP_DEADLINE_MS);
  expect(ready1.ok, `run1 never became healthy (waited ${ready1.elapsedMs}ms)`).toBe(true);

  // Force quit (no graceful shutdown — simulates crash / pkill -9).
  if (proc1.pid) process.kill(proc1.pid, "SIGKILL");
  // Give kernel a beat to release the listening socket and reap children.
  await new Promise((r) => setTimeout(r, 500));
  // Tear down the managed Chrome that run1 spawned, otherwise run2's
  // Chrome could clash on its CDP port (a different failure mode than
  // the one this test targets).
  spawnSync("pkill", ["-9", "-f", "chrome"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));

  // --- run 2: same port ---
  const proc2 = spawnKuri(port);
  const ready2 = await waitHealthy(port, RECOVERY_DEADLINE_MS + STARTUP_DEADLINE_MS);

  // Capture stderr if it failed, for operator-actionable diagnosis.
  let stderr2 = "";
  proc2.stderr?.on("data", (b: Buffer) => { stderr2 += b.toString(); });

  if (!ready2.ok) {
    const msg = [
      `run2 failed to bind port ${port} within ${ready2.elapsedMs}ms.`,
      `If this is consistent on this kernel, the listen socket is being held`,
      `(LISTEN-side TIME_WAIT or kuri lacks SO_REUSEADDR). Action:`,
      `  1) bump KURI_SPAWN_RETRIES in src/kuri/client.ts (currently 3)`,
      `  2) increase KURI_SPAWN_RETRY_DELAY_MS past kernel TIME_WAIT (default 60s on darwin)`,
      `  3) or add SO_REUSEADDR to the kuri Zig listener.`,
      `kuri stderr (run2): ${stderr2.slice(-400)}`,
    ].join("\n");
    if (proc2.pid) process.kill(proc2.pid, "SIGKILL");
    throw new Error(msg);
  }

  expect(ready2.elapsedMs).toBeLessThan(RECOVERY_DEADLINE_MS + STARTUP_DEADLINE_MS);

  if (proc2.pid) process.kill(proc2.pid, "SIGKILL");
}, 60_000);
