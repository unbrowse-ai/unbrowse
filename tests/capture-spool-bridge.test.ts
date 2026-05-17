// Day-5 reproduction: durable raw-capture spool drained by a SEPARATE
// process. Mirrors tests/disk-queue-e2e.test.ts (Day-6 dominion) — real
// spawn, real filesystem, no mocks. Module-level path constants in
// orchestrator/index.ts + indexer/index.ts read `process.env.HOME` at
// load time, so an in-process test that mutates HOME mid-run pollutes
// the real user dir; the spawn pattern is the only honest isolation
// (the child loads modules with HOME=fakeHome from process start).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RawRequest } from "../src/capture/index.js";
import {
  writeCaptureSpool,
  type CaptureSpoolEnvelope,
} from "../src/indexer/capture-spool.js";

const REPO_ROOT = resolve(__dirname, "..");

function sampleRequest(url: string, body: object): RawRequest {
  return {
    url,
    method: "GET",
    request_headers: { accept: "application/json" },
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify(body),
    timestamp: new Date().toISOString(),
  };
}

function makeEnvelope(
  domain: string,
  requests: RawRequest[] = [
    sampleRequest(`https://${domain}/api/items?page=1`, { items: [{ id: 1 }] }),
    sampleRequest(`https://${domain}/api/users/1`, { id: 1, name: "alpha" }),
  ],
): CaptureSpoolEnvelope {
  return {
    version: 1,
    domain,
    capturedAt: Date.now(),
    attempts: 0,
    capture: {
      sessionUrl: `https://${domain}/feed`,
      sessionDomain: domain,
      intent: `browse ${domain}`,
      requests,
      pageHtml: `<html><body>${domain}</body></html>`,
      publishAfterIndex: false,
    },
  };
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runDrain(fakeHome: string, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["src/cli.ts", "__drain-queue"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: fakeHome,
        UNBROWSE_API_URL: "http://127.0.0.1:1",
        UNBROWSE_NO_SWEEP: "0",
        // Force the disk path; we want a real drain pass, not inline.
        UNBROWSE_INLINE_INDEX: "",
        // Enable local cache writes (default off) so persistDomainCache
        // actually writes ~/.unbrowse/domain-skill-cache.json under
        // HOME=fakeHome — the assertion the bridge contract turns on.
        UNBROWSE_LOCAL_CACHES: "1",
      },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`drain spawn timed out after ${timeoutMs}ms; stderr=${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
}

describe("capture-spool drained by a later process (the one-shot fix)", () => {
  let fakeHome: string;
  let spoolDir: string;
  let pendingDir: string;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "capture-spool-bridge-e2e-"));
    spoolDir = join(fakeHome, ".unbrowse", "queue", "capture-pending");
    pendingDir = join(fakeHome, ".unbrowse", "queue", "pending");
    await mkdir(spoolDir, { recursive: true });
    await mkdir(pendingDir, { recursive: true });
  });

  afterEach(async () => {
    if (fakeHome) await rm(fakeHome, { recursive: true, force: true });
  });

  // ── GOLDEN ──────────────────────────────────────────────────────────
  test(
    "golden: separate __drain-queue process turns a capture-pending envelope into ~/.unbrowse/domain-skill-cache.json",
    async () => {
      await writeCaptureSpool(spoolDir, makeEnvelope("api.golden.example"));
      const beforeSpool = await readdir(spoolDir);
      expect(beforeSpool.some((n) => n.endsWith(".json"))).toBe(true);

      const result = await runDrain(fakeHome, 30_000);
      expect(result.code).toBe(0);

      const afterSpool = await readdir(spoolDir).catch(() => []);
      expect(afterSpool.filter((n) => n.endsWith(".json"))).toHaveLength(0);

      const cachePath = join(fakeHome, ".unbrowse", "domain-skill-cache.json");
      expect(existsSync(cachePath)).toBe(true);
      const cache = JSON.parse(await readFile(cachePath, "utf8")) as Record<
        string,
        { skillId: string; localSkillPath: string; ts: number }
      >;
      const entries = Object.values(cache);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(existsSync(entries[0]!.localSkillPath)).toBe(true);
    },
    35_000,
  );

  // ── EDGE: empty-requests envelope drains cleanly ────────────────────
  test(
    "edge: empty-requests envelope is consumed without producing a skill",
    async () => {
      await writeCaptureSpool(spoolDir, makeEnvelope("ssr.example", []));

      const result = await runDrain(fakeHome, 30_000);
      expect(result.code).toBe(0);

      const afterSpool = await readdir(spoolDir).catch(() => []);
      expect(afterSpool.filter((n) => n.endsWith(".json"))).toHaveLength(0);

      const deadDir = join(spoolDir, "dead");
      if (existsSync(deadDir)) {
        const dead = await readdir(deadDir);
        expect(dead.filter((n) => n.endsWith(".json"))).toHaveLength(0);
      }

      const cachePath = join(fakeHome, ".unbrowse", "domain-skill-cache.json");
      if (existsSync(cachePath)) {
        const cache = JSON.parse(await readFile(cachePath, "utf8")) as Record<
          string,
          unknown
        >;
        expect(Object.keys(cache).some((k) => k.includes("ssr.example"))).toBe(false);
      }
    },
    35_000,
  );

  // ── ADVERSARIAL: two disjoint-domain envelopes drained in one lifetime
  test(
    "adversarial: two envelopes from disjoint domains both drain in one worker lifetime",
    async () => {
      await writeCaptureSpool(spoolDir, makeEnvelope("race-a.example"));
      await writeCaptureSpool(spoolDir, makeEnvelope("race-b.example"));

      const result = await runDrain(fakeHome, 30_000);
      expect(result.code).toBe(0);

      const afterSpool = await readdir(spoolDir).catch(() => []);
      expect(afterSpool.filter((n) => n.endsWith(".json"))).toHaveLength(0);

      const cachePath = join(fakeHome, ".unbrowse", "domain-skill-cache.json");
      expect(existsSync(cachePath)).toBe(true);
      const cache = JSON.parse(await readFile(cachePath, "utf8")) as Record<
        string,
        unknown
      >;
      const keys = Object.keys(cache);
      expect(keys.some((k) => k.includes("race-a.example"))).toBe(true);
      expect(keys.some((k) => k.includes("race-b.example"))).toBe(true);
    },
    35_000,
  );
});
