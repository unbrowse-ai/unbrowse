// Disk-queue end-to-end test — Day 6 dominion.
// Proves: process A writes a job to disk and exits; detached process B drains it.
// No mocks. Real spawn, real filesystem.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeJob, type JobEnvelope } from "../src/indexer/queue-store.js";
import type { BackgroundIndexJob } from "../src/indexer/index.js";

const REPO_ROOT = resolve(__dirname, "..");

function makeJob(domain: string): BackgroundIndexJob {
  return {
    skill: {
      name: "x",
      version: "1.0",
      domain,
      endpoints: [],
    } as any,
    domain,
    intent: "e2e test",
    cacheKey: `k-${domain}`,
  };
}

function envelope(domain: string): JobEnvelope {
  return {
    version: 1,
    domain,
    queuedAt: Date.now(),
    attempts: 0,
    job: makeJob(domain),
  };
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runDrain(fakeHome: string, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["src/cli.ts", "__drain-queue"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: fakeHome,
        UNBROWSE_API_URL: "http://127.0.0.1:1",
        UNBROWSE_NO_SWEEP: "0",
        // Drainer must run the disk path, not inherit the test runner's inline mode.
        UNBROWSE_INLINE_INDEX: "",
      },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`drain spawn timed out after ${timeoutMs}ms; stderr=${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
}

describe("disk-queue end-to-end", () => {
  let fakeHome: string;
  let queueDir: string;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "unbrowse-jl-e2e-"));
    queueDir = join(fakeHome, ".unbrowse", "queue", "pending");
    await mkdir(queueDir, { recursive: true });
  });

  afterEach(async () => {
    if (fakeHome) {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test(
    "detached drain process picks up a job written by another process",
    async () => {
      // Process A: write job to disk (this in-process call simulates the caller).
      await writeJob(queueDir, envelope("e2e.example"));
      const beforeNames = await readdir(queueDir);
      expect(beforeNames.some((n) => n.endsWith(".json"))).toBe(true);

      // Process B: spawn drain via CLI hidden verb.
      const result = await runDrain(fakeHome, 20000);

      // The drainer hits UNBROWSE_API_URL=http://127.0.0.1:1 -> ECONNREFUSED ->
      // throws -> worker dead-letters after maxAttempts. Either outcome is valid:
      // the KEY assertion is that a separate process picked up the file.
      const afterPending = await readdir(queueDir).catch(() => []);
      const stillPending = afterPending.filter((n) => n.endsWith(".json"));
      expect(stillPending.length).toBe(0);

      // Exit code 0 expected from drainUntilEmpty (it returns normally on empty).
      expect(result.code).toBe(0);
    },
    20000,
  );

  test(
    "drainOnce on empty queue is idempotent",
    async () => {
      const { drainOnce } = await import("../src/indexer/worker.js");
      const res = await drainOnce(queueDir, async () => {
        /* no-op */
      });
      expect(res).toEqual({ processed: 0, failed: 0, deadLettered: 0, rejected: 0 });
    },
    20000,
  );
});
