// Adversarial concurrency probe for tryAcquireWorkerSlot — Phase 1.1 Luminaries (Step 4).
// Asserts FS-level atomicity invariant: under contention, exactly 1 success.
import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireWorkerSlot } from "../src/indexer/queue-store.js";

async function freshDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "unbrowse-worker-slot-conc-"));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("tryAcquireWorkerSlot concurrency invariants", () => {
  test("100 sequential acquire→release cycles all succeed; no leak", async () => {
    const dir = await freshDir();
    try {
      for (let i = 0; i < 100; i++) {
        const r = await tryAcquireWorkerSlot(dir);
        expect(r).not.toBeNull();
        await r!();
      }
      // After last release the lock file must be gone.
      expect(await fileExists(join(dir, "worker.lock"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("100 concurrent acquires produce exactly 1 success + 99 nulls", async () => {
    const dir = await freshDir();
    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, () => tryAcquireWorkerSlot(dir))
      );
      const successes = results.filter((r) => r !== null);
      const nulls = results.filter((r) => r === null);
      expect(successes.length).toBe(1);
      expect(nulls.length).toBe(99);
      // Release the one winner.
      await successes[0]!();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("release-during-concurrent-acquire keeps invariant", async () => {
    // Note: documents the observed serialization. We do NOT claim post-release
    // ordering — only that at most one of B/C/D succeeds during A's hold, and
    // that the FS invariant (exactly one holder at a time) is maintained.
    const dir = await freshDir();
    try {
      const a = await tryAcquireWorkerSlot(dir);
      expect(a).not.toBeNull();
      // Fire B/C/D concurrently while A is still held.
      const pending = Promise.all([
        tryAcquireWorkerSlot(dir),
        tryAcquireWorkerSlot(dir),
        tryAcquireWorkerSlot(dir),
      ]);
      // All three should observe the held lock and return null.
      const [b, c, d] = await pending;
      const heldResults = [b, c, d];
      const successesWhileHeld = heldResults.filter((r) => r !== null);
      expect(successesWhileHeld.length).toBe(0);
      await a!();
      // After release, a fresh acquire must succeed (proves no zombie state).
      const post = await tryAcquireWorkerSlot(dir);
      expect(post).not.toBeNull();
      await post!();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
