/**
 * Durable, process-safe storage for long-running harness jobs.
 *
 * A job is one small metadata file and (after success) one separate output file.
 * Updates are serialized per job and committed with fsync + rename.  Completion
 * remains visible until its owner explicitly acknowledges it; notification reads
 * are consequently safe to retry.
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type CaptureJobId = Brand<`cap_${string}`, "CaptureJobId">;
export type IndexJobId = Brand<`idx_${string}`, "IndexJobId">;
export type ValidationJobId = Brand<`val_${string}`, "ValidationJobId">;
export type PublishJobId = Brand<`pub_${string}`, "PublishJobId">;
export type JobId = CaptureJobId | IndexJobId | ValidationJobId | PublishJobId;
export type JobKind = "capture" | "index" | "validation" | "publish";
export type TerminalJobStatus = "completed" | "failed" | "killed";
export type JobStatus = "running" | TerminalJobStatus;

const PREFIX: Record<JobKind, string> = { capture: "cap_", index: "idx_", validation: "val_", publish: "pub_" };
const ID_RE = /^(cap|idx|val|pub)_[a-f0-9]{24,64}$/;

interface JobBase {
  version: 1;
  id: JobId;
  kind: JobKind;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  input?: unknown;
}
export interface RunningJob extends JobBase { status: "running"; }
export interface TerminalJob extends JobBase {
  status: TerminalJobStatus;
  finishedAt: number;
  /** Acknowledgement is the GC barrier. */
  acknowledgedAt?: number;
  error?: { message: string; code?: string };
  output?: { encoding: "json" | "utf8" | "bytes"; bytes: number };
}
export type JobRecord = RunningJob | TerminalJob;
export interface CreateJobOptions { kind: JobKind; ownerId: string; input?: unknown; now?: number; id?: JobId }
export interface RecoveryOptions {
  staleAfterMs: number;
  now?: number;
  /** If supplied, a running job whose owner is absent is recovered immediately. */
  liveOwnerIds?: ReadonlySet<string>;
  limit?: number;
}
export interface CleanupOptions { now?: number; olderThanMs?: number; limit?: number }

function assertOwner(ownerId: string): void {
  if (!ownerId || ownerId.length > 512 || /[\0\r\n]/.test(ownerId)) throw new Error("invalid job ownerId");
}
function assertId(id: string): asserts id is JobId {
  if (!ID_RE.test(id)) throw new Error(`invalid job id: ${id}`);
}
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export class DurableJobStore {
  readonly root: string;
  private readonly jobsDir: string;
  private readonly outputsDir: string;
  private readonly locksDir: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(root: string, options: { lockTimeoutMs?: number; staleLockMs?: number } = {}) {
    if (!root) throw new Error("job store root is required");
    this.root = path.resolve(root);
    this.jobsDir = path.join(this.root, "jobs");
    this.outputsDir = path.join(this.root, "outputs");
    this.locksDir = path.join(this.root, "locks");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 60_000;
    for (const dir of [this.root, this.jobsDir, this.outputsDir, this.locksDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  create(options: CreateJobOptions): JobRecord {
    assertOwner(options.ownerId);
    const id = options.id ?? this.newId(options.kind);
    assertId(id);
    if (!id.startsWith(PREFIX[options.kind])) throw new Error("job id does not match kind");
    const now = options.now ?? Date.now();
    const record: RunningJob = { version: 1, id, kind: options.kind, ownerId: options.ownerId, status: "running", createdAt: now, updatedAt: now, heartbeatAt: now, ...(options.input === undefined ? {} : { input: options.input }) };
    return this.withLock(id, () => {
      if (existsSync(this.jobPath(id))) throw new Error(`job already exists: ${id}`);
      this.atomicWrite(this.jobPath(id), JSON.stringify(record));
      return record;
    });
  }

  get(id: JobId | string): JobRecord | undefined {
    assertId(id);
    try {
      const value = JSON.parse(readFileSync(this.jobPath(id), "utf8")) as JobRecord;
      this.validate(value, id);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  list(options: { ownerId?: string; status?: JobStatus; limit?: number } = {}): JobRecord[] {
    const limit = boundedLimit(options.limit);
    const result: JobRecord[] = [];
    for (const name of readdirSync(this.jobsDir).sort()) {
      if (result.length >= limit) break;
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const job = this.get(id);
      if (job && (!options.ownerId || job.ownerId === options.ownerId) && (!options.status || job.status === options.status)) result.push(job);
    }
    return result;
  }

  heartbeat(id: JobId | string, ownerId: string, now = Date.now()): JobRecord {
    return this.mutateRunning(id, ownerId, job => ({ ...job, heartbeatAt: now, updatedAt: now }));
  }

  complete(id: JobId | string, ownerId: string, value: unknown, now = Date.now()): JobRecord {
    assertId(id); assertOwner(ownerId);
    return this.withLock(id, () => {
      const existing = this.require(id);
      this.assertOwner(existing, ownerId);
      if (existing.status !== "running") {
        // Retried delivery of completion is idempotent. It never overwrites output.
        if (existing.status === "completed") return existing;
        throw new Error(`job is permanently ${existing.status}`);
      }
      const encoded = encodeOutput(value);
      this.atomicWrite(this.outputPath(id), encoded.data);
      const terminal: TerminalJob = { ...existing, status: "completed", updatedAt: now, finishedAt: now, output: { encoding: encoded.encoding, bytes: encoded.data.byteLength } };
      this.atomicWrite(this.jobPath(id), JSON.stringify(terminal));
      return terminal;
    });
  }

  fail(id: JobId | string, ownerId: string, error: unknown, now = Date.now()): JobRecord {
    return this.terminate(id, ownerId, "failed", normalizeError(error), now);
  }
  kill(id: JobId | string, ownerId: string, reason = "killed", now = Date.now()): JobRecord {
    return this.terminate(id, ownerId, "killed", { message: reason, code: "KILLED" }, now);
  }

  readOutput<T = unknown>(id: JobId | string): T {
    assertId(id);
    const job = this.require(id);
    if (job.status !== "completed" || !job.output) throw new Error("job has no completed output");
    const data = readFileSync(this.outputPath(id));
    if (data.byteLength !== job.output.bytes) throw new Error("job output is truncated");
    if (job.output.encoding === "bytes") return new Uint8Array(data) as T;
    const text = data.toString("utf8");
    return (job.output.encoding === "json" ? JSON.parse(text) : text) as T;
  }
  getOutput<T = unknown>(id: JobId | string): T { return this.readOutput<T>(id); }

  /** Repeated calls return the same terminals until acknowledge() commits the receipt. */
  pendingCompletions(ownerId: string, limit?: number): TerminalJob[] {
    assertOwner(ownerId);
    return this.list({ ownerId, limit: boundedLimit(limit) }).filter((j): j is TerminalJob => j.status !== "running" && j.acknowledgedAt === undefined);
  }
  getPendingCompletions(ownerId: string, limit?: number): TerminalJob[] { return this.pendingCompletions(ownerId, limit); }

  acknowledge(id: JobId | string, ownerId: string, now = Date.now()): TerminalJob {
    assertId(id); assertOwner(ownerId);
    return this.withLock(id, () => {
      const job = this.require(id); this.assertOwner(job, ownerId);
      if (job.status === "running") throw new Error("cannot acknowledge a running job");
      if (job.acknowledgedAt !== undefined) return job;
      const next = { ...job, acknowledgedAt: now, updatedAt: now };
      this.atomicWrite(this.jobPath(id), JSON.stringify(next));
      return next;
    });
  }

  /** Permanently fails stale jobs and jobs whose owner is known to be gone. */
  recover(options: RecoveryOptions): TerminalJob[] {
    if (!Number.isFinite(options.staleAfterMs) || options.staleAfterMs < 0) throw new Error("invalid staleAfterMs");
    const now = options.now ?? Date.now();
    const recovered: TerminalJob[] = [];
    for (const job of this.list({ status: "running", limit: boundedLimit(options.limit) })) {
      const orphan = options.liveOwnerIds !== undefined && !options.liveOwnerIds.has(job.ownerId);
      const stale = now - job.heartbeatAt >= options.staleAfterMs;
      if (!orphan && !stale) continue;
      try {
        const next = this.terminate(job.id, job.ownerId, "failed", { message: orphan ? "job owner is no longer alive" : "job heartbeat expired", code: orphan ? "ORPHANED" : "STALE" }, now);
        recovered.push(next as TerminalJob);
      } catch { /* another process may have completed it */ }
    }
    return recovered;
  }
  recoverStale(options: RecoveryOptions): TerminalJob[] { return this.recover(options); }

  /** Deletes only acknowledged terminals, and never more than limit. */
  cleanup(options: CleanupOptions = {}): JobId[] {
    const now = options.now ?? Date.now();
    const age = options.olderThanMs ?? 0;
    if (!Number.isFinite(age) || age < 0) throw new Error("invalid olderThanMs");
    const limit = boundedLimit(options.limit);
    const deleted: JobId[] = [];
    for (const job of this.list({ limit: Number.MAX_SAFE_INTEGER })) {
      if (deleted.length >= limit) break;
      if (job.status === "running" || job.acknowledgedAt === undefined || now - job.acknowledgedAt < age) continue;
      this.withLock(job.id, () => {
        const current = this.require(job.id);
        if (current.status === "running" || current.acknowledgedAt === undefined || now - current.acknowledgedAt < age) return;
        try { unlinkSync(this.outputPath(job.id)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        unlinkSync(this.jobPath(job.id));
        this.syncDir(this.jobsDir); this.syncDir(this.outputsDir);
        deleted.push(job.id);
      });
    }
    return deleted;
  }

  private newId(kind: JobKind): JobId { return `${PREFIX[kind]}${randomBytes(16).toString("hex")}` as JobId; }
  private jobPath(id: string): string { return path.join(this.jobsDir, `${id}.json`); }
  private outputPath(id: string): string { return path.join(this.outputsDir, `${id}.out`); }
  private require(id: JobId): JobRecord { const j = this.get(id); if (!j) throw new Error(`job not found: ${id}`); return j; }
  private assertOwner(job: JobRecord, ownerId: string): void { if (job.ownerId !== ownerId) throw new Error("job owner mismatch"); }
  private mutateRunning(idValue: JobId | string, ownerId: string, fn: (j: RunningJob) => RunningJob): JobRecord {
    assertId(idValue); assertOwner(ownerId);
    return this.withLock(idValue, () => { const job = this.require(idValue); this.assertOwner(job, ownerId); if (job.status !== "running") throw new Error(`job is permanently ${job.status}`); const next = fn(job); this.atomicWrite(this.jobPath(idValue), JSON.stringify(next)); return next; });
  }
  private terminate(idValue: JobId | string, ownerId: string, status: "failed" | "killed", error: { message: string; code?: string }, now: number): JobRecord {
    assertId(idValue); assertOwner(ownerId);
    return this.withLock(idValue, () => {
      const job = this.require(idValue); this.assertOwner(job, ownerId);
      if (job.status !== "running") {
        if (job.status === status) return job; // retry is harmless
        throw new Error(`job is permanently ${job.status}`);
      }
      const next: TerminalJob = { ...job, status, error, updatedAt: now, finishedAt: now };
      this.atomicWrite(this.jobPath(idValue), JSON.stringify(next)); return next;
    });
  }
  private validate(job: JobRecord, expected: string): void {
    if (job?.version !== 1 || job.id !== expected || !ID_RE.test(job.id) || !["running", "completed", "failed", "killed"].includes(job.status)) throw new Error(`corrupt job metadata: ${expected}`);
  }
  private atomicWrite(destination: string, data: string | Uint8Array): void {
    const temp = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temp, destination); this.syncDir(path.dirname(destination)); }
    catch (e) { try { unlinkSync(temp); } catch {} throw e; }
  }
  private syncDir(dir: string): void { let fd: number | undefined; try { fd = openSync(dir, "r"); fsyncSync(fd); } catch {} finally { if (fd !== undefined) closeSync(fd); } }
  private withLock<T>(id: JobId, fn: () => T): T {
    const lock = path.join(this.locksDir, `${id}.lock`); const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try { mkdirSync(lock, { mode: 0o700 }); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try { if (Date.now() - statSync(lock).mtimeMs > this.staleLockMs) { rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
        if (Date.now() >= deadline) throw new Error(`timed out locking job: ${id}`);
        sleep(5);
      }
    }
    try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
  }
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit < 0) throw new Error("limit must be a non-negative integer");
  return Math.min(limit, 10_000);
}
function normalizeError(value: unknown): { message: string; code?: string } {
  if (value instanceof Error) return { message: value.message, ...(typeof (value as NodeJS.ErrnoException).code === "string" ? { code: (value as NodeJS.ErrnoException).code } : {}) };
  return { message: typeof value === "string" ? value : "job failed" };
}
function encodeOutput(value: unknown): { encoding: "json" | "utf8" | "bytes"; data: Uint8Array } {
  if (value instanceof Uint8Array) return { encoding: "bytes", data: value };
  if (typeof value === "string") return { encoding: "utf8", data: Buffer.from(value) };
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("job output is not serializable");
  return { encoding: "json", data: Buffer.from(json) };
}
