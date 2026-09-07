// Pure disk I/O for the background index queue. Day-3 seed.
import { mkdir, writeFile, rename, readdir, readFile, unlink, open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { BackgroundIndexJob } from "./index.js";
import type { IndexJobId } from "../../runtime/job-store.js";

export interface JobEnvelope {
  version: 1;
  domain: string;
  queuedAt: number;
  attempts: number;
  job: BackgroundIndexJob;
  /** Present for jobs admitted through queueBackgroundIndex; optional for legacy envelopes. */
  durable?: { id: IndexJobId; ownerId: string };
}

export function sanitizeDomain(domain: string): string {
  // NFC normalize first: composed and decomposed unicode (e.g. precomposed Ë
  // vs E + combining diaeresis) collapse to the same byte sequence before the
  // regex replace strips non-ASCII. Two visually-identical domains now produce
  // the same filename and the same envelope.domain field.
  const normalized = domain.normalize("NFC");
  const replaced = normalized.replace(/[^a-zA-Z0-9.-]/g, "_").replace(/\.\.+/g, "__");
  // Cap basename at 200 chars so `${name}.${queuedAt}-${rand}.json.tmp` fits in 255 bytes
  const capped = replaced.length > 200 ? replaced.slice(0, 200) : replaced;
  // Windows reserved-name protection: prefix any output matching CON / PRN /
  // AUX / NUL / COM[1-9] / LPT[1-9] (case-insensitive, dotted or bare) with
  // "_" so the filesystem won't reject or special-case it on Windows. The
  // check runs AFTER sanitize so e.g. raw "@CON" → "_CON" → "__CON".
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(capped)) {
    return `_${capped}`;
  }
  return capped;
}

export async function writeJob(queueDir: string, envelope: JobEnvelope): Promise<string> {
  const absDir = resolve(queueDir);
  await mkdir(absDir, { recursive: true });
  const rand = randomBytes(3).toString("hex");
  const name = `${sanitizeDomain(envelope.domain)}.${envelope.queuedAt}-${rand}.json`;
  const finalPath = join(absDir, name);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(envelope));
  await rename(tmpPath, finalPath);
  return finalPath;
}

// Atomically replace the envelope at `path` with `envelope`. Writes to a sibling
// `.tmp` then renames over the target — the file at `path` always observes
// either the old contents or the new, never partial. Used for retry-counter
// bumps where we must NOT leave both old and new envelopes on disk
// concurrently (would duplicate the job on next drain). The on-disk filename
// keeps its original `queuedAt-rand` suffix; listJobs sorts by envelope.queuedAt
// (the JSON value), so callers can rotate the in-JSON queuedAt to re-queue.
export async function rewriteJobAtPath(path: string, envelope: JobEnvelope): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(envelope));
  await rename(tmpPath, path);
}

export function isJobEnvelope(value: unknown): value is JobEnvelope {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.domain !== "string") return false;
  if (typeof v.queuedAt !== "number" || !Number.isFinite(v.queuedAt)) return false;
  if (typeof v.attempts !== "number" || !Number.isFinite(v.attempts) || v.attempts < 0) return false;
  if (v.job === null || typeof v.job !== "object") return false;
  if (v.durable !== undefined) {
    if (v.durable === null || typeof v.durable !== "object") return false;
    const durable = v.durable as Record<string, unknown>;
    if (typeof durable.id !== "string" || !/^idx_[a-f0-9]{24,64}$/.test(durable.id)) return false;
    if (typeof durable.ownerId !== "string" || !durable.ownerId) return false;
  }
  return true;
}

export async function listJobs(
  queueDir: string,
): Promise<Array<{ path: string; envelope: JobEnvelope }>> {
  const absDir = resolve(queueDir);
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const results: Array<{ path: string; envelope: JobEnvelope }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name.endsWith(".tmp")) continue;
    const path = join(absDir, entry.name);
    let parsed: unknown;
    try {
      const raw = await readFile(path, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isJobEnvelope(parsed)) continue;
    results.push({ path, envelope: parsed });
  }
  results.sort((a, b) => a.envelope.queuedAt - b.envelope.queuedAt);
  return results;
}

export async function deleteJob(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

// Unlink `*.tmp` files in `queueDir` whose mtime is older than maxAgeMs.
// Fire-and-forget hygiene against SIGKILL-orphaned writes (writeJob writes
// `<finalPath>.tmp` then renames; a crash between the two leaves the .tmp
// behind forever, since listJobs filters them out but never unlinks them).
// On missing queueDir: returns 0. Per-file errors are swallowed.
export async function sweepStaleTmp(queueDir: string, maxAgeMs: number = 60_000): Promise<number> {
  const absDir = resolve(queueDir);
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  const now = Date.now();
  let unlinked = 0;
  for (const name of entries) {
    if (!name.endsWith(".tmp")) continue;
    const path = join(absDir, name);
    try {
      const st = await stat(path);
      if (now - st.mtimeMs > maxAgeMs) {
        await unlink(path);
        unlinked += 1;
      }
    } catch {
      // ENOENT (raced), EPERM, or other I/O — best-effort, keep going.
      continue;
    }
  }
  return unlinked;
}

/** How long a 0-byte lock may look "mid-acquire" before it is treated as a
 *  dead writer. The real open()->write() window is microseconds; seconds of
 *  emptiness means the writer never came back. */
const EMPTY_LOCK_GRACE_MS = 5_000;

/** Age of the lock FILE itself (not the heartbeat). Infinity if it vanished —
 *  a lock that disappeared mid-inspection is not held by anyone. */
async function lockAgeMs(lockPath: string): Promise<number> {
  try {
    const st = await stat(lockPath);
    return Date.now() - st.mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export async function acquireLock(lockPath: string, queueDir?: string): Promise<(() => Promise<void>) | null> {
  const tryCreate = async (): Promise<(() => Promise<void>) | null> => {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await unlink(lockPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
          throw err;
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return undefined as any;
    }
  };

  const first = await tryCreate();
  if (first !== undefined) return first;

  // EEXIST: inspect holder. "Alive" → return null; otherwise (stale, ESRCH, or
  // corrupt PID content) fall through to unlink + retry.
  let alive = false;
  let midWrite = false;
  try {
    const raw = await readFile(lockPath, "utf8");
    if (raw.trim() === "") {
      // The lock file exists but its content hasn't been written yet —
      // another caller's open(wx) succeeded but its writeFile(pid) hasn't
      // completed. That's the cold-start race window. Treat as held (the
      // writer is mid-acquire); do NOT reclaim or both callers end up with
      // a release fn. Day-4 Luminary fix #2.
      //
      // BUT bound it by age. That window is open for microseconds — the two
      // syscalls are adjacent. If the writer DIES inside it (SIGKILL, crash,
      // power loss) the file stays 0 bytes forever, and an unbounded
      // `midWrite` makes every future acquirer defer to a process that no
      // longer exists. Observed in the wild: a 0-byte worker.lock silently
      // blocked every queue drain for three days while `__drain-queue` kept
      // exiting 0, so captured routes were indexed, queued, and never became
      // resolvable. Empty for longer than the grace = dead writer, not a
      // live one.
      const emptyForMs = await lockAgeMs(lockPath);
      midWrite = emptyForMs < EMPTY_LOCK_GRACE_MS;
    } else {
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EPERM") alive = true;
        }
      }
    }
  } catch {
    // Corrupt or unreadable lock content — treat as stale.
  }

  // P1-3: PID-reuse safety. If a queueDir was provided and the lock-holder's
  // PID looks alive, ALSO require the heartbeat be fresh. A long-uptime
  // system that reused a stale PID would otherwise hold the lock forever.
  if (alive && queueDir !== undefined) {
    try {
      const age = await heartbeatAgeMs(queueDir);
      // Infinity = no .heartbeat file yet (fresh acquire). Decide on PID alone in that case;
      // a concurrent acquirer in the cold-start race window must not reclaim a live holder
      // just because the heartbeat hasn't been written yet. Day-4 Luminary fix.
      if (Number.isFinite(age) && age > 30_000) alive = false;
    } catch {
      // heartbeat probe shouldn't make a live lock release; ignore.
    }
  }

  if (alive || midWrite) return null;

  // Stale or corrupt — unlink and retry once
  try {
    await unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Someone else may have cleaned it; either way, attempt one more create
    }
  }
  const second = await tryCreate();
  return second === undefined ? null : second;
}

// Global singleton lock for the drain worker. Bounds the system to one
// active drain worker per machine. Wrapper around acquireLock that
// (a) uses the canonical worker.lock path under queueDir and (b) threads
// queueDir through so PID-reuse heartbeat cross-check kicks in.
export async function tryAcquireWorkerSlot(queueDir: string): Promise<(() => Promise<void>) | null> {
  // Cold-start fix (Day-8 audit #3): writeJob and touchHeartbeat already
  // mkdir -p their parent dir; tryAcquireWorkerSlot was the lone path where
  // acquireLock's open(wx) would hit ENOENT on a fresh HOME. Match the
  // pattern: ensure the queueDir exists before any lock attempt.
  await mkdir(resolve(queueDir), { recursive: true });
  const release = await acquireLock(join(queueDir, "worker.lock"), queueDir);
  if (release !== null) {
    // Seal the cold-start race window: touch heartbeat IMMEDIATELY so a
    // concurrent acquirer arriving in the gap before drainOnce's own first
    // touchHeartbeat tick will see a fresh signal and not try to reclaim.
    await touchHeartbeat(queueDir).catch(() => {});
  }
  return release;
}

export async function touchHeartbeat(queueDir: string): Promise<void> {
  const absDir = resolve(queueDir);
  await mkdir(absDir, { recursive: true });
  const path = join(absDir, ".heartbeat");
  await writeFile(path, String(Date.now()));
}

export async function heartbeatAgeMs(queueDir: string): Promise<number> {
  const path = join(resolve(queueDir), ".heartbeat");
  try {
    const st = await stat(path);
    return Date.now() - st.mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return Number.POSITIVE_INFINITY;
    throw err;
  }
}

export interface RejectedFile {
  path: string;
  reason: "corrupt_json" | "wrong_version" | "missing_fields";
}

// Like listJobs but reports rejects instead of silently dropping them.
// Accepted entries match listJobs (sorted by envelope.queuedAt ascending).
// Rejected entries classify why each file failed validation, sorted by path.
export async function listJobsWithRejects(queueDir: string): Promise<{
  accepted: Array<{ path: string; envelope: JobEnvelope }>;
  rejected: RejectedFile[];
}> {
  const absDir = resolve(queueDir);
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { accepted: [], rejected: [] };
    throw err;
  }
  const accepted: Array<{ path: string; envelope: JobEnvelope }> = [];
  const rejected: RejectedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name.endsWith(".tmp")) continue;
    const path = join(absDir, entry.name);
    let parsed: unknown;
    try {
      const raw = await readFile(path, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      rejected.push({ path, reason: "corrupt_json" });
      continue;
    }
    const v = parsed as { version?: unknown } | null;
    if (v === null || typeof v !== "object" || (v as Record<string, unknown>).version !== 1) {
      rejected.push({ path, reason: "wrong_version" });
      continue;
    }
    if (!isJobEnvelope(parsed)) {
      rejected.push({ path, reason: "missing_fields" });
      continue;
    }
    accepted.push({ path, envelope: parsed });
  }
  accepted.sort((a, b) => a.envelope.queuedAt - b.envelope.queuedAt);
  rejected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { accepted, rejected };
}
