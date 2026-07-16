import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";

let workDir: string;
let cfgPath: string;
let skillCacheDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "unbrowse-cap-"));
  cfgPath = join(workDir, "config.json");
  process.env.UNBROWSE_CONFIG_PATH = cfgPath;
  // Isolate the local skill-cache too: cmdCapture's coverage pre-check
  // (src/capture/coverage-check.ts) now reads it, and the real user's
  // ~/.unbrowse/skill-cache can genuinely already have entries for common
  // test domains like example.com from real prior usage — without this, a
  // test's outcome would depend on whoever's machine it runs on.
  skillCacheDir = join(workDir, "skill-cache");
  process.env.UNBROWSE_SKILL_CACHE_DIR = skillCacheDir;
  const mod = await import("../src/config/contribution.js");
  mod._clearContributionCacheForTests();
});

afterEach(async () => {
  delete process.env.UNBROWSE_CONFIG_PATH;
  delete process.env.UNBROWSE_SKILL_CACHE_DIR;
  const mod = await import("../src/config/contribution.js");
  mod._clearContributionCacheForTests();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface CapturedRequest { method: string; url: string; body: unknown }

function startStubBackend(canned: (req: CapturedRequest) => { status: number; body: unknown }): Promise<{ server: Server; baseUrl: string; received: CapturedRequest[] }> {
  return new Promise((resolve) => {
    const received: CapturedRequest[] = [];
    const server = createServer((req, res) => {
      let chunks = "";
      req.on("data", (d) => { chunks += d; });
      req.on("end", () => {
        let body: unknown = null;
        try { body = chunks ? JSON.parse(chunks) : null; } catch { body = chunks; }
        const r = { method: req.method ?? "GET", url: req.url ?? "/", body };
        received.push(r);
        const out = canned(r);
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, received });
    });
  });
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; status: number }> {
  // Async spawn — spawnSync blocks the parent event loop, so the stub HTTP
  // server in this same process can't accept connections during CLI execution.
  // The CLI's fetchServerHealth then times out and ensureLocalServer throws
  // "Server not running" before any /v1/* call lands. Real spawn keeps the
  // event loop pumping so the stub answers /health.
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("bun", ["src/cli.ts", ...args, "--no-auto-start"], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf-8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf-8"); });
    child.on("close", (status) => {
      resolve({ stdout, stderr, status: status ?? 0 });
    });
  });
}

// Every real capture test below now needs BOTH the local in-process server
// (UNBROWSE_URL, serves /v1/capture) AND the marketplace backend
// (UNBROWSE_API_URL, serves /v1/search/resolve for the coverage pre-check in
// src/capture/coverage-check.ts) stubbed — otherwise the pre-check silently
// falls through to the REAL production backend, which is both slow and
// non-hermetic (a real domain like example.com may genuinely already be
// covered there). Route on req.url so one stub server can serve both.
function cannedWithEmptyCoverage(
  captureResponse: { status: number; body: unknown },
): (req: CapturedRequest) => { status: number; body: unknown } {
  return (req) => {
    if (req.url === "/v1/search/resolve") {
      return { status: 200, body: { domain_results: [], global_results: [] } };
    }
    return captureResponse;
  };
}

describe("unbrowse capture verb — envelope + share_pointers gate", () => {
  it("hits POST /v1/capture and returns the expected envelope shape", async () => {
    const { server, baseUrl, received } = await startStubBackend(cannedWithEmptyCoverage({
      status: 200,
      body: {
        skill_id: "skill-abc",
        endpoints_discovered: 3,
        marketplace_published: false,
        ms: 1234,
        endpoints: [{ endpoint_id: "e1" }, { endpoint_id: "e2" }, { endpoint_id: "e3" }],
        skill: { skill_id: "skill-abc" },
        trace: { success: true },
      },
    }));
    try {
      const { stdout, status } = await runCli(
        ["breath", "capture", "--url", "https://example.com", "--intent", "list things"],
        { UNBROWSE_URL: baseUrl, UNBROWSE_API_URL: baseUrl, UNBROWSE_NON_INTERACTIVE: "1" },
      );
      expect(status).toBe(0);
      // Stub received exactly one POST /v1/capture
      const cap = received.find((r) => r.method === "POST" && r.url === "/v1/capture");
      expect(cap).toBeDefined();
      const reqBody = cap!.body as Record<string, unknown>;
      expect(reqBody.url).toBe("https://example.com");
      expect(reqBody.intent).toBe("list things");

      // CLI envelope on stdout
      const lines = stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      const envelope = JSON.parse(lines[lines.length - 1]!);
      expect(envelope.skill_id).toBe("skill-abc");
      expect(envelope.endpoints_discovered).toBe(3);
      expect(envelope.marketplace_published).toBe(false);
      expect(typeof envelope.ms).toBe("number");
      expect(envelope.next_step).toContain("unbrowse resolve");
      expect(envelope.next_step).toContain("https://example.com");
    } finally {
      server.close();
    }
  });

  it("surfaces marketplace_published=true when the backend reports it", async () => {
    const { server, baseUrl } = await startStubBackend(cannedWithEmptyCoverage({
      status: 200,
      body: {
        skill_id: "skill-xyz",
        endpoints_discovered: 1,
        marketplace_published: true,
        ms: 800,
        endpoints: [{ endpoint_id: "e1" }],
      },
    }));
    try {
      const { stdout, status } = await runCli(
        ["breath", "capture", "--url", "https://x.test", "--intent", "x"],
        { UNBROWSE_URL: baseUrl, UNBROWSE_API_URL: baseUrl, UNBROWSE_NON_INTERACTIVE: "1" },
      );
      expect(status).toBe(0);
      const lines = stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      const envelope = JSON.parse(lines[lines.length - 1]!);
      expect(envelope.marketplace_published).toBe(true);
      expect(envelope.skill_id).toBe("skill-xyz");
    } finally {
      server.close();
    }
  });

  it("returns the no-endpoints next_step hint when endpoints_discovered=0", async () => {
    const { server, baseUrl } = await startStubBackend(cannedWithEmptyCoverage({
      status: 200,
      body: {
        skill_id: "skill-empty",
        endpoints_discovered: 0,
        marketplace_published: false,
        ms: 500,
        endpoints: [],
      },
    }));
    try {
      const { stdout, status } = await runCli(
        ["breath", "capture", "--url", "https://empty.test", "--intent", "noop"],
        { UNBROWSE_URL: baseUrl, UNBROWSE_API_URL: baseUrl, UNBROWSE_NON_INTERACTIVE: "1" },
      );
      expect(status).toBe(0);
      const lines = stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      const envelope = JSON.parse(lines[lines.length - 1]!);
      expect(envelope.endpoints_discovered).toBe(0);
      expect(envelope.next_step).toContain("no endpoints");
    } finally {
      server.close();
    }
  });

  it("skips the real capture (never POSTs /v1/capture) when the domain is already covered locally", async () => {
    const { server, baseUrl, received } = await startStubBackend(() => ({
      status: 200,
      body: { skill_id: "should-never-be-called", endpoints_discovered: 1, marketplace_published: false, ms: 1, endpoints: [] },
    }));
    const skillCacheDir = mkdtempSync(join(tmpdir(), "unbrowse-cap-cache-"));
    writeFileSync(
      join(skillCacheDir, "already-covered-skill.json"),
      JSON.stringify({
        skill_id: "already-covered-skill",
        domain: "already-covered.example",
        endpoints: [{ endpoint_id: "e1", method: "GET", url_template: "https://already-covered.example/api/data", idempotency: "safe", verification_status: "active", reliability_score: 0.9 }],
      }),
    );
    try {
      const { stdout, status } = await runCli(
        ["breath", "capture", "--url", "https://already-covered.example/page", "--intent", "list things"],
        { UNBROWSE_URL: baseUrl, UNBROWSE_NON_INTERACTIVE: "1", UNBROWSE_SKILL_CACHE_DIR: skillCacheDir },
      );
      expect(status).toBe(0);
      const cap = received.find((r) => r.method === "POST" && r.url === "/v1/capture");
      expect(cap).toBeUndefined(); // the real capture must never have been called

      const lines = stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      const envelope = JSON.parse(lines[lines.length - 1]!);
      expect(envelope.skipped).toBe(true);
      expect(envelope.source).toBe("local_cache");
      expect(envelope.skill_id).toBe("already-covered-skill");
    } finally {
      server.close();
      rmSync(skillCacheDir, { recursive: true, force: true });
    }
  });

  it("--force bypasses the coverage check and captures anyway", async () => {
    const { server, baseUrl, received } = await startStubBackend(() => ({
      status: 200,
      body: { skill_id: "fresh-capture", endpoints_discovered: 2, marketplace_published: false, ms: 1, endpoints: [{ endpoint_id: "e1" }, { endpoint_id: "e2" }] },
    }));
    const skillCacheDir = mkdtempSync(join(tmpdir(), "unbrowse-cap-cache-force-"));
    writeFileSync(
      join(skillCacheDir, "already-covered-skill.json"),
      JSON.stringify({
        skill_id: "already-covered-skill",
        domain: "force-me.example",
        endpoints: [{ endpoint_id: "e1", method: "GET", url_template: "https://force-me.example/api/data", idempotency: "safe", verification_status: "active", reliability_score: 0.9 }],
      }),
    );
    try {
      const { stdout, status } = await runCli(
        ["breath", "capture", "--url", "https://force-me.example/page", "--intent", "list things", "--force"],
        { UNBROWSE_URL: baseUrl, UNBROWSE_NON_INTERACTIVE: "1", UNBROWSE_SKILL_CACHE_DIR: skillCacheDir },
      );
      expect(status).toBe(0);
      const cap = received.find((r) => r.method === "POST" && r.url === "/v1/capture");
      expect(cap).toBeDefined(); // --force must reach the real capture

      const lines = stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      const envelope = JSON.parse(lines[lines.length - 1]!);
      expect(envelope.skill_id).toBe("fresh-capture");
      expect(envelope.skipped).toBeUndefined();
    } finally {
      server.close();
      rmSync(skillCacheDir, { recursive: true, force: true });
    }
  });
});

describe("/v1/capture route — share_pointers gate parity", () => {
  it("marketplace_published mirrors share_pointers (default true)", async () => {
    const fastify = (await import("fastify")).default;
    const { _clearContributionCacheForTests } = await import("../src/config/contribution.js");
    _clearContributionCacheForTests();

    const app = fastify();
    app.post("/v1/capture", async (req, reply) => {
      const body = req.body as { url?: string; intent?: string };
      if (!body.url) return reply.code(400).send({ error: "url required" });
      const { getContributionConfig } = await import("../src/config/contribution.js");
      const sharePointers = getContributionConfig().contribution.share_pointers;
      const endpointsCount = 2;
      const marketplacePublished = sharePointers && endpointsCount > 0;
      return reply.send({
        skill_id: "skill-test",
        endpoints_discovered: endpointsCount,
        marketplace_published: marketplacePublished,
        ms: 100,
        endpoints: [{ endpoint_id: "a" }, { endpoint_id: "b" }],
      });
    });

    try {
      // Default config (no file) → share_pointers=true (opt-out).
      const r1 = await app.inject({ method: "POST", url: "/v1/capture", payload: { url: "https://t.test", intent: "x" } });
      expect(r1.statusCode).toBe(200);
      const j1 = JSON.parse(r1.body);
      expect(j1.marketplace_published).toBe(true);

      // User opts out
      const { setContributionConfig } = await import("../src/config/contribution.js");
      setContributionConfig({ contribution: { share_pointers: false, set_via: "mode-command" } });

      const r2 = await app.inject({ method: "POST", url: "/v1/capture", payload: { url: "https://t.test", intent: "x" } });
      const j2 = JSON.parse(r2.body);
      expect(j2.marketplace_published).toBe(false);
    } finally {
      await app.close();
    }
  });
});
