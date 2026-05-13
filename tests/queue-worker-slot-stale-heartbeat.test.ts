// P1-3 cross-check: live PID + stale heartbeat → reclaim.
import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, utimes, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireWorkerSlot, touchHeartbeat } from "../src/indexer/queue-store.js";

async function freshDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "unbrowse-worker-slot-hb-"));
}

describe("tryAcquireWorkerSlot heartbeat cross-check", () => {
  test("live PID + stale heartbeat → reclaimed", async () => {
    const dir = await freshDir();
    try {
      // Own PID is definitely alive.
      await writeFile(join(dir, "worker.lock"), String(process.pid));
      await touchHeartbeat(dir);
      // Backdate the heartbeat mtime to 60s ago.
      const past = new Date(Date.now() - 60_000);
      await utimes(join(dir, ".heartbeat"), past, past);

      const release = await tryAcquireWorkerSlot(dir);
      expect(release).not.toBeNull();
      // Lock file should now hold our own pid (re-acquired by tryCreate).
      const contents = (await readFile(join(dir, "worker.lock"), "utf8")).trim();
      expect(contents).toBe(String(process.pid));
      await release!();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("live PID + fresh heartbeat → still held", async () => {
    const dir = await freshDir();
    try {
      await writeFile(join(dir, "worker.lock"), String(process.pid));
      await touchHeartbeat(dir);
      // Heartbeat is fresh — no utimes adjustment.

      const result = await tryAcquireWorkerSlot(dir);
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("threshold edge: 29s-old heartbeat, live PID → lock held", async () => {
    const dir = await freshDir();
    try {
      await writeFile(join(dir, "worker.lock"), String(process.pid));
      await touchHeartbeat(dir);
      const past = new Date(Date.now() - 29_000);
      await utimes(join(dir, ".heartbeat"), past, past);

      const result = await tryAcquireWorkerSlot(dir);
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("threshold edge: 31s-old heartbeat, live PID → lock reclaimed", async () => {
    const dir = await freshDir();
    try {
      await writeFile(join(dir, "worker.lock"), String(process.pid));
      await touchHeartbeat(dir);
      const past = new Date(Date.now() - 31_000);
      await utimes(join(dir, ".heartbeat"), past, past);

      const release = await tryAcquireWorkerSlot(dir);
      expect(release).not.toBeNull();
      await release!();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
