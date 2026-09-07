import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { drainOnce } from "../src/lib/indexer-core/worker.js";
import { listJobs, writeJob } from "../src/lib/indexer-core/queue-store.js";
import {
  acknowledgeIndexCompletion, cleanupAcknowledgedIndexJobs,
  createDurableIndexEnvelope, hasRunningDurableIndexJobs,
  indexJobStore, pendingIndexCompletions,
} from "../src/lib/indexer-core/durable-index-jobs.js";
import type { BackgroundIndexJob } from "../src/lib/indexer-core/index.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "durable-index-")); roots.push(root);
  return { root, queueDir: join(root, "queue", "pending") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function job(domain = "example.com"): BackgroundIndexJob {
  return {
    skill: { name: "x", version: "1.0", domain, endpoints: [] } as any,
    domain, intent: "test", cacheKey: `key-${domain}`,
  };
}

describe("durable background index queue", () => {
  test("idx terminal output is durable, notification is idempotent, and owner ack gates GC", async () => {
    const { queueDir } = fixture();
    const admitted = createDurableIndexEnvelope(queueDir, job());
    expect(admitted.id).toMatch(/^idx_[a-f0-9]{32}$/);
    await writeJob(queueDir, admitted.envelope);

    expect((await drainOnce(queueDir, async () => {})).processed).toBe(1);
    expect(indexJobStore(queueDir).readOutput(admitted.id)).toEqual({
      domain: "example.com", cacheKey: "key-example.com", attempts: 1,
    });
    expect(pendingIndexCompletions(queueDir).map(j => j.id)).toEqual([admitted.id]);
    expect(pendingIndexCompletions(queueDir).map(j => j.id)).toEqual([admitted.id]);
    expect(cleanupAcknowledgedIndexJobs(queueDir)).toEqual([]);
    acknowledgeIndexCompletion(queueDir, admitted.id);
    expect(cleanupAcknowledgedIndexJobs(queueDir)).toEqual([admitted.id]);
  });

  test("restart recovers admission orphaned before the legacy queue rename", async () => {
    const { queueDir } = fixture();
    const admitted = createDurableIndexEnvelope(queueDir, job("orphan.test"));
    // Deliberately do not write admitted.envelope: this is the create -> rename kill window.
    // The normal CLI startup sweep sees this and starts the recovery worker.
    expect(hasRunningDurableIndexJobs(queueDir)).toBe(true);
    const calls: string[] = [];
    const result = await drainOnce(queueDir, async value => { calls.push(value.domain); });
    expect(result.processed).toBe(1);
    expect(calls).toEqual(["orphan.test"]);
    expect(indexJobStore(queueDir).get(admitted.id)?.status).toBe("completed");
  });

  test("restart after terminal commit does not execute the stale envelope twice", async () => {
    const { queueDir } = fixture();
    const admitted = createDurableIndexEnvelope(queueDir, job("committed.test"));
    await writeJob(queueDir, admitted.envelope);
    indexJobStore(queueDir).complete(admitted.id, admitted.envelope.durable!.ownerId, { committed: true });
    let calls = 0;
    await drainOnce(queueDir, async () => { calls++; });
    expect(calls).toBe(0);
    expect(await listJobs(queueDir)).toEqual([]);
    expect(indexJobStore(queueDir).readOutput(admitted.id)).toEqual({ committed: true });
  });

  test("hermetic SIGKILL leaves a running job that the next worker resumes", async () => {
    if (process.platform === "win32") return;
    const { queueDir } = fixture();
    const admitted = createDurableIndexEnvelope(queueDir, job("killed.test"));
    await writeJob(queueDir, admitted.envelope);
    const workerUrl = new URL("../src/lib/indexer-core/worker.ts", import.meta.url).href;
    const script = `import { drainOnce } from ${JSON.stringify(workerUrl)}; await drainOnce(${JSON.stringify(queueDir)}, async () => { process.kill(process.pid, "SIGKILL"); });`;
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    expect(exit.signal).toBe("SIGKILL");
    expect(indexJobStore(queueDir).get(admitted.id)?.status).toBe("running");
    expect((await listJobs(queueDir))).toHaveLength(1);

    let resumed = 0;
    expect((await drainOnce(queueDir, async () => { resumed++; })).processed).toBe(1);
    expect(resumed).toBe(1);
    expect(indexJobStore(queueDir).get(admitted.id)?.status).toBe("completed");
  }, 10_000);
});
