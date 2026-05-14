// Day-5 dispatcher: inline path preserved, disk path writes envelopes.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  queueBackgroundIndex,
  drainPendingIndexJobs,
  resetIndexQueueForTests,
  setBackgroundIndexProcessorForTests,
  type BackgroundIndexJob,
} from "../src/indexer/index.js";
import { listJobs } from "../src/indexer/queue-store.js";

function makeJob(cacheKey: string, domain = "example.com"): BackgroundIndexJob {
  return {
    skill: {
      name: "ex",
      version: "1.0",
      domain,
      endpoints: [],
    } as any,
    domain,
    intent: "search test",
    cacheKey,
  };
}

describe("queueBackgroundIndex dispatcher", () => {
  let savedHome: string | undefined;
  let savedInline: string | undefined;
  let tmpHome: string;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    savedInline = process.env.UNBROWSE_INLINE_INDEX;
    tmpHome = await mkdtemp(join(tmpdir(), "indexer-dispatcher-"));
    resetIndexQueueForTests();
  });

  afterEach(async () => {
    resetIndexQueueForTests();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedInline === undefined) delete process.env.UNBROWSE_INLINE_INDEX;
    else process.env.UNBROWSE_INLINE_INDEX = savedInline;
    await rm(tmpHome, { recursive: true, force: true });
  });

  test("inline mode: test-injected processor runs jobs in-memory", async () => {
    const processed: string[] = [];
    setBackgroundIndexProcessorForTests(async (j) => {
      processed.push(j.cacheKey);
    });

    queueBackgroundIndex(makeJob("cacheA"));
    await drainPendingIndexJobs();

    expect(processed).toEqual(["cacheA"]);
  });

  test("disk mode: default processor + HOME override writes envelope to queue dir", async () => {
    // Reset the test seam so shouldRunInline() returns false.
    setBackgroundIndexProcessorForTests(null);
    process.env.HOME = tmpHome;
    delete process.env.UNBROWSE_INLINE_INDEX;

    queueBackgroundIndex(makeJob("cacheB", "disk-domain.test"));

    // writeJob is fire-and-forget; give the microtask + fs ops a tick.
    await new Promise((r) => setTimeout(r, 50));

    const queueDir = join(tmpHome, ".unbrowse", "queue", "pending");
    const jobs = await listJobs(queueDir);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.envelope.job.cacheKey).toBe("cacheB");
    expect(jobs[0]!.envelope.domain).toBe("disk-domain.test");
    expect(jobs[0]!.envelope.version).toBe(1);
    expect(jobs[0]!.envelope.attempts).toBe(0);
  });
});
