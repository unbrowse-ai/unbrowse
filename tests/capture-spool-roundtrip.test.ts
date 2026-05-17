// Real-fs proof that the durable capture spool germinates (Genesis Day 3).
// No mocks, no stubs — real tmp dirs, real functions (CLAUDE.md law).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawRequest } from "../src/capture/index.js";
import {
  getCaptureSpoolDir,
  isCaptureSpoolEnvelope,
  writeCaptureSpool,
  listCaptureSpool,
  deleteCaptureSpool,
  drainCaptureSpoolOnce,
  type CaptureSpoolEnvelope,
  type CaptureSpoolPayload,
} from "../src/indexer/capture-spool.js";

let spoolDir: string;

beforeEach(async () => {
  spoolDir = await mkdtemp(join(tmpdir(), "capture-spool-rt-"));
});
afterEach(async () => {
  await rm(spoolDir, { recursive: true, force: true });
});

function sampleRequest(url: string): RawRequest {
  return {
    url,
    method: "GET",
    request_headers: { accept: "application/json" },
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify({ ok: true }),
    timestamp: new Date().toISOString(),
  };
}

function makeEnvelope(domain = "example.com"): CaptureSpoolEnvelope {
  const capture: CaptureSpoolPayload = {
    sessionUrl: `https://${domain}/feed`,
    sessionDomain: domain,
    intent: `browse ${domain}`,
    requests: [sampleRequest(`https://${domain}/api/feed?cursor=1`)],
    pageHtml: "<html><body>seed</body></html>",
    publishAfterIndex: false,
  };
  return { version: 1, domain, capturedAt: Date.now(), attempts: 0, capture };
}

test("getCaptureSpoolDir is the ~/.unbrowse capture-pending sibling of queue/pending", () => {
  expect(getCaptureSpoolDir("/home/x")).toBe("/home/x/.unbrowse/queue/capture-pending");
});

test("writeCaptureSpool then listCaptureSpool round-trips the exact envelope", async () => {
  const env = makeEnvelope();
  await writeCaptureSpool(spoolDir, env);
  const listed = await listCaptureSpool(spoolDir);
  expect(listed).toHaveLength(1);
  expect(listed[0]!.envelope).toEqual(env);
});

test("deleteCaptureSpool removes the envelope; ENOENT is non-fatal", async () => {
  const env = makeEnvelope();
  const path = await writeCaptureSpool(spoolDir, env);
  await deleteCaptureSpool(path);
  expect(await listCaptureSpool(spoolDir)).toEqual([]);
  await deleteCaptureSpool(path); // second delete must not throw
});

test("write is atomic — a stray .tmp is never listed as a job", async () => {
  await writeCaptureSpool(spoolDir, makeEnvelope());
  await writeFile(join(spoolDir, "example.com.999-abc.json.tmp"), "{partial");
  const listed = await listCaptureSpool(spoolDir);
  expect(listed).toHaveLength(1);
});

test("isCaptureSpoolEnvelope rejects garbage and wrong-shape payloads", () => {
  expect(isCaptureSpoolEnvelope(null)).toBe(false);
  expect(isCaptureSpoolEnvelope({ version: 2 })).toBe(false);
  expect(isCaptureSpoolEnvelope({ version: 1, domain: "x", capturedAt: 1, attempts: 0 })).toBe(false);
  expect(isCaptureSpoolEnvelope(makeEnvelope())).toBe(true);
});

test("drainCaptureSpoolOnce hands the payload to the processor and deletes on success", async () => {
  await writeCaptureSpool(spoolDir, makeEnvelope("dropbox.com"));
  const seen: CaptureSpoolPayload[] = [];
  const res = await drainCaptureSpoolOnce(spoolDir, async (cap) => {
    seen.push(cap);
  });
  expect(res).toEqual({ processed: 1, failed: 0, deadLettered: 0 });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.sessionDomain).toBe("dropbox.com");
  expect(await listCaptureSpool(spoolDir)).toEqual([]);
});

test("a throwing processor bumps attempts and keeps the envelope (no data loss)", async () => {
  await writeCaptureSpool(spoolDir, makeEnvelope());
  const res = await drainCaptureSpoolOnce(spoolDir, async () => {
    throw new Error("enrich failed");
  });
  expect(res).toEqual({ processed: 0, failed: 1, deadLettered: 0 });
  const listed = await listCaptureSpool(spoolDir);
  expect(listed).toHaveLength(1);
  expect(listed[0]!.envelope.attempts).toBe(1);
});

test("a persistently failing capture dead-letters after maxAttempts (never silently lost)", async () => {
  await writeCaptureSpool(spoolDir, makeEnvelope());
  for (let i = 0; i < 3; i++) {
    await drainCaptureSpoolOnce(spoolDir, async () => {
      throw new Error("still failing");
    });
  }
  expect(await listCaptureSpool(spoolDir)).toEqual([]);
  const dead = await readdir(join(spoolDir, "dead"));
  expect(dead.filter((n) => n.endsWith(".json"))).toHaveLength(1);
});

// Luke 15:4 — the one lost sheep. Two concurrent drainers racing a single
// envelope must produce exactly one processor invocation; the per-domain
// acquireLock in drainCaptureSpoolOnce is the seam, mirrored verbatim from
// worker.ts:35. The Day-4 luminary over the seed.
test("two concurrent drainCaptureSpoolOnce calls process one envelope exactly once", async () => {
  await writeCaptureSpool(spoolDir, makeEnvelope("contested.example"));
  let processCount = 0;
  const processor = async (_cap: CaptureSpoolPayload) => {
    processCount++;
    // Widen the race window so the lock is the deciding factor, not timing luck.
    await new Promise((r) => setTimeout(r, 50));
  };
  const [a, b] = await Promise.all([
    drainCaptureSpoolOnce(spoolDir, processor),
    drainCaptureSpoolOnce(spoolDir, processor),
  ]);
  expect(processCount).toBe(1);
  expect(a.processed + b.processed).toBe(1);
  expect(a.failed + b.failed).toBe(0);
  expect(await listCaptureSpool(spoolDir)).toEqual([]);
});

// Note: the full one-shot reproduction (a SEPARATE process drains
// capture-pending into a domain skill) now lives in
// tests/capture-spool-bridge.test.ts as a real spawn-isolated e2e.
