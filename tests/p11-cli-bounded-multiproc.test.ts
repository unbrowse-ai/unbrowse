// Phase 1.1 OS-level bounded-worker test: spawn N CLIs concurrently; at most
// one drains, others exit silently via worker.lock contention.
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJob, type JobEnvelope } from "../src/indexer/queue-store.js";
import type { BackgroundIndexJob } from "../src/indexer/index.js";

const REPO_ROOT = "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse-jl-default";

describe("p11 CLI bounded multi-process", () => {
  test("5 concurrent CLI children all exit cleanly; no stranded worker.lock", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "p11-multi-"));
    const queueDir = join(fakeHome, ".unbrowse", "queue", "pending");
    await mkdir(queueDir, { recursive: true });
    try {
      for (let i = 0; i < 5; i++) {
        const job = {
          skill: { domain: `d${i}.test`, endpoints: [] } as any,
          domain: `d${i}.test`,
          intent: "multi",
          cacheKey: `k${i}`,
        } as unknown as BackgroundIndexJob;
        const env: JobEnvelope = {
          version: 1,
          domain: `d${i}.test`,
          queuedAt: Date.now() + i,
          attempts: 0,
          job,
        };
        await writeJob(queueDir, env);
      }

      const env = { ...process.env, HOME: fakeHome, UNBROWSE_API_URL: "http://127.0.0.1:1" };
      delete env.UNBROWSE_INLINE_INDEX;
      delete env.UNBROWSE_NO_SWEEP;

      const spawnOne = () =>
        new Promise<number>((resolve) => {
          const child = spawn(process.execPath, ["src/cli.ts", "__drain-queue"], {
            cwd: REPO_ROOT,
            env,
            stdio: "ignore",
          });
          const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
          child.on("exit", (code) => {
            clearTimeout(timer);
            resolve(code ?? -1);
          });
        });

      const exits = await Promise.all([
        spawnOne(),
        spawnOne(),
        spawnOne(),
        spawnOne(),
        spawnOne(),
      ]);
      expect(exits.every((c) => c === 0)).toBe(true);

      const queueRoot = join(fakeHome, ".unbrowse", "queue", "pending");
      const filesAfter = await readdir(queueRoot).catch(() => []);
      expect(filesAfter.filter((f) => f === "worker.lock")).toEqual([]);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  }, 60_000);

  test("when slot is held, child CLI exits 0 cleanly without disturbing the slot", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "p11-held-"));
    const queueDir = join(fakeHome, ".unbrowse", "queue", "pending");
    await mkdir(queueDir, { recursive: true });
    try {
      const lockPath = join(queueDir, "worker.lock");
      await writeFile(lockPath, String(process.pid));
      await writeFile(join(queueDir, ".heartbeat"), String(Date.now()));

      const env = { ...process.env, HOME: fakeHome, UNBROWSE_API_URL: "http://127.0.0.1:1" };
      delete env.UNBROWSE_INLINE_INDEX;
      delete env.UNBROWSE_NO_SWEEP;

      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, ["src/cli.ts", "__drain-queue"], {
          cwd: REPO_ROOT,
          env,
          stdio: "ignore",
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
      });

      expect(exitCode).toBe(0);

      const lockAfter = await readFile(lockPath, "utf8");
      expect(lockAfter.trim()).toBe(String(process.pid));
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  }, 20_000);
});
