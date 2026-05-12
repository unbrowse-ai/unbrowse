// Worker drain integration tests — Day-5 creature.
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drainOnce,
  drainUntilEmpty,
  type DrainProcessor,
} from "../src/indexer/worker.js";
import {
  writeJob,
  listJobs,
  type JobEnvelope,
} from "../src/indexer/queue-store.js";
import type { BackgroundIndexJob } from "../src/indexer/index.js";

function makeJob(overrides: Partial<BackgroundIndexJob> = {}): BackgroundIndexJob {
  return {
    skill: { name: "x", version: "1.0", domain: "example.com", endpoints: [] } as any,
    domain: "example.com",
    intent: "test",
    cacheKey: "k1",
    ...overrides,
  };
}

function envelope(job: BackgroundIndexJob, queuedAt: number = Date.now()): JobEnvelope {
  return { version: 1, domain: job.domain, queuedAt, attempts: 0, job };
}

let queueDir: string;

beforeEach(async () => {
  queueDir = await mkdtemp(join(tmpdir(), "worker-drain-"));
});

afterEach(async () => {
  await rm(queueDir, { recursive: true, force: true });
});

describe("worker drain", () => {
  test("golden path: 3 jobs different domains, all processed exactly once", async () => {
    const jobs = [
      makeJob({ domain: "a.com", cacheKey: "ka" }),
      makeJob({ domain: "b.com", cacheKey: "kb" }),
      makeJob({ domain: "c.com", cacheKey: "kc" }),
    ];
    for (const j of jobs) {
      await writeJob(queueDir, envelope(j));
    }

    const processed: string[] = [];
    const processor: DrainProcessor = async (j) => {
      processed.push(j.domain);
    };

    const result = await drainOnce(queueDir, processor);
    expect(result).toEqual({ processed: 3, failed: 0, deadLettered: 0 });
    expect(new Set(processed).size).toBe(3);
    expect(processed).toContain("a.com");
    expect(processed).toContain("b.com");
    expect(processed).toContain("c.com");

    const remaining = await listJobs(queueDir);
    expect(remaining.length).toBe(0);
  });

  test("same-domain serial processing — drain runs them under per-domain lock", async () => {
    const jobs = [
      makeJob({ domain: "a.com", cacheKey: "k1" }),
      makeJob({ domain: "a.com", cacheKey: "k2" }),
      makeJob({ domain: "a.com", cacheKey: "k3" }),
    ];
    for (const j of jobs) {
      await writeJob(queueDir, envelope(j));
    }

    type Span = { start: number; end: number; key: string };
    const spans: Span[] = [];
    const processor: DrainProcessor = async (j) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 25));
      spans.push({ start, end: Date.now(), key: j.cacheKey });
    };

    const result = await drainOnce(queueDir, processor);
    expect(result.processed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.deadLettered).toBe(0);

    // No overlap: sort spans by start, each next.start >= prev.end
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }

    const remaining = await listJobs(queueDir);
    expect(remaining.length).toBe(0);
  });

  test("processor throws once, succeeds on retry", async () => {
    await writeJob(queueDir, envelope(makeJob({ domain: "retry.com", cacheKey: "kr" })));

    let calls = 0;
    const processor: DrainProcessor = async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
    };

    const r1 = await drainOnce(queueDir, processor);
    expect(r1).toEqual({ processed: 0, failed: 1, deadLettered: 0 });

    let after1 = await listJobs(queueDir);
    expect(after1.length).toBe(1);
    expect(after1[0]!.envelope.attempts).toBe(1);

    const r2 = await drainOnce(queueDir, processor);
    expect(r2.processed).toBe(1);
    expect(r2.failed).toBe(0);
    expect(r2.deadLettered).toBe(0);

    const after2 = await listJobs(queueDir);
    expect(after2.length).toBe(0);
    expect(calls).toBe(2);
  });

  test(
    "drainUntilEmpty drains the whole queue and exits when idle",
    async () => {
      const doms = ["a.com", "b.com", "c.com", "d.com", "e.com"];
      for (const d of doms) {
        await writeJob(queueDir, envelope(makeJob({ domain: d, cacheKey: `k-${d}` })));
      }

      const processed: string[] = [];
      const processor: DrainProcessor = async (j) => {
        processed.push(j.domain);
      };

      const t0 = Date.now();
      await drainUntilEmpty(queueDir, processor, { idleExitMs: 500, pollMs: 50 });
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeLessThan(2000);
      expect(processed.length).toBe(5);
      expect(new Set(processed).size).toBe(5);

      const remaining = await listJobs(queueDir);
      expect(remaining.length).toBe(0);
    },
    3000,
  );

  test("failing job preserves attempts counter across drains", async () => {
    await writeJob(queueDir, envelope(makeJob({ domain: "fail.com", cacheKey: "kf" })));

    const processor: DrainProcessor = async () => {
      throw new Error("always");
    };

    await drainOnce(queueDir, processor);
    await drainOnce(queueDir, processor);

    const remaining = await listJobs(queueDir);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.envelope.attempts).toBe(2);
  });

  test("adversarial: a manually-planted .tmp file in the queue is not picked up", async () => {
    await writeJob(queueDir, envelope(makeJob({ domain: "real.com", cacheKey: "kreal" })));

    const tmpPath = join(queueDir, "garbage.tmp");
    const planted: JobEnvelope = envelope(makeJob({ domain: "ghost.com", cacheKey: "kghost" }));
    await writeFile(tmpPath, JSON.stringify(planted), "utf8");

    const processed: string[] = [];
    const processor: DrainProcessor = async (j) => {
      processed.push(j.domain);
    };

    const result = await drainOnce(queueDir, processor);
    expect(result).toEqual({ processed: 1, failed: 0, deadLettered: 0 });
    expect(processed).toEqual(["real.com"]);

    // .tmp file still on disk untouched
    const entries = await readdir(queueDir);
    expect(entries).toContain("garbage.tmp");
    const stillThere = await readFile(tmpPath, "utf8");
    expect(JSON.parse(stillThere).job.domain).toBe("ghost.com");
  });
});
