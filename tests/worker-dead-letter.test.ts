// Dead-letter integration tests — Day-5 creature (lost-sheep hunt).
import { describe, test, expect } from "bun:test";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { drainOnce, type DrainProcessor } from "../src/indexer/worker.js";
import { writeJob, type JobEnvelope } from "../src/indexer/queue-store.js";
import type { BackgroundIndexJob } from "../src/indexer/index.js";

function makeJob(overrides: Partial<BackgroundIndexJob> = {}): BackgroundIndexJob {
  return {
    domain: "example.com",
    cacheKey: "key-1",
    skill: { domain: "example.com", endpoints: [] },
    ...overrides,
  } as unknown as BackgroundIndexJob;
}

function envelope(job: BackgroundIndexJob, attempts: number = 0): JobEnvelope {
  return { version: 1, domain: job.domain, queuedAt: Date.now(), attempts, job };
}

async function makeQueueDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "unbrowse-dl-"));
}

async function listQueueFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

async function listDeadFiles(queueDir: string): Promise<string[]> {
  try {
    return (await readdir(join(queueDir, "dead"))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

async function readEnvelope(path: string): Promise<JobEnvelope> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as JobEnvelope;
}

describe("worker dead-letter behavior", () => {
  test("dead-letters after maxAttempts failures (default 3)", async () => {
    const queueDir = await makeQueueDir();
    try {
      await writeJob(queueDir, envelope(makeJob({ domain: "a.example", cacheKey: "k-a" })));

      const throwing: DrainProcessor = async () => {
        throw new Error("boom");
      };

      await drainOnce(queueDir, throwing);
      let files = await listQueueFiles(queueDir);
      expect(files.length).toBe(1);
      let env = await readEnvelope(join(queueDir, files[0]!));
      expect(env.attempts).toBe(1);

      await drainOnce(queueDir, throwing);
      files = await listQueueFiles(queueDir);
      expect(files.length).toBe(1);
      env = await readEnvelope(join(queueDir, files[0]!));
      expect(env.attempts).toBe(2);

      const result = await drainOnce(queueDir, throwing);
      expect(result.deadLettered).toBe(1);
      expect(await listQueueFiles(queueDir)).toEqual([]);
      const dead = await listDeadFiles(queueDir);
      expect(dead.length).toBe(1);
      const deadEnv = await readEnvelope(join(queueDir, "dead", dead[0]!));
      expect(deadEnv.attempts).toBe(3);
      expect(deadEnv.job.domain).toBe("a.example");
    } finally {
      await rm(queueDir, { recursive: true, force: true });
    }
  });

  test("respects custom maxAttempts=1", async () => {
    const queueDir = await makeQueueDir();
    try {
      await writeJob(queueDir, envelope(makeJob({ domain: "b.example", cacheKey: "k-b" })));
      const throwing: DrainProcessor = async () => {
        throw new Error("nope");
      };

      const result = await drainOnce(queueDir, throwing, 1);
      expect(result).toEqual({ processed: 0, failed: 0, deadLettered: 1, rejected: 0 });
      expect(await listQueueFiles(queueDir)).toEqual([]);
      const dead = await listDeadFiles(queueDir);
      expect(dead.length).toBe(1);
    } finally {
      await rm(queueDir, { recursive: true, force: true });
    }
  });

  test("dead-letter envelope preserves the original job payload", async () => {
    const queueDir = await makeQueueDir();
    try {
      await writeJob(queueDir, envelope(makeJob({ domain: "c.example", cacheKey: "specific-key" })));
      const throwing: DrainProcessor = async () => {
        throw new Error("fail");
      };

      await drainOnce(queueDir, throwing, 3);
      await drainOnce(queueDir, throwing, 3);
      await drainOnce(queueDir, throwing, 3);

      const dead = await listDeadFiles(queueDir);
      expect(dead.length).toBe(1);
      const env = await readEnvelope(join(queueDir, "dead", dead[0]!));
      expect(env.job.cacheKey).toBe("specific-key");
      expect(env.attempts).toBe(3);
    } finally {
      await rm(queueDir, { recursive: true, force: true });
    }
  });

  test("mixed: only the always-throws job dead-letters, the good one processes once", async () => {
    const queueDir = await makeQueueDir();
    try {
      await writeJob(queueDir, envelope(makeJob({ domain: "good.example", cacheKey: "good" })));
      await writeJob(queueDir, envelope(makeJob({ domain: "bad.example", cacheKey: "bad" })));

      const processedKeys = new Set<string>();
      const processor: DrainProcessor = async (job) => {
        if (job.cacheKey === "bad") throw new Error("bad always fails");
        processedKeys.add(job.cacheKey);
      };

      await drainOnce(queueDir, processor, 3);
      await drainOnce(queueDir, processor, 3);
      await drainOnce(queueDir, processor, 3);

      expect(await listQueueFiles(queueDir)).toEqual([]);
      const dead = await listDeadFiles(queueDir);
      expect(dead.length).toBe(1);
      const env = await readEnvelope(join(queueDir, "dead", dead[0]!));
      expect(env.job.cacheKey).toBe("bad");
      expect(processedKeys.has("good")).toBe(true);
      expect(processedKeys.size).toBe(1);
    } finally {
      await rm(queueDir, { recursive: true, force: true });
    }
  });

  test("lost-sheep hunt: every failing job ends up in dead/ with attempts=3, none lost", async () => {
    const queueDir = await makeQueueDir();
    try {
      const domains = ["s1.example", "s2.example", "s3.example", "s4.example", "s5.example"];
      for (const d of domains) {
        await writeJob(queueDir, envelope(makeJob({ domain: d, cacheKey: `k-${d}` })));
      }

      const throwing: DrainProcessor = async () => {
        throw new Error("always");
      };

      for (let i = 0; i < 50; i++) {
        const r = await drainOnce(queueDir, throwing, 3);
        if (r.processed === 0 && r.failed === 0 && r.deadLettered === 0) break;
      }

      expect(await listQueueFiles(queueDir)).toEqual([]);
      const dead = await listDeadFiles(queueDir);
      expect(dead.length).toBe(5);
      const seen = new Set<string>();
      for (const f of dead) {
        const env = await readEnvelope(join(queueDir, "dead", f));
        expect(env.attempts).toBe(3);
        seen.add(env.job.domain);
      }
      expect(seen.size).toBe(5);
      for (const d of domains) expect(seen.has(d)).toBe(true);
    } finally {
      await rm(queueDir, { recursive: true, force: true });
    }
  });
});
