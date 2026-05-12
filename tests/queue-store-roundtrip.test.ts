// Round-trip test for queue-store.ts — Day-3 seed.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeJob,
  listJobs,
  deleteJob,
  type JobEnvelope,
} from "../src/indexer/queue-store.js";

function makeEnvelope(overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    version: 1,
    domain: "example.com",
    queuedAt: 1000,
    attempts: 0,
    job: {
      skill: {
        name: "example",
        version: "1.0",
        domain: "example.com",
        endpoints: [],
      } as any,
      domain: "example.com",
      intent: "search test",
      cacheKey: "test-key-1",
    },
    ...overrides,
  };
}

describe("queue-store round-trip", () => {
  let queueDir: string;

  beforeEach(async () => {
    queueDir = await mkdtemp(join(tmpdir(), "queue-store-rt-"));
  });

  afterEach(async () => {
    await rm(queueDir, { recursive: true, force: true });
  });

  test("writeJob then listJobs returns the same envelope", async () => {
    const envelope = makeEnvelope();
    await writeJob(queueDir, envelope);
    const listed = await listJobs(queueDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.envelope).toEqual(envelope);
  });

  test("deleteJob removes the envelope from listJobs", async () => {
    const envelope = makeEnvelope();
    const path = await writeJob(queueDir, envelope);
    await deleteJob(path);
    const listed = await listJobs(queueDir);
    expect(listed).toEqual([]);
  });

  test("concurrent writes leave no .tmp files and all parse cleanly", async () => {
    const envelopes = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ queuedAt: 1000 + i, job: { ...makeEnvelope().job, cacheKey: `k-${i}` } }),
    );
    await Promise.all(envelopes.map((e) => writeJob(queueDir, e)));
    const entries = await readdir(queueDir);
    const tmps = entries.filter((n) => n.endsWith(".tmp"));
    expect(tmps).toEqual([]);
    const listed = await listJobs(queueDir);
    expect(listed).toHaveLength(10);
    for (const item of listed) {
      expect(item.envelope.version).toBe(1);
    }
  });

  test("listJobs sorts envelopes by queuedAt ascending", async () => {
    await writeJob(queueDir, makeEnvelope({ queuedAt: 3000 }));
    await writeJob(queueDir, makeEnvelope({ queuedAt: 1000 }));
    await writeJob(queueDir, makeEnvelope({ queuedAt: 2000 }));
    const listed = await listJobs(queueDir);
    expect(listed.map((l) => l.envelope.queuedAt)).toEqual([1000, 2000, 3000]);
  });

  test("deleteJob is idempotent on an already-deleted path", async () => {
    const envelope = makeEnvelope();
    const path = await writeJob(queueDir, envelope);
    await deleteJob(path);
    await expect(deleteJob(path)).resolves.toBeUndefined();
  });
});
