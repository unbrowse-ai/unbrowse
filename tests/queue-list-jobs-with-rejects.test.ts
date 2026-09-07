// Reject classification tests — Phase 1.1 Day-5 creature.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listJobsWithRejects,
  writeJob,
  type JobEnvelope,
} from "../src/lib/indexer-core/queue-store.js";

function envelope(overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    version: 1,
    domain: "example.com",
    queuedAt: 1000,
    attempts: 0,
    job: {
      skill: { domain: "example.com", endpoints: [] } as any,
      domain: "example.com",
      cacheKey: "k",
      intent: "test",
    } as any,
    ...overrides,
  };
}

describe("listJobsWithRejects", () => {
  let queueDir: string;

  beforeEach(async () => {
    queueDir = await mkdtemp(join(tmpdir(), "queue-rejects-"));
  });

  afterEach(async () => {
    await rm(queueDir, { recursive: true, force: true });
  });

  test("all-accepted happy path", async () => {
    await writeJob(queueDir, envelope({ queuedAt: 1000, cacheKey: "a" } as any));
    await writeJob(queueDir, envelope({ queuedAt: 2000, cacheKey: "b" } as any));
    await writeJob(queueDir, envelope({ queuedAt: 3000, cacheKey: "c" } as any));
    const { accepted, rejected } = await listJobsWithRejects(queueDir);
    expect(accepted.length).toBe(3);
    expect(rejected.length).toBe(0);
    expect(accepted[0].envelope.queuedAt).toBe(1000);
    expect(accepted[2].envelope.queuedAt).toBe(3000);
  });

  test("corrupt JSON classified", async () => {
    const badPath = join(queueDir, "bad.json");
    await writeFile(badPath, "{ not valid");
    const { accepted, rejected } = await listJobsWithRejects(queueDir);
    expect(accepted.length).toBe(0);
    expect(rejected.length).toBe(1);
    expect(rejected[0].path).toBe(badPath);
    expect(rejected[0].reason).toBe("corrupt_json");
  });

  test("wrong-version classified", async () => {
    const path = join(queueDir, "wrongver.json");
    await writeFile(
      path,
      JSON.stringify({ version: 2, domain: "x", queuedAt: 0, attempts: 0, job: {} }),
    );
    const { accepted, rejected } = await listJobsWithRejects(queueDir);
    expect(accepted.length).toBe(0);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBe("wrong_version");
    expect(rejected[0].path).toBe(path);
  });

  test("missing-fields classified", async () => {
    const path = join(queueDir, "missing.json");
    await writeFile(path, JSON.stringify({ version: 1, domain: "x" }));
    const { accepted, rejected } = await listJobsWithRejects(queueDir);
    expect(accepted.length).toBe(0);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBe("missing_fields");
    expect(rejected[0].path).toBe(path);
  });

  test("mixed: 2 valid + 1 each reject class", async () => {
    await writeJob(queueDir, envelope({ queuedAt: 1000, cacheKey: "a" } as any));
    await writeJob(queueDir, envelope({ queuedAt: 2000, cacheKey: "b" } as any));
    await writeFile(join(queueDir, "corrupt.json"), "{ not json");
    await writeFile(
      join(queueDir, "wrongver.json"),
      JSON.stringify({ version: 2, domain: "x", queuedAt: 0, attempts: 0, job: {} }),
    );
    await writeFile(
      join(queueDir, "missing.json"),
      JSON.stringify({ version: 1, domain: "x" }),
    );
    const { accepted, rejected } = await listJobsWithRejects(queueDir);
    expect(accepted.length).toBe(2);
    expect(rejected.length).toBe(3);
    const reasons = rejected.map((r) => r.reason).sort();
    expect(reasons).toEqual(["corrupt_json", "missing_fields", "wrong_version"]);
  });
});
