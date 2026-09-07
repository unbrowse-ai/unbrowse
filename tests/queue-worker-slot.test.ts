// Worker-slot acquisition tests — Phase 1.1 seed.
import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireWorkerSlot, touchHeartbeat } from "../src/lib/indexer-core/queue-store.js";

async function freshDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "unbrowse-worker-slot-"));
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

describe("tryAcquireWorkerSlot", () => {
  test("acquire returns release fn and creates worker.lock", async () => {
    const dir = await freshDir();
    try {
      const release = await tryAcquireWorkerSlot(dir);
      expect(release).not.toBeNull();
      expect(typeof release).toBe("function");
      const st = await stat(join(dir, "worker.lock"));
      expect(st.isFile()).toBe(true);
      await release!();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("second concurrent acquire returns null", async () => {
    const dir = await freshDir();
    try {
      const a = await tryAcquireWorkerSlot(dir);
      expect(a).not.toBeNull();
      await touchHeartbeat(dir);
      const b = await tryAcquireWorkerSlot(dir);
      expect(b).toBeNull();
      await a!();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("release-then-reacquire succeeds", async () => {
    const dir = await freshDir();
    try {
      const a = await tryAcquireWorkerSlot(dir);
      expect(a).not.toBeNull();
      await a!();
      const b = await tryAcquireWorkerSlot(dir);
      expect(b).not.toBeNull();
      await b!();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("double-release is idempotent", async () => {
    const dir = await freshDir();
    try {
      const a = await tryAcquireWorkerSlot(dir);
      expect(a).not.toBeNull();
      await a!();
      // Should not throw.
      await a!();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stale-PID lock is reclaimed", async () => {
    const dir = await freshDir();
    try {
      // Find a non-alive pid candidate.
      let stalePid = 2000000;
      if (pidIsAlive(stalePid)) stalePid = 99999999;
      // Ensure final choice is truly not alive — if both somehow are, skip-fail loudly.
      expect(pidIsAlive(stalePid)).toBe(false);
      await writeFile(join(dir, "worker.lock"), String(stalePid));
      const release = await tryAcquireWorkerSlot(dir);
      expect(release).not.toBeNull();
      await release!();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("corrupt lock content is reclaimed", async () => {
    const dir = await freshDir();
    try {
      await writeFile(join(dir, "worker.lock"), "not-a-pid");
      const release = await tryAcquireWorkerSlot(dir);
      expect(release).not.toBeNull();
      await release!();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
