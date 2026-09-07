// Phase 1.1 CLI end-to-end: __drain-queue handles all reject classes.
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeJob, type JobEnvelope } from "../src/lib/indexer-core/queue-store.js";
import type { BackgroundIndexJob } from "../src/lib/indexer-core/index.js";

const REPO_ROOT = resolve(import.meta.dir, "..");

test("__drain-queue drains valid + quarantines 3 reject classes via real CLI spawn", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "p11-e2e-"));
  const queueDir = join(fakeHome, ".unbrowse", "queue", "pending");
  await mkdir(queueDir, { recursive: true });
  try {
    const validJob: BackgroundIndexJob = {
      skill: { domain: "e2e.example", endpoints: [] } as any,
      domain: "e2e.example",
      intent: "p11-test",
      cacheKey: "k-valid",
    } as unknown as BackgroundIndexJob;
    const validEnv: JobEnvelope = {
      version: 1, domain: "e2e.example", queuedAt: Date.now(),
      attempts: 0, job: validJob,
    };
    await writeJob(queueDir, validEnv);

    await writeFile(join(queueDir, "corrupt.json"), "{ not valid json");
    await writeFile(join(queueDir, "wrongver.json"),
      JSON.stringify({ ...validEnv, version: 2 }));
    await writeFile(join(queueDir, "missing.json"),
      JSON.stringify({ version: 1, domain: "x" }));

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
    delete env.UNBROWSE_INLINE_INDEX;
    delete env.UNBROWSE_NO_SWEEP;
    env.UNBROWSE_API_URL = "http://127.0.0.1:1";

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["src/cli.ts", "__drain-queue"], {
        cwd: REPO_ROOT,
        env,
        stdio: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

    expect(exitCode).toBe(0);

    const pendingFiles = (await readdir(queueDir)).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".tmp"),
    );
    expect(pendingFiles).toEqual([]);

    // Quarantine lives at <queueDir>/quarantine/<reason>/ per worker.ts.
    const quarantineRoot = join(queueDir, "quarantine");
    const corruptFiles = await readdir(join(quarantineRoot, "corrupt_json")).catch(() => []);
    const wrongVersionFiles = await readdir(join(quarantineRoot, "wrong_version")).catch(() => []);
    const missingFiles = await readdir(join(quarantineRoot, "missing_fields")).catch(() => []);
    expect(corruptFiles.length).toBe(1);
    expect(wrongVersionFiles.length).toBe(1);
    expect(missingFiles.length).toBe(1);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
}, 30_000);
