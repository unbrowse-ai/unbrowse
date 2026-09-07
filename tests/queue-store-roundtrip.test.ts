// Round-trip test for queue-store.ts — Day-3 seed.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute, basename, dirname } from "node:path";
import {
  writeJob,
  listJobs,
  deleteJob,
  isJobEnvelope,
  type JobEnvelope,
} from "../src/lib/indexer-core/queue-store.js";

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

  test("hostile domain '../etc/passwd' stays inside queue dir", async () => {
    const envelope = makeEnvelope({ domain: "../etc/passwd" });
    const written = await writeJob(queueDir, envelope);
    expect(isAbsolute(written)).toBe(true);
    expect(dirname(written)).toBe(queueDir);
    const base = basename(written);
    expect(base.includes("/")).toBe(false);
    expect(base.includes("..")).toBe(false);
    const listed = await listJobs(queueDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.envelope.domain).toBe("../etc/passwd");
  });

  test("hostile domain with backslashes and null bytes", async () => {
    const envelope = makeEnvelope({ domain: "a\\b\x00c d" });
    const written = await writeJob(queueDir, envelope);
    const base = basename(written);
    expect(base.includes("\\")).toBe(false);
    expect(base.includes("\x00")).toBe(false);
    expect(dirname(written)).toBe(queueDir);
    const listed = await listJobs(queueDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.envelope.domain).toBe("a\\b\x00c d");
  });

  test("empty domain produces a usable filename", async () => {
    const envelope = makeEnvelope({ domain: "" });
    const written = await writeJob(queueDir, envelope);
    const base = basename(written);
    expect(base.length).toBeGreaterThan(0);
    expect(dirname(written)).toBe(queueDir);
    expect(/^[._]/.test(base)).toBe(true);
    const listed = await listJobs(queueDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.envelope.domain).toBe("");
  });

  test("unicode domain transliterates to safe ascii filename", async () => {
    const envelope = makeEnvelope({ domain: "测试.example.com" });
    const written = await writeJob(queueDir, envelope);
    const base = basename(written);
    expect(/^[A-Za-z0-9._-]+$/.test(base)).toBe(true);
    const listed = await listJobs(queueDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.envelope.domain).toBe("测试.example.com");
  });

  test("very long domain (>500 chars) does not exceed filesystem name limits", async () => {
    const longDomain = "a".repeat(600);
    const envelope = makeEnvelope({ domain: longDomain });
    const written = await writeJob(queueDir, envelope);
    const base = basename(written);
    expect(Buffer.byteLength(base, "utf8")).toBeLessThanOrEqual(255);
    expect(dirname(written)).toBe(queueDir);
    const listed = await listJobs(queueDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.envelope.domain).toBe(longDomain);
  });

  test("listJobs skips corrupt JSON files", async () => {
    const good = makeEnvelope({ queuedAt: 1000 });
    await writeJob(queueDir, good);
    await writeFile(join(queueDir, "corrupt.json"), "{ this is not valid json");
    const listed = await listJobs(queueDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.envelope.queuedAt).toBe(1000);
  });

  test("listJobs skips wrong-version envelopes", async () => {
    const good = makeEnvelope({ queuedAt: 2000 });
    await writeJob(queueDir, good);
    const wrongVersion = { ...makeEnvelope({ queuedAt: 9999 }), version: 2 };
    await writeFile(join(queueDir, "wrongver.json"), JSON.stringify(wrongVersion));
    const listed = await listJobs(queueDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.envelope.queuedAt).toBe(2000);
  });

  test("listJobs skips envelopes missing required fields", async () => {
    const good = makeEnvelope({ queuedAt: 3000 });
    await writeJob(queueDir, good);
    await writeFile(join(queueDir, "missing.json"), JSON.stringify({ version: 1, domain: "x" }));
    const listed = await listJobs(queueDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.envelope.queuedAt).toBe(3000);
  });

  test("isJobEnvelope rejects null, primitives, and wrong shapes", () => {
    expect(isJobEnvelope(null)).toBe(false);
    expect(isJobEnvelope(undefined)).toBe(false);
    expect(isJobEnvelope("string")).toBe(false);
    expect(isJobEnvelope(42)).toBe(false);
    expect(isJobEnvelope({ version: 1 })).toBe(false);
    expect(isJobEnvelope({ version: 2, domain: "x", queuedAt: 0, attempts: 0, job: {} })).toBe(false);
    expect(isJobEnvelope({ version: 1, domain: "x", queuedAt: 0, attempts: -1, job: {} })).toBe(false);
    expect(isJobEnvelope({ version: 1, domain: "x", queuedAt: NaN, attempts: 0, job: {} })).toBe(false);
    expect(isJobEnvelope({ version: 1, domain: "x", queuedAt: 0, attempts: 0, job: {} })).toBe(true);
  });
});
