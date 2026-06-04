// Per-domain advisory lock tests for queue-store.ts — the method Loop step 5.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, touchHeartbeat, heartbeatAgeMs } from "../src/indexer/queue-store.js";

function pickDeadPid(): number {
  for (const candidate of [2_000_000, 99_999_999, 1_999_999]) {
    try {
      process.kill(candidate, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a dead PID for this test");
}

describe("acquireLock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unbrowse-lock-"));
    lockPath = join(dir, "example.com.lock");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("acquire-then-release", async () => {
    const release = await acquireLock(lockPath);
    expect(release).not.toBeNull();
    const st = await stat(lockPath);
    expect(st.isFile()).toBe(true);
    const body = await readFile(lockPath, "utf8");
    expect(body).toBe(String(process.pid));
    await release!();
    await expect(stat(lockPath)).rejects.toThrow();
  });

  test("second-acquire-while-held-returns-null", async () => {
    const a = await acquireLock(lockPath);
    expect(a).not.toBeNull();
    const b = await acquireLock(lockPath);
    expect(b).toBeNull();
    await a!();
  });

  test("release-then-reacquire", async () => {
    const a = await acquireLock(lockPath);
    expect(a).not.toBeNull();
    await a!();
    const b = await acquireLock(lockPath);
    expect(b).not.toBeNull();
    await b!();
  });

  test("double-release-is-idempotent", async () => {
    const release = await acquireLock(lockPath);
    expect(release).not.toBeNull();
    await release!();
    await expect(release!()).resolves.toBeUndefined();
  });

  test("stale-PID-is-reclaimed", async () => {
    const deadPid = pickDeadPid();
    await writeFile(lockPath, String(deadPid));
    const release = await acquireLock(lockPath);
    expect(release).not.toBeNull();
    const body = await readFile(lockPath, "utf8");
    expect(body).toBe(String(process.pid));
    await release!();
  });

  test("corrupt-lock-content-is-reclaimed", async () => {
    await writeFile(lockPath, "not-a-pid");
    const release = await acquireLock(lockPath);
    expect(release).not.toBeNull();
    const body = await readFile(lockPath, "utf8");
    expect(body).toBe(String(process.pid));
    await release!();
  });
});

describe("heartbeat", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unbrowse-heartbeat-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("touchHeartbeat creates the file with current mtime", async () => {
    const before = Date.now();
    await touchHeartbeat(dir);
    const st = await stat(join(dir, ".heartbeat"));
    expect(st.isFile()).toBe(true);
    expect(Math.abs(st.mtimeMs - before)).toBeLessThan(5000);
  });

  test("heartbeatAgeMs returns Infinity when heartbeat absent", async () => {
    const age = await heartbeatAgeMs(dir);
    expect(age).toBe(Number.POSITIVE_INFINITY);
  });

  test("heartbeatAgeMs grows over time", async () => {
    await touchHeartbeat(dir);
    await new Promise((r) => setTimeout(r, 60));
    const age = await heartbeatAgeMs(dir);
    expect(age).toBeGreaterThanOrEqual(50);
  });
});
