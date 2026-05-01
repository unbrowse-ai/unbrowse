import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { spawnSync } from "node:child_process";

let workDir: string;
let cfgPath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "unbrowse-cap-"));
  cfgPath = join(workDir, "config.json");
  process.env.UNBROWSE_CONFIG_PATH = cfgPath;
  const mod = await import("../src/config/contribution.js");
  mod._clearContributionCacheForTests();
});

afterEach(async () => {
  delete process.env.UNBROWSE_CONFIG_PATH;
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

function runCli(args: string[], env: NodeJS.ProcessEnv): { stdout: string; stderr: string; status: number } {
  // Run the CLI as a subprocess against the stub backend. --no-auto-start
  // skips the local-server bootstrap so we're purely exercising the verb +
  // HTTP envelope shape.
  const res = spawnSync("bun", ["src/cli.ts", ...args, "--no-auto-start"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status ?? 0 };
}

describe("unbrowse capture verb — envelope + share_pointers gate", () => {
  it("hits POST /v1/capture and returns the expected envelope shape", async () => {
    const { server, baseUrl, received } = await startStubBackend(() => ({
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
      const { stdout, status } = runCli(
        ["capture", "--url", "https://example.com", "--intent", "list things"],
        { UNBROWSE_URL: baseUrl, UNBROWSE_NON_INTERACTIVE: "1" },
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
    const { server, baseUrl } = await startStubBackend(() => ({
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
      const { stdout, status } = runCli(
        ["capture", "--url", "https://x.test", "--intent", "x"],
        { UNBROWSE_URL: baseUrl, UNBROWSE_NON_INTERACTIVE: "1" },
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
    const { server, baseUrl } = await startStubBackend(() => ({
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
      const { stdout, status } = runCli(
        ["capture", "--url", "https://empty.test", "--intent", "noop"],
        { UNBROWSE_URL: baseUrl, UNBROWSE_NON_INTERACTIVE: "1" },
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
});

describe("/v1/capture route — share_pointers gate parity", () => {
  it("marketplace_published=false when share_pointers=false (default)", async () => {
    // Stub the orchestrator + execution layers — we're testing the gate logic,
    // not the live browser pipeline.
    const fastify = (await import("fastify")).default;
    const { _clearContributionCacheForTests } = await import("../src/config/contribution.js");
    _clearContributionCacheForTests();

    const app = fastify();
    // Mount a minimal version of the route that mirrors the gate logic,
    // exercising the same getContributionConfig() path the prod handler uses.
    app.post("/v1/capture", async (req, reply) => {
      const body = req.body as { url?: string; intent?: string };
      if (!body.url) return reply.code(400).send({ error: "url required" });
      const { getContributionConfig } = await import("../src/config/contribution.js");
      const sharePointers = getContributionConfig().contribution.share_pointers;
      const endpointsCount = 2;
      // success=true to mirror the prod path
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
      // Default config (no file) → share_pointers=false
      const r1 = await app.inject({ method: "POST", url: "/v1/capture", payload: { url: "https://t.test", intent: "x" } });
      expect(r1.statusCode).toBe(200);
      const j1 = JSON.parse(r1.body);
      expect(j1.marketplace_published).toBe(false);

      // Flip the user opt-in
      const { setContributionConfig } = await import("../src/config/contribution.js");
      setContributionConfig({ contribution: { share_pointers: true, set_via: "setup-prompt" } });

      const r2 = await app.inject({ method: "POST", url: "/v1/capture", payload: { url: "https://t.test", intent: "x" } });
      const j2 = JSON.parse(r2.body);
      expect(j2.marketplace_published).toBe(true);
    } finally {
      await app.close();
    }
  });
});
