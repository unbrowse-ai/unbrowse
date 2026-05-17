// Durable on-disk spool for RAW pre-enrichment browse capture.
//
// Why this exists: a one-shot `unbrowse_go` that exits before any flush loses
// its captured route. The existing durable queue (queue-store.ts) only engages
// at the TAIL of the ~40s enrich pipeline (lightFlush/flush), which the
// one-shot process never survives. This spool stores the CHEAP, broker-bound
// raw material (already converted to RawRequest[], fully JSON-safe) at the tail
// of /v1/browse/go BEFORE the response is sent, so any later process can run
// the expensive enrich -> index -> publish offline.
//
// Boundary discipline (Genesis Day 2 / Matt 9:17): the enriched JobEnvelope in
// queue-store.ts is the "old bottle" and is left untouched. This is the new
// bottle for the new wine. We REUSE queue-store's pure primitives
// (sanitizeDomain, acquireLock, touchHeartbeat, sweepStaleTmp) by import — the
// locking/heartbeat infra is shared, not duplicated; only the envelope-typed
// serialization seam is local.
import { mkdir, writeFile, rename, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { randomBytes } from "node:crypto";
import type { RawRequest } from "../capture/index.js";
import { sanitizeDomain, acquireLock, touchHeartbeat, sweepStaleTmp } from "./queue-store.js";

/** The serialisable cut of a live browse capture. NO broker-shaped fields,
 *  NO Maps/streams/functions — exactly what passiveIndexFromRequests wants. */
export interface CaptureSpoolPayload {
  sessionUrl: string;
  sessionDomain: string;
  intent: string;
  requests: RawRequest[];
  /** Page HTML already fetched at the go tail (d8fdd960). Carried for a
   *  future DOM-fallback drain; the v1 processor is route-bearing only. */
  pageHtml?: string;
  publishAfterIndex: boolean;
}

export interface CaptureSpoolEnvelope {
  version: 1;
  domain: string;
  capturedAt: number;
  attempts: number;
  capture: CaptureSpoolPayload;
}

/** ~/.unbrowse/queue/capture-pending — sibling of queue/pending, sharing the
 *  same .heartbeat / dead / quarantine conventions. */
export function getCaptureSpoolDir(home: string = process.env.HOME ?? "/tmp"): string {
  return join(home, ".unbrowse", "queue", "capture-pending");
}

export function isCaptureSpoolEnvelope(value: unknown): value is CaptureSpoolEnvelope {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.domain !== "string") return false;
  if (typeof v.capturedAt !== "number" || !Number.isFinite(v.capturedAt)) return false;
  if (typeof v.attempts !== "number" || !Number.isFinite(v.attempts) || v.attempts < 0) return false;
  const cap = v.capture as Record<string, unknown> | null;
  if (cap === null || typeof cap !== "object") return false;
  if (typeof cap.sessionUrl !== "string") return false;
  if (typeof cap.sessionDomain !== "string") return false;
  if (typeof cap.intent !== "string") return false;
  if (!Array.isArray(cap.requests)) return false;
  if (typeof cap.publishAfterIndex !== "boolean") return false;
  return true;
}

/** Atomic write: tmp then rename — the final path always observes either the
 *  whole envelope or nothing (mirrors queue-store.writeJob). */
export async function writeCaptureSpool(
  spoolDir: string,
  envelope: CaptureSpoolEnvelope,
): Promise<string> {
  const absDir = resolve(spoolDir);
  await mkdir(absDir, { recursive: true });
  const rand = randomBytes(3).toString("hex");
  const name = `${sanitizeDomain(envelope.domain)}.${envelope.capturedAt}-${rand}.json`;
  const finalPath = join(absDir, name);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(envelope));
  await rename(tmpPath, finalPath);
  return finalPath;
}

/** Atomic in-place rewrite (retry-counter bump) — never leaves two envelopes
 *  for one capture on disk (mirrors queue-store.rewriteJobAtPath). */
export async function rewriteCaptureSpoolAtPath(
  path: string,
  envelope: CaptureSpoolEnvelope,
): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(envelope));
  await rename(tmpPath, path);
}

export async function listCaptureSpool(
  spoolDir: string,
): Promise<Array<{ path: string; envelope: CaptureSpoolEnvelope }>> {
  const absDir = resolve(spoolDir);
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const results: Array<{ path: string; envelope: CaptureSpoolEnvelope }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name.endsWith(".tmp")) continue;
    const path = join(absDir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    if (!isCaptureSpoolEnvelope(parsed)) continue;
    results.push({ path, envelope: parsed });
  }
  results.sort((a, b) => a.envelope.capturedAt - b.envelope.capturedAt);
  return results;
}

export async function deleteCaptureSpool(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export type CaptureSpoolProcessor = (capture: CaptureSpoolPayload) => Promise<void>;

/**
 * Drain one pass of the capture spool. Mirrors worker.drainOnce: per-domain
 * lock (so a concurrent drainer can't double-process), success -> delete,
 * failure -> attempts++ (atomic rewrite) or dead-letter at maxAttempts.
 * The processor is injected (the routes-side bridge to passiveIndexFromRequests
 * is wired in a later step); this primitive stays generic and broker-free.
 */
export async function drainCaptureSpoolOnce(
  spoolDir: string,
  processor: CaptureSpoolProcessor,
  maxAttempts = 3,
): Promise<{ processed: number; failed: number; deadLettered: number }> {
  await touchHeartbeat(spoolDir).catch(() => {});
  await sweepStaleTmp(spoolDir).catch(() => {});
  let processed = 0;
  let failed = 0;
  let deadLettered = 0;

  const accepted = await listCaptureSpool(spoolDir);
  for (const { path, envelope } of accepted) {
    const lockPath = join(resolve(spoolDir), sanitizeDomain(envelope.domain) + ".lock");
    const release = await acquireLock(lockPath);
    if (release === null) continue;
    try {
      try {
        await processor(envelope.capture);
        await deleteCaptureSpool(path);
        processed++;
      } catch {
        const newAttempts = envelope.attempts + 1;
        if (newAttempts >= maxAttempts) {
          const deadDir = join(resolve(spoolDir), "dead");
          await mkdir(deadDir, { recursive: true });
          await rename(path, join(deadDir, basename(path))).catch(async () => {
            await deleteCaptureSpool(path);
          });
          deadLettered++;
        } else {
          await rewriteCaptureSpoolAtPath(path, {
            ...envelope,
            capturedAt: Date.now(),
            attempts: newAttempts,
          });
          failed++;
        }
      }
    } finally {
      await release();
    }
  }
  return { processed, failed, deadLettered };
}
