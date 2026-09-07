// Drain loop for the background index queue. Day-5 creature.
import { mkdir, rename } from "node:fs/promises";
import { join, basename } from "node:path";
import type { BackgroundIndexJob } from "./index.js";
import { listJobs, listJobsWithRejects, deleteJob, writeJob, rewriteJobAtPath, acquireLock, touchHeartbeat, sweepStaleTmp, sanitizeDomain } from "./queue-store.js";
import { indexJobStore, recoverOrphanedIndexEnvelopes } from "./durable-index-jobs.js";

export type DrainProcessor = (job: BackgroundIndexJob) => Promise<void>;

export async function drainOnce(
  queueDir: string,
  processor: DrainProcessor,
  maxAttempts: number = 3,
): Promise<{ processed: number; failed: number; deadLettered: number; rejected: number }> {
  await touchHeartbeat(queueDir).catch(() => {});
  await sweepStaleTmp(queueDir).catch(() => {});
  // A producer may have died after DurableJobStore.create() but before the
  // legacy queue file rename. Re-admit those running records before listing.
  await recoverOrphanedIndexEnvelopes(queueDir);
  let processed = 0;
  let failed = 0;
  let deadLettered = 0;
  let rejectedCount = 0;

  const { accepted, rejected } = await listJobsWithRejects(queueDir);

  for (const file of rejected) {
    try {
      const quarantineDir = join(queueDir, "quarantine", file.reason);
      await mkdir(quarantineDir, { recursive: true });
      await rename(file.path, join(quarantineDir, basename(file.path)));
      rejectedCount++;
    } catch (err) {
      process.stderr.write(`[queue:quarantine] failed to move ${file.path}: ${(err as Error).message}\n`);
    }
  }

  for (const { path, envelope } of accepted) {
    const lockPath = join(queueDir, sanitizeDomain(envelope.domain) + ".lock");
    const release = await acquireLock(lockPath);
    if (release === null) continue;

    try {
      const durableStore = envelope.durable ? indexJobStore(queueDir) : undefined;
      if (durableStore && envelope.durable) {
        const record = durableStore.get(envelope.durable.id);
        // SIGKILL after durable completion but before legacy-envelope delete:
        // terminal metadata is the commit marker, so never execute twice.
        if (record && record.status !== "running") {
          await deleteJob(path);
          continue;
        }
        durableStore.heartbeat(envelope.durable.id, envelope.durable.ownerId);
      }

      try {
        await processor(envelope.job);
        if (durableStore && envelope.durable) {
          const after = durableStore.get(envelope.durable.id);
          if (after?.status === "killed") {
            // Cancellation may race a non-cooperative legacy processor. Never let its
            // late return overwrite the permanent killed terminal or requeue work.
            await deleteJob(path);
            processed++;
            continue;
          }
          durableStore.complete(envelope.durable.id, envelope.durable.ownerId, {
            domain: envelope.domain,
            cacheKey: envelope.job.cacheKey,
            attempts: envelope.attempts + 1,
          });
        }
        await deleteJob(path);
        processed++;
      } catch (error) {
        if (durableStore && envelope.durable && durableStore.get(envelope.durable.id)?.status === "killed") {
          await deleteJob(path);
          processed++;
          continue;
        }
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
            ...(envelope.durable ? { durable: envelope.durable } : {}),
          });
          if (durableStore && envelope.durable) {
            durableStore.fail(envelope.durable.id, envelope.durable.ownerId, error);
          }
          await deleteJob(path);
          deadLettered++;
        } else {
          // Atomic in-place rewrite: bumps attempts + rotates queuedAt to the
          // back of the queue without ever having two envelopes on disk for
          // the same job (audit #2/#3 P1 fix — was writeJob+deleteJob with a
          // SIGKILL window that duplicated jobs).
          await rewriteJobAtPath(path, {
            version: 1,
            domain: envelope.domain,
            queuedAt: Date.now(),
            attempts: newAttempts,
            job: envelope.job,
            ...(envelope.durable ? { durable: envelope.durable } : {}),
          });
          if (durableStore && envelope.durable) {
            durableStore.heartbeat(envelope.durable.id, envelope.durable.ownerId);
          }
          failed++;
        }
      }
    } finally {
      await release();
    }
  }

  return { processed, failed, deadLettered, rejected: rejectedCount };
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
  await touchHeartbeat(queueDir).catch(() => {});
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
