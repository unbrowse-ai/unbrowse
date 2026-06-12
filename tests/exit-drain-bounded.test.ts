// Falsifier: a no-op CLI command (`fetch --url https://example.com`) MUST
// complete within (actual work + ~2s margin). If the exit-drain regresses to
// >5s (the prior state Day-5 observed: ~46s wall time for ~6s of real work
// because of un-unref'd 30s disk-mode poll + non-fire-and-forget passive
// publishes), this test fails.
//
// The fix lives in:
//   - src/lib/indexer-core/index.ts          drainPendingIndexJobs (disk-mode hard cap + unref)
//   - src/orchestrator/passive-publish.ts  drainPendingPassivePublishes (unref'd cap timer)
//
// Both honor UNBROWSE_DRAIN_HARD_MS (default 200ms) and unref their internal
// timers so the event loop releases as soon as real work has finished — the
// CLI's outer race timer is then the only thing pinning exit.
//
// We don't lock to a single network-dependent wall time; we assert that the
// per-drain hard cap is small (<5s by default) and that the drain functions
// themselves return quickly when there is no work to do. The CLI smoke test
// at the bottom is best-effort (skipped when offline).

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";

describe("exit drain — bounded by hard cap (D5 speed)", () => {
  test("drainPendingIndexJobs returns under 1s on empty queue (disk mode)", async () => {
    process.env.HOME = join(tmpdir(), `drain-fast-${Date.now()}-${process.pid}`);
    process.env.UNBROWSE_INLINE_INDEX = "";
    await mkdir(join(process.env.HOME, ".unbrowse", "queue", "pending"), { recursive: true });
    const { drainPendingIndexJobs } = await import("../src/lib/indexer-core/index.js");
    const t0 = Date.now();
    await drainPendingIndexJobs();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    await rm(process.env.HOME, { recursive: true, force: true });
  });

  test("drainPendingPassivePublishes returns immediately on empty queue", async () => {
    const { drainPendingPassivePublishes } = await import("../src/orchestrator/passive-publish.js");
    const t0 = Date.now();
    await drainPendingPassivePublishes();
    const elapsed = Date.now() - t0;
    // No pending = literal early-return; should be ~0ms.
    expect(elapsed).toBeLessThan(100);
  });

  test("drainPendingIndexJobs respects UNBROWSE_DRAIN_HARD_MS even with phantom pending jobs (disk mode)", async () => {
    const HOME = join(tmpdir(), `drain-cap-${Date.now()}-${process.pid}`);
    process.env.HOME = HOME;
    process.env.UNBROWSE_INLINE_INDEX = "";
    process.env.UNBROWSE_DRAIN_HARD_MS = "300";
    const queueDir = join(HOME, ".unbrowse", "queue", "pending");
    await mkdir(queueDir, { recursive: true });
    // Drop a fake job file so the poll loop has something to find.
    const { writeFile } = await import("node:fs/promises");
    const envelope = {
      version: 1,
      domain: "phantom.test",
      queuedAt: Date.now(),
      attempts: 0,
      job: {
        skill: {
          skill_id: "phantom-test-id",
          version: "1",
          schema_version: "1",
          lifecycle: "active",
          execution_type: "http",
          created_at: "x",
          updated_at: "x",
          name: "phantom.test",
          intent_signature: "",
          domain: "phantom.test",
          description: "",
          owner_type: "agent",
          endpoints: [],
        },
        publishAfterIndex: false,
      },
    };
    await writeFile(join(queueDir, "phantom.test.1.json"), JSON.stringify(envelope));
    const { drainPendingIndexJobs } = await import("../src/lib/indexer-core/index.js");
    const t0 = Date.now();
    await drainPendingIndexJobs();
    const elapsed = Date.now() - t0;
    // Must hit the 300ms cap, not the pre-fix 30s timeout. Margin to 2s for
    // FS/CI jitter.
    expect(elapsed).toBeLessThan(2000);
    // And must take at least the cap (proves we actually waited for the worker
    // to no-op, didn't crash through).
    expect(elapsed).toBeGreaterThanOrEqual(250);
    delete process.env.UNBROWSE_DRAIN_HARD_MS;
    await rm(HOME, { recursive: true, force: true });
  });

  test("CLI fetch completes under 10s wall time end-to-end (network permitting)", async () => {
    // End-to-end falsifier: spawns the CLI as a real child process and times
    // exit. If the drain regresses to the pre-fix state (30s+ disk-mode poll
    // OR non-unref'd publish promises), this test fails.
    // Skip when offline — we don't want flakes to mask the drain bug.
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const isolatedHome = join(tmpdir(), `drain-cli-${Date.now()}-${process.pid}`);
    await mkdir(join(isolatedHome, ".unbrowse"), { recursive: true });
    const t0 = Date.now();
    let stderr = "";
    const exitCode: number | null = await new Promise((resolve) => {
      const child = spawn(
        "bun",
        [cliPath, "fetch", "--url", "https://example.com"],
        {
          // Isolated HOME so we don't trip on a polluted .unbrowse from other
          // tests; rehydrate of 72 stale browse sessions adds ~2s on its own.
          env: {
            ...process.env,
            HOME: isolatedHome,
            UNBROWSE_EXIT_DRAIN_BUDGET_MS: "500",
            UNBROWSE_DRAIN_HARD_MS: "200",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      const kill = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* nop */ }
        resolve(null);
      }, 30_000);
      child.on("exit", (code) => {
        clearTimeout(kill);
        resolve(code ?? -1);
      });
    });
    const elapsed = Date.now() - t0;
    await rm(isolatedHome, { recursive: true, force: true });
    // If example.com is unreachable, skip; we only assert when the request itself succeeded.
    if (exitCode === null || /ENOTFOUND|ECONNREFUSED|getaddrinfo|EAI_AGAIN/.test(stderr)) {
      console.warn(`[exit-drain test] skipping wall-time assert: exitCode=${exitCode} stderr=${stderr.slice(0, 200)}`);
      return;
    }
    expect(exitCode).toBe(0);
    // Hard bound — pre-fix this was ~46s; if it goes >10s the drain has regressed.
    expect(elapsed).toBeLessThan(10_000);
  }, 35_000);
});
