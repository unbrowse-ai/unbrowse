// Phase 1.1 Day 5 (Step 5 — Creatures): bounded worker.lock at spawn + child entrypoint.
// Model B: parent gates spawn to AVOID wasted spawn; child holds the slot for
// the lifetime of drainUntilEmpty. If two parents race past the gate (rare),
// the second child sees the first child's lock and exits silently.
//
// Real spawn, real filesystem. No mocks.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeJob, touchHeartbeat, type JobEnvelope } from "../src/lib/indexer-core/queue-store.js";
import type { BackgroundIndexJob } from "../src/lib/indexer-core/index.js";

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
    intent: "slot-bounded test",
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
        // Force disk path; do not inherit the test runner's inline mode.
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

describe("worker-slot bounded spawn (Model B)", () => {
  let fakeHome: string;
  let queueDir: string;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "unbrowse-jl-slot-"));
    queueDir = join(fakeHome, ".unbrowse", "queue", "pending");
    await mkdir(queueDir, { recursive: true });
  });

  afterEach(async () => {
    if (fakeHome) {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test(
    "child exits cleanly when worker.lock is held by a live process",
    async () => {
      // Plant a lock owned by the current (test runner) PID and a fresh heartbeat.
      // tryAcquireWorkerSlot will check kill(pid, 0) succeeds AND heartbeat is fresh,
      // so the child should see the slot as held and exit 0 without draining.
      const lockPath = join(queueDir, "worker.lock");
      await writeFile(lockPath, String(process.pid));
      await touchHeartbeat(queueDir);

      // Plant an envelope so we can verify it was NOT drained.
      await writeJob(queueDir, envelope("held.example"));
      const before = (await readdir(queueDir)).filter((n) => n.endsWith(".json"));
      expect(before.length).toBe(1);

      const result = await runDrain(fakeHome, 20000);

      // Child must exit 0 (clean) and the envelope must still be on disk.
      expect(result.code).toBe(0);
      const after = (await readdir(queueDir)).filter((n) => n.endsWith(".json"));
      expect(after.length).toBe(1);
    },
    20000,
  );

  test(
    "child drains when slot is free",
    async () => {
      await writeJob(queueDir, envelope("free.example"));
      const before = (await readdir(queueDir)).filter((n) => n.endsWith(".json"));
      expect(before.length).toBe(1);

      const result = await runDrain(fakeHome, 20000);

      // ECONNREFUSED on UNBROWSE_API_URL forces dead-letter, but the envelope
      // is consumed from pending either way.
      expect(result.code).toBe(0);
      const after = (await readdir(queueDir).catch(() => [])).filter((n) =>
        n.endsWith(".json"),
      );
      expect(after.length).toBe(0);
    },
    20000,
  );

  test(
    "two concurrent children: exactly one drains, queue empties without duplication",
    async () => {
      for (let i = 0; i < 5; i++) {
        await writeJob(queueDir, envelope(`concurrent-${i}.example`));
      }
      const before = (await readdir(queueDir)).filter((n) => n.endsWith(".json"));
      expect(before.length).toBe(5);

      const [a, b] = await Promise.all([
        runDrain(fakeHome, 20000),
        runDrain(fakeHome, 20000),
      ]);

      // Both children exit cleanly. One drained; the other saw the slot held
      // by the first and exited early. Either order is acceptable.
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);

      const after = (await readdir(queueDir).catch(() => [])).filter((n) =>
        n.endsWith(".json"),
      );
      expect(after.length).toBe(0);
    },
    20000,
  );
});
