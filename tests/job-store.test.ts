import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DurableJobStore, type JobId } from "../src/runtime/job-store.js";

const roots: string[] = [];
function store() { const root = mkdtempSync(path.join(tmpdir(), "unbrowse-jobs-")); roots.push(root); return new DurableJobStore(root); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("DurableJobStore", () => {
  test("uses kind-specific typed ids and survives a new store instance", () => {
    const first = store();
    const job = first.create({ kind: "capture", ownerId: "runner-1", input: { url: "https://example.com" }, now: 10 });
    expect(job.id).toMatch(/^cap_[a-f0-9]{32}$/);
    expect(new DurableJobStore(first.root).get(job.id)).toEqual(job);
  });

  test("persists output separately and terminal transitions are permanent", () => {
    const s = store();
    const job = s.create({ kind: "index", ownerId: "owner", now: 1 });
    const completed = s.complete(job.id, "owner", { hits: [1, 2] }, 2);
    expect(completed.status).toBe("completed");
    expect(s.readOutput(job.id)).toEqual({ hits: [1, 2] });
    expect(readFileSync(path.join(s.root, "jobs", `${job.id}.json`), "utf8")).not.toContain('"hits"');
    expect(s.complete(job.id, "owner", { overwritten: true }, 3)).toEqual(completed);
    expect(() => s.kill(job.id, "owner")).toThrow("permanently completed");
    expect(() => s.heartbeat(job.id, "owner")).toThrow("permanently completed");
    expect(s.readOutput(job.id)).toEqual({ hits: [1, 2] });
  });

  test("completion polling is idempotent and owner acknowledgement gates GC", () => {
    const s = store();
    const a = s.create({ kind: "validation", ownerId: "a", now: 1 });
    const b = s.create({ kind: "publish", ownerId: "b", now: 1 });
    s.fail(a.id, "a", new Error("nope"), 2);
    s.kill(b.id, "b", "stop", 2);
    expect(s.pendingCompletions("a").map(j => j.id)).toEqual([a.id]);
    expect(s.pendingCompletions("a").map(j => j.id)).toEqual([a.id]);
    expect(s.cleanup({ now: 100, limit: 10 })).toEqual([]);
    expect(s.acknowledge(a.id, "a", 10).acknowledgedAt).toBe(10);
    expect(s.acknowledge(a.id, "a", 11).acknowledgedAt).toBe(10);
    expect(s.pendingCompletions("a")).toEqual([]);
    expect(s.cleanup({ now: 100, olderThanMs: 50, limit: 10 })).toEqual([a.id]);
    expect(s.get(a.id)).toBeUndefined();
    expect(s.get(b.id)?.status).toBe("killed");
  });

  test("recovers stale and orphaned running jobs with bounded work", () => {
    const s = store();
    const stale = s.create({ kind: "capture", ownerId: "live", now: 0 });
    const orphan = s.create({ kind: "index", ownerId: "dead", now: 90 });
    const fresh = s.create({ kind: "validation", ownerId: "live", now: 90 });
    const first = s.recover({ now: 100, staleAfterMs: 50, liveOwnerIds: new Set(["live"]), limit: 1 });
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe(stale.id);
    expect(first[0].error?.code).toBe("STALE");
    const rest = s.recover({ now: 100, staleAfterMs: 50, liveOwnerIds: new Set(["live"]), limit: 10 });
    expect(rest.map(j => j.id)).toEqual([orphan.id]);
    expect(rest[0].error?.code).toBe("ORPHANED");
    expect(s.get(fresh.id)?.status).toBe("running");
  });

  test("enforces ownership and cleanup limit", () => {
    const s = store(); const ids: JobId[] = [];
    for (const kind of ["capture", "capture", "capture"] as const) {
      const j = s.create({ kind, ownerId: "right", now: 1 }); ids.push(j.id);
      s.kill(j.id, "right", "done", 2); s.acknowledge(j.id, "right", 3);
    }
    expect(() => s.complete(ids[0], "wrong", "x")).toThrow("owner mismatch");
    expect(s.cleanup({ now: 10, limit: 2 })).toHaveLength(2);
    expect(s.list()).toHaveLength(1);
  });
});
