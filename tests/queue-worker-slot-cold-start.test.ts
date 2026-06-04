// Cold-start regression test — Phase 1.1 Day-8 audit #3 fix.
// tryAcquireWorkerSlot must `mkdir -p` the queueDir before acquireLock's
// open(wx), otherwise a fresh HOME crashes with ENOENT on
// `bun src/cli.ts __drain-queue` for first-time users.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireWorkerSlot } from "../src/indexer/queue-store.js";

describe("tryAcquireWorkerSlot cold-start (Day-8 audit #3)", () => {
  let parentDir: string;

  beforeEach(async () => {
    parentDir = await mkdtemp(join(tmpdir(), "p11-cold-start-"));
  });

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true });
  });

  test("acquires successfully when queueDir does not yet exist", async () => {
    // queueDir is a deep path that hasn't been created. Pre-Phase-1.1.8 this
    // would crash with ENOENT inside acquireLock's fs.open(wx).
    const queueDir = join(parentDir, "fresh", "deep", "path", "pending");
    const release = await tryAcquireWorkerSlot(queueDir);
    expect(release).not.toBeNull();
    // The dir should now exist.
    await access(queueDir);  // throws if missing — assertion via absence of throw
    await release!();
  });

  test("acquires successfully when only HOME exists, no .unbrowse subtree", async () => {
    // Mimics the real first-time-user scenario.
    const queueDir = join(parentDir, ".unbrowse", "queue", "pending");
    const release = await tryAcquireWorkerSlot(queueDir);
    expect(release).not.toBeNull();
    await release!();
  });
});
