// Worker drain quarantine integration tests — Jesus Loop Phase 1.1 Step 5.
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainOnce, type DrainProcessor } from "../src/indexer/worker.js";
import { writeJob, type JobEnvelope } from "../src/indexer/queue-store.js";
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

async function countJsonFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".json") && !e.endsWith(".tmp")).length;
  } catch {
    return 0;
  }
}

let queueDir: string;

beforeEach(async () => {
  queueDir = await mkdtemp(join(tmpdir(), "queue-quarantine-"));
});

afterEach(async () => {
  await rm(queueDir, { recursive: true, force: true });
});

const noopProcessor: DrainProcessor = async () => {};

describe("queue drain quarantine", () => {
  test("3 rejected files (one of each reason) move to quarantine on drainOnce", async () => {
    await writeFile(join(queueDir, "bad-corrupt.json"), "{not valid json", "utf8");
    await writeFile(
      join(queueDir, "bad-version.json"),
      JSON.stringify({ version: 2, domain: "x.com", queuedAt: 1, attempts: 0, job: {} }),
      "utf8",
    );
    await writeFile(
      join(queueDir, "bad-fields.json"),
      JSON.stringify({ version: 1, domain: "y.com", queuedAt: 1, attempts: 0 }),
      "utf8",
    );

    const result = await drainOnce(queueDir, noopProcessor);
    expect(result.rejected).toBe(3);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.deadLettered).toBe(0);

    expect(await countJsonFiles(queueDir)).toBe(0);

    const qCorrupt = await readdir(join(queueDir, "quarantine", "corrupt_json"));
    const qVersion = await readdir(join(queueDir, "quarantine", "wrong_version"));
    const qFields = await readdir(join(queueDir, "quarantine", "missing_fields"));
    expect(qCorrupt).toContain("bad-corrupt.json");
    expect(qVersion).toContain("bad-version.json");
    expect(qFields).toContain("bad-fields.json");
  });

  test("mixed: accepted job drains, rejected file quarantines", async () => {
    await writeJob(queueDir, envelope(makeJob({ domain: "good.com", cacheKey: "kg" })));
    await writeFile(join(queueDir, "bad-corrupt.json"), "not json at all", "utf8");

    let processedCount = 0;
    const processor: DrainProcessor = async () => {
      processedCount++;
    };

    const result = await drainOnce(queueDir, processor);
    expect(result).toEqual({ processed: 1, failed: 0, deadLettered: 0, rejected: 1 });
    expect(processedCount).toBe(1);

    expect(await countJsonFiles(queueDir)).toBe(0);
    const qCorrupt = await readdir(join(queueDir, "quarantine", "corrupt_json"));
    expect(qCorrupt).toContain("bad-corrupt.json");
  });

  test("idempotent: second drainOnce on same dir finds zero rejects", async () => {
    await writeFile(join(queueDir, "bad-corrupt.json"), "{nope", "utf8");
    await writeFile(
      join(queueDir, "bad-version.json"),
      JSON.stringify({ version: 7, domain: "z.com", queuedAt: 1, attempts: 0, job: {} }),
      "utf8",
    );
    await writeFile(
      join(queueDir, "bad-fields.json"),
      JSON.stringify({ version: 1 }),
      "utf8",
    );

    const r1 = await drainOnce(queueDir, noopProcessor);
    expect(r1.rejected).toBe(3);

    const r2 = await drainOnce(queueDir, noopProcessor);
    expect(r2.rejected).toBe(0);
    expect(r2.processed).toBe(0);
    expect(r2.failed).toBe(0);
    expect(r2.deadLettered).toBe(0);

    const qCorrupt = await readdir(join(queueDir, "quarantine", "corrupt_json"));
    expect(qCorrupt.length).toBe(1);
    const st = await stat(join(queueDir, "quarantine", "corrupt_json", "bad-corrupt.json"));
    expect(st.isFile()).toBe(true);
  });
});
