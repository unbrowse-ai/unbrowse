// Pure disk I/O for the background index queue. Day-3 seed.
import { mkdir, writeFile, rename, readdir, readFile, unlink, open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { BackgroundIndexJob } from "./index.js";

export interface JobEnvelope {
  version: 1;
  domain: string;
  queuedAt: number;
  attempts: number;
  job: BackgroundIndexJob;
}

export function sanitizeDomain(domain: string): string {
  const replaced = domain.replace(/[^a-zA-Z0-9.-]/g, "_").replace(/\.\.+/g, "__");
  // Cap basename at 200 chars so `${name}.${queuedAt}-${rand}.json.tmp` fits in 255 bytes
  return replaced.length > 200 ? replaced.slice(0, 200) : replaced;
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

export function isJobEnvelope(value: unknown): value is JobEnvelope {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.domain !== "string") return false;
  if (typeof v.queuedAt !== "number" || !Number.isFinite(v.queuedAt)) return false;
  if (typeof v.attempts !== "number" || !Number.isFinite(v.attempts) || v.attempts < 0) return false;
  if (v.job === null || typeof v.job !== "object") return false;
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

export async function acquireLock(lockPath: string): Promise<(() => Promise<void>) | null> {
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
  try {
    const raw = await readFile(lockPath, "utf8");
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
  } catch {
    // Corrupt or unreadable lock content — treat as stale.
  }

  if (alive) return null;

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
