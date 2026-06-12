// .tmp orphan sweep tests — Phase 1.1 seed.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, utimes, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleTmp } from "../src/lib/indexer-core/queue-store.js";

describe("sweepStaleTmp", () => {
  let queueDir: string;

  beforeEach(async () => {
    queueDir = await mkdtemp(join(tmpdir(), "queue-sweep-tmp-"));
  });

  afterEach(async () => {
    await rm(queueDir, { recursive: true, force: true });
  });

  test("golden — old .tmp removed, fresh .tmp kept", async () => {
    const oldPath = join(queueDir, "old.json.tmp");
    const freshPath = join(queueDir, "fresh.json.tmp");
    await writeFile(oldPath, "{}");
    await writeFile(freshPath, "{}");
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(oldPath, fiveMinAgo, fiveMinAgo);

    const unlinked = await sweepStaleTmp(queueDir);
    expect(unlinked).toBe(1);

    const entries = await readdir(queueDir);
    expect(entries.includes("old.json.tmp")).toBe(false);
    expect(entries.includes("fresh.json.tmp")).toBe(true);
  });

  test("custom maxAgeMs threshold", async () => {
    const path = join(queueDir, "x.json.tmp");
    await writeFile(path, "{}");
    const fiveSecAgo = new Date(Date.now() - 5000);
    await utimes(path, fiveSecAgo, fiveSecAgo);

    const unlinked = await sweepStaleTmp(queueDir, 2000);
    expect(unlinked).toBe(1);
    const entries = await readdir(queueDir);
    expect(entries.includes("x.json.tmp")).toBe(false);
  });

  test("missing queueDir → no-op returns 0", async () => {
    const unlinked = await sweepStaleTmp("/nonexistent/path/never/exists");
    expect(unlinked).toBe(0);
  });

  test("non-tmp files untouched", async () => {
    const jsonPath = join(queueDir, "keep.json");
    const txtPath = join(queueDir, "keep.txt");
    await writeFile(jsonPath, "{}");
    await writeFile(txtPath, "hello");
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(jsonPath, old, old);
    await utimes(txtPath, old, old);

    const unlinked = await sweepStaleTmp(queueDir);
    expect(unlinked).toBe(0);
    const entries = await readdir(queueDir);
    expect(entries.includes("keep.json")).toBe(true);
    expect(entries.includes("keep.txt")).toBe(true);
  });

  test("mixed: 3 old tmp + 2 fresh tmp + 1 non-tmp", async () => {
    const old = new Date(Date.now() - 5 * 60 * 1000);
    const oldNames = ["a.json.tmp", "b.json.tmp", "c.json.tmp"];
    const freshNames = ["d.json.tmp", "e.json.tmp"];
    const nonTmp = "keep.json";

    for (const n of oldNames) {
      const p = join(queueDir, n);
      await writeFile(p, "{}");
      await utimes(p, old, old);
    }
    for (const n of freshNames) {
      await writeFile(join(queueDir, n), "{}");
    }
    await writeFile(join(queueDir, nonTmp), "{}");

    const unlinked = await sweepStaleTmp(queueDir);
    expect(unlinked).toBe(3);

    const entries = await readdir(queueDir);
    for (const n of oldNames) expect(entries.includes(n)).toBe(false);
    for (const n of freshNames) expect(entries.includes(n)).toBe(true);
    expect(entries.includes(nonTmp)).toBe(true);
  });
});
