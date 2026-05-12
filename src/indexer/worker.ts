// Drain loop for the background index queue. Day-5 creature.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BackgroundIndexJob } from "./index.js";
import { listJobs, deleteJob, writeJob, acquireLock, touchHeartbeat, sanitizeDomain } from "./queue-store.js";

export type DrainProcessor = (job: BackgroundIndexJob) => Promise<void>;

export async function drainOnce(
  queueDir: string,
  processor: DrainProcessor,
  maxAttempts: number = 3,
): Promise<{ processed: number; failed: number; deadLettered: number }> {
  await touchHeartbeat(queueDir).catch(() => {});
  let processed = 0;
  let failed = 0;
  let deadLettered = 0;

  const jobs = await listJobs(queueDir);
  for (const { path, envelope } of jobs) {
    const lockPath = join(queueDir, sanitizeDomain(envelope.domain) + ".lock");
    const release = await acquireLock(lockPath);
    if (release === null) continue;

    try {
      try {
        await processor(envelope.job);
        await deleteJob(path);
        processed++;
      } catch {
        const newAttempts = envelope.attempts + 1;
        if (newAttempts >= maxAttempts) {
          const deadDir = join(queueDir, "dead");
          await mkdir(deadDir, { recursive: true });
          await writeJob(deadDir, {
            version: 1,
            domain: envelope.domain,
            queuedAt: envelope.queuedAt,
            attempts: newAttempts,
            job: envelope.job,
          });
          await deleteJob(path);
          deadLettered++;
        } else {
          await writeJob(queueDir, {
            version: 1,
            domain: envelope.domain,
            queuedAt: Date.now(),
            attempts: newAttempts,
            job: envelope.job,
          });
          await deleteJob(path);
          failed++;
        }
      }
    } finally {
      await release();
    }
  }

  return { processed, failed, deadLettered };
}

export async function drainUntilEmpty(
  queueDir: string,
  processor: DrainProcessor,
  options?: { maxAttempts?: number; idleExitMs?: number; pollMs?: number },
): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const idleExitMs = options?.idleExitMs ?? 5000;
  const pollMs = options?.pollMs ?? 200;

  let lastProgressAt = Date.now();
  for (;;) {
    await touchHeartbeat(queueDir).catch(() => {});
    const result = await drainOnce(queueDir, processor, maxAttempts);
    const madeProgress =
      result.processed > 0 || result.failed > 0 || result.deadLettered > 0;
    if (madeProgress) {
      lastProgressAt = Date.now();
    } else {
      const remaining = await listJobs(queueDir);
      if (remaining.length === 0 && Date.now() - lastProgressAt >= idleExitMs) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
