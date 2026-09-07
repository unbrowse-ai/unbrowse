/** Durable lifecycle adapter for the existing background index disk queue. */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DurableJobStore, type IndexJobId, type TerminalJob } from "../../runtime/job-store.js";
import type { BackgroundIndexJob } from "./index.js";
import { listJobs, writeJob, type JobEnvelope } from "./queue-store.js";

export const INDEX_QUEUE_OWNER = "background-index-queue";
const INPUT_VERSION = 1;

interface DurableIndexInput {
  queue: "background-index";
  version: typeof INPUT_VERSION;
  domain: string;
  queuedAt: number;
  attempts: number;
  job: BackgroundIndexJob;
}

export function indexJobStoreRoot(queueDir: string): string {
  // queueDir is <unbrowse-home>/queue/pending. Keep generic harness jobs at
  // <unbrowse-home>/jobs without changing the legacy queue layout.
  return resolve(queueDir, "..", "..", "jobs");
}

export function indexJobStore(queueDir: string): DurableJobStore {
  return new DurableJobStore(indexJobStoreRoot(queueDir));
}

export function createDurableIndexEnvelope(
  queueDir: string,
  job: BackgroundIndexJob,
  queuedAt = Date.now(),
): { envelope: JobEnvelope; id: IndexJobId } {
  const input: DurableIndexInput = {
    queue: "background-index", version: INPUT_VERSION, domain: job.domain,
    queuedAt, attempts: 0, job,
  };
  const record = indexJobStore(queueDir).create({
    kind: "index", ownerId: INDEX_QUEUE_OWNER, input,
  });
  return {
    id: record.id as IndexJobId,
    envelope: {
      version: 1, domain: job.domain, queuedAt, attempts: 0, job,
      durable: { id: record.id as IndexJobId, ownerId: INDEX_QUEUE_OWNER },
    },
  };
}

function isInput(value: unknown): value is DurableIndexInput {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<DurableIndexInput>;
  return v.queue === "background-index" && v.version === INPUT_VERSION
    && typeof v.domain === "string" && typeof v.queuedAt === "number"
    && typeof v.attempts === "number" && !!v.job && typeof v.job === "object";
}

/**
 * Recreate envelopes lost when a producer died after the durable create but
 * before the queue rename. Existing envelopes win, so this is idempotent.
 */
export function hasRunningDurableIndexJobs(queueDir: string): boolean {
  if (!existsSync(indexJobStoreRoot(queueDir))) return false;
  return indexJobStore(queueDir).list({ status: "running", limit: 10_000 })
    .some(record => record.kind === "index" && isInput(record.input));
}

export async function recoverOrphanedIndexEnvelopes(queueDir: string): Promise<number> {
  // Legacy/test queues have no durable root; do not create one merely by draining.
  if (!existsSync(indexJobStoreRoot(queueDir))) return 0;
  const existing = await listJobs(queueDir);
  const queuedIds = new Set(existing.map(({ envelope }) => envelope.durable?.id).filter(Boolean));
  let recovered = 0;
  for (const record of indexJobStore(queueDir).list({ status: "running", limit: 10_000 })) {
    if (record.kind !== "index" || queuedIds.has(record.id as IndexJobId) || !isInput(record.input)) continue;
    const input = record.input;
    await writeJob(queueDir, {
      version: 1, domain: input.domain, queuedAt: input.queuedAt,
      attempts: input.attempts, job: input.job,
      durable: { id: record.id as IndexJobId, ownerId: record.ownerId },
    });
    queuedIds.add(record.id as IndexJobId);
    recovered++;
  }
  return recovered;
}

export function pendingIndexCompletions(queueDir: string, limit?: number): TerminalJob[] {
  return indexJobStore(queueDir).pendingCompletions(INDEX_QUEUE_OWNER, limit);
}

export function acknowledgeIndexCompletion(queueDir: string, id: IndexJobId): TerminalJob {
  return indexJobStore(queueDir).acknowledge(id, INDEX_QUEUE_OWNER);
}

export function cleanupAcknowledgedIndexJobs(queueDir: string, olderThanMs = 0, limit = 100): IndexJobId[] {
  return indexJobStore(queueDir).cleanup({ olderThanMs, limit }) as IndexJobId[];
}
