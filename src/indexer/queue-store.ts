// Pure disk I/O for the background index queue. Day-3 seed.
import { mkdir, writeFile, rename, readdir, readFile, unlink } from "node:fs/promises";
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

function sanitizeDomain(domain: string): string {
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
