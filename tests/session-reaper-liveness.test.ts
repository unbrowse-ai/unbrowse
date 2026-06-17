/**
 * Witness: browse-session liveness + stale-session reaper.
 *
 * - resolveSession({probeLive:true}) prunes a dead-Chrome record and throws a
 *   clean `session_expired` instead of letting a downstream CDP attach throw
 *   ECONNREFUSED. {probeLive:false} (used by close/session-park) returns the
 *   record so they can still clean up.
 * - reapStaleSessions() deletes dead-Chrome records and caps live sessions
 *   (kills the oldest beyond maxLive), bounding the persisted-Chrome leak from
 *   `go` without `close`.
 *
 * "alive" pids are real spawned `sleep` children; "dead" is a pid that cannot
 * exist (kill(pid,0) → ESRCH), so the assertions are deterministic, no timing.
 */
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isProcessAlive,
  reapStaleSessions,
  readSessionRecord,
  resolveSession,
  writeSessionRecord,
  deleteSessionRecord,
  type BrowseSessionRecord,
} from "../src/cli-v7/_session";

const DEAD_PID = 2_147_483_646; // no such process → kill(pid,0) throws ESRCH
const ids: string[] = [];
const sleepers: number[] = [];

function spawnSleeper(): number {
  const c = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  c.unref();
  sleepers.push(c.pid ?? 0);
  return c.pid ?? 0;
}

function rec(id: string, pid: number, createdAt: number): BrowseSessionRecord {
  ids.push(id);
  return {
    sessionId: id,
    contextId: "",
    targetId: "T".padEnd(32, "0"),
    chromeWsUrl: "ws://127.0.0.1:1/devtools/browser/x",
    chromePid: pid,
    createdAt,
  };
}

afterEach(async () => {
  for (const id of ids) await deleteSessionRecord(id).catch(() => undefined);
  for (const pid of sleepers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  ids.length = 0;
  sleepers.length = 0;
  await rm(join(homedir(), ".unbrowse", "tmp"), { recursive: true, force: true }).catch(() => undefined);
});

test("isProcessAlive: own pid alive, impossible pid dead", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(DEAD_PID)).toBe(false);
  expect(isProcessAlive(0)).toBe(false);
  expect(isProcessAlive(-1)).toBe(false);
});

test("resolveSession probeLive prunes dead session + throws session_expired", async () => {
  await writeSessionRecord(rec("live-dead-1", DEAD_PID, 1));
  await expect(resolveSession("live-dead-1", { probeLive: true })).rejects.toThrow("session_expired");
  // pruned
  await expect(readSessionRecord("live-dead-1")).rejects.toThrow();
});

test("resolveSession probeLive:false returns a dead-Chrome record (close path)", async () => {
  await writeSessionRecord(rec("live-dead-2", DEAD_PID, 1));
  const r = await resolveSession("live-dead-2", { probeLive: false });
  expect(r.sessionId).toBe("live-dead-2");
});

test("resolveSession returns a live session", async () => {
  const pid = spawnSleeper();
  await writeSessionRecord(rec("live-ok", pid, 1));
  const r = await resolveSession("live-ok", { probeLive: true });
  expect(r.sessionId).toBe("live-ok");
});

test("reapStaleSessions deletes dead-Chrome records", async () => {
  await writeSessionRecord(rec("dead-a", DEAD_PID, 1));
  await writeSessionRecord(rec("dead-b", DEAD_PID, 2));
  const reaped = await reapStaleSessions();
  expect(reaped).toBe(2);
  await expect(readSessionRecord("dead-a")).rejects.toThrow();
  await expect(readSessionRecord("dead-b")).rejects.toThrow();
});

test("reapStaleSessions caps live sessions, killing the oldest beyond maxLive", async () => {
  const oldPid = spawnSleeper();
  const midPid = spawnSleeper();
  const newPid = spawnSleeper();
  await writeSessionRecord(rec("cap-old", oldPid, 100));
  await writeSessionRecord(rec("cap-mid", midPid, 200));
  await writeSessionRecord(rec("cap-new", newPid, 300));

  const reaped = await reapStaleSessions({ maxLive: 1 });
  expect(reaped).toBe(2); // the two oldest live sessions

  // Newest survives; the two oldest records are gone.
  expect((await readSessionRecord("cap-new")).sessionId).toBe("cap-new");
  await expect(readSessionRecord("cap-old")).rejects.toThrow();
  await expect(readSessionRecord("cap-mid")).rejects.toThrow();
});
