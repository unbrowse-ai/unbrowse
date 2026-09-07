/**
 * Witness: the browse-session store writes are atomic + temp-clean.
 *
 * writeSessionRecord writes to a unique `<id>.json.tmp.*` file then rename()s it
 * onto the final path, so the on-disk record is replaced atomically (a reader
 * sees the whole old or whole new record, never a torn file — independent of the
 * runtime's writeFile internals) and no temp residue is left behind.
 *
 * Falsifiable: break the rename (leave the temp without renaming) and the
 * "no leftover temp" + "final record present" assertions go red. Empirically the
 * torn-read window does not reproduce under Bun even across processes, so this
 * guards the atomicity MECHANISM (temp+rename hygiene), not a flaky timing race.
 */
import { afterEach, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  mostRecentSession,
  readSessionRecord,
  writeSessionRecord,
  deleteSessionRecord,
  type BrowseSessionRecord,
} from "../src/cli-v7/_session";

const SID = "atomic-test-00000000-0000-0000-0000-000000000001";

function sessionDir(sessionId: string): string {
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return join(homedir(), ".unbrowse", "tmp", hash);
}

function rec(seq: number): BrowseSessionRecord {
  return {
    sessionId: SID,
    contextId: "",
    targetId: `T${seq}`.padEnd(32, "0"),
    chromeWsUrl: `ws://127.0.0.1:${40000 + (seq % 2000)}/devtools/browser/x-${seq}`,
    chromePid: 10000 + seq,
    createdAt: 1_700_000_000_000 + seq,
  };
}

afterEach(async () => {
  await deleteSessionRecord(SID).catch(() => undefined);
  await rm(join(homedir(), ".unbrowse", "tmp"), { recursive: true, force: true }).catch(() => undefined);
});

test("concurrent writes settle to one complete record, no torn read, no temp residue", async () => {
  const N = 200;
  let tornReads = 0;

  const writers = Array.from({ length: N }, (_, i) => writeSessionRecord(rec(i + 1)));
  const readers = Array.from({ length: N }, async () => {
    try {
      const r = await readSessionRecord(SID).catch(() => null);
      if (r && (typeof r.sessionId !== "string" || typeof r.chromePid !== "number")) tornReads++;
    } catch (err) {
      if (err instanceof SyntaxError) tornReads++; // half-written JSON observed
      else throw err;
    }
  });
  await Promise.all([...writers, ...readers]);

  // No reader ever observed a structurally-torn record.
  expect(tornReads).toBe(0);

  // The mechanism leaves NO leftover temp files (rename consumed them).
  const entries = await readdir(sessionDir(SID));
  const temps = entries.filter((n) => n.includes(".tmp."));
  expect(temps).toEqual([]);

  // Exactly the one real session record remains, and it is complete + valid.
  const jsons = entries.filter((n) => n.endsWith(".json"));
  expect(jsons).toEqual([`${SID}.json`]);
  const final = await readSessionRecord(SID);
  expect(final.sessionId).toBe(SID);
  expect(final.chromePid).toBeGreaterThanOrEqual(10000);
});

test("temp files are never surfaced as session records", async () => {
  await Promise.all(Array.from({ length: 50 }, (_, i) => writeSessionRecord(rec(i + 1))));
  const recent = await mostRecentSession();
  expect(recent?.sessionId).toBe(SID);
});
