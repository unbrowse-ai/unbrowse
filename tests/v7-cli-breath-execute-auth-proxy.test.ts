/**
 * W9-C — v7 CLI tests for `breath execute` / `breath auth-capture` /
 * `breath proxy-rotate`.
 *
 * Three canary tests are LOAD-BEARING (no-leak assertions):
 *   1. execute --header X-Auth=arg://token --arg token=SECRET:
 *      audit row carries variant=header-inject + headerNameHash=sha256("X-Auth");
 *      SECRET appears in NEITHER stdout, stderr, audit-rows, NOR session files.
 *   2. execute --params '{"q":"arg://query"}' --arg query=hello:
 *      audit row carries variant=payload-field + payloadPath="$.q";
 *      "hello" appears in NEITHER stdout, stderr, audit-rows, NOR session files.
 *   3. auth-capture http://localhost:<port>/login:
 *      cookie value UNB7-AUTH-CANARY-DO-NOT-LEAK appears in NEITHER stdout,
 *      stderr, the session record, NOR the auth_profile.json sidecar;
 *      the keychain pointer keychain://unbrowse-auth/localhost is the only
 *      surface that references the capture.
 *
 * Plus operational tests:
 *   4. proxy-rotate without ~/.identity/iproyal-creds: exit envelope is
 *      honest 503-shaped (`error: iproyal_creds_missing`, `status: 503`).
 *   5. Gated W5/W6 cases run end-to-end when UNBROWSE_W5W6_READY=1.
 *
 * Test discipline: no mocks. Real Bun.serve for the audit collector and
 * the local login endpoint. Real fetch from the CLI process. Real
 * filesystem for session records.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

const W5W6_READY = process.env.UNBROWSE_W5W6_READY === "1";
const HEADER_CANARY = "UNB7-EXEC-HEADER-CANARY-DO-NOT-LEAK";
const PAYLOAD_CANARY = "UNB7-EXEC-PAYLOAD-CANARY-DO-NOT-LEAK";
const AUTH_CANARY = "UNB7-AUTH-CANARY-DO-NOT-LEAK";
const SESSIONS_DIR = join(homedir(), ".unbrowse", "sessions");
const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");

interface AuditCapture {
  bodies: unknown[];
  port: number;
  url: string;
  /** Endpoints registered for lookup: id → { url, method, headers, body }. */
  endpoints: Record<string, { url: string; method: string; headers?: Record<string, string>; body?: string }>;
  /** Records every outbound request that hit the upstream URL (the "endpoint"). */
  upstreamHits: Array<{ method: string; url: string; headers: Record<string, string>; bodyText: string }>;
  stop: () => Promise<void>;
}

async function startCollector(): Promise<AuditCapture> {
  const bodies: unknown[] = [];
  const endpoints: Record<string, { url: string; method: string; headers?: Record<string, string>; body?: string }> = {};
  const upstreamHits: AuditCapture["upstreamHits"] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      // Audit collector
      if (u.pathname === "/v1/audit/fill") {
        const body = await req.json().catch(() => null);
        bodies.push(body);
        return new Response(JSON.stringify({ ok: true, receiptId: "test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Endpoint descriptor lookup (marketplace shape)
      if (u.pathname.startsWith("/v1/endpoints/")) {
        const id = decodeURIComponent(u.pathname.slice("/v1/endpoints/".length));
        const ep = endpoints[id];
        if (!ep) return new Response("not_found", { status: 404 });
        return new Response(JSON.stringify({ endpoint_id: id, ...ep }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Upstream replay target — any request whose path starts with /upstream
      // is the "real endpoint" the execute handler is replaying.
      if (u.pathname.startsWith("/upstream")) {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        const bodyText = await req.text();
        upstreamHits.push({
          method: req.method,
          url: req.url,
          headers,
          bodyText,
        });
        return new Response(JSON.stringify({ ok: true, echo_query: Object.fromEntries(u.searchParams) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not_found", { status: 404 });
    },
  });

  return {
    bodies,
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    endpoints,
    upstreamHits,
    stop: async () => {
      server.stop(true);
    },
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolveP) => {
    const child = spawn("bun", ["run", CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

async function clearSessions(): Promise<void> {
  if (existsSync(SESSIONS_DIR)) {
    await rm(SESSIONS_DIR, { recursive: true, force: true });
  }
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Defensive canary sweep: read every file under ~/.unbrowse/sessions/ and
 * assert the canary string does NOT appear in any of them.
 */
async function assertNoCanaryInSessionsDir(canary: string): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) return;
  for (const name of await readdir(SESSIONS_DIR)) {
    const txt = await readFile(join(SESSIONS_DIR, name), "utf8");
    expect(txt).not.toContain(canary);
  }
}

// ─── Always-on: unit tests for the proxy URL builder ───────────────────────

describe("v7-cli proxy-rotate buildIproyalProxyUrl (pure)", () => {
  it("encodes country lock into password and keeps username:password separate", async () => {
    const mod = await import("../src/cli-v7/breath/proxy-rotate.js");
    const out = mod.buildIproyalProxyUrl({
      creds: { username: "pZgLYgbG8xumONBZ", password: "VovZmYSD6xqhG6fE" },
      country: "MY",
    });
    expect(out.server).toBe("http://geo.iproyal.com:12321");
    expect(out.username).toBe("pZgLYgbG8xumONBZ");
    expect(out.passwordWithCountry).toBe("VovZmYSD6xqhG6fE_country-my");
  });

  it("omits the country suffix when --country is not supplied", async () => {
    const mod = await import("../src/cli-v7/breath/proxy-rotate.js");
    const out = mod.buildIproyalProxyUrl({
      creds: { username: "u", password: "p" },
    });
    expect(out.passwordWithCountry).toBe("p");
  });

  it("respects a custom endpoint override", async () => {
    const mod = await import("../src/cli-v7/breath/proxy-rotate.js");
    const out = mod.buildIproyalProxyUrl({
      creds: { username: "u", password: "p", endpoint: "alt.example.com:8080" },
    });
    expect(out.server).toBe("http://alt.example.com:8080");
  });
});

// ─── proxy-rotate honest-503 surface (always runs — no W5/W6 needed) ───────

describe("v7-cli breath proxy-rotate — honest 503 when creds missing", () => {
  let savedCredsBak: string | null = null;
  const credsPath = join(homedir(), ".identity", "iproyal-creds");

  beforeAll(async () => {
    // If the user actually has creds, move them aside for the duration of
    // this test so the missing-file path is exercised. We restore on exit.
    if (existsSync(credsPath)) {
      savedCredsBak = await readFile(credsPath, "utf8");
      await rm(credsPath, { force: true });
    }
  });

  afterAll(async () => {
    if (savedCredsBak !== null) {
      await mkdir(join(homedir(), ".identity"), { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(credsPath, savedCredsBak, { mode: 0o600 });
    }
  });

  it("exits with honest 503-shaped error envelope (no silent fallback)", async () => {
    const res = await runCli(["breath", "proxy-rotate", "--json"]);
    expect(res.code).not.toBe(0);
    // Honest empty-state envelope per CLAUDE.md (no-stubs rule): the
    // surface MUST tell the agent exactly what's missing and where.
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("iproyal_creds_missing");
    expect(out.status).toBe(503);
    expect(typeof out.path_expected).toBe("string");
    expect(out.path_expected).toContain("iproyal-creds");
    expect(typeof out.hint).toBe("string");
  }, 15_000);
});

// ─── End-to-end tests (gated on W5/W6 readiness) ───────────────────────────

describe.if(W5W6_READY)("v7-cli execute / auth-capture (e2e — W5+W6 required)", () => {
  let collector: AuditCapture;

  beforeAll(async () => {
    await clearSessions();
    collector = await startCollector();
  });

  afterAll(async () => {
    await collector?.stop();
    await clearSessions();
  });

  it("execute --header X-Auth=arg://token: posts header-inject audit row, no SECRET leak", async () => {
    const endpointId = "ep-header-canary";
    collector.endpoints[endpointId] = {
      url: `${collector.url}/upstream/header-test`,
      method: "GET",
    };
    const beforeCount = collector.bodies.length;

    const res = await runCli(
      [
        "breath", "execute", endpointId,
        "--header", "X-Auth=arg://token",
        "--argScope", JSON.stringify({ token: HEADER_CANARY }),
        "--json",
      ],
      { UNBROWSE_API_URL: collector.url },
    );

    expect(res.code).toBe(0);

    // 1. Canary MUST NOT appear in stdout / stderr.
    expect(res.stdout).not.toContain(HEADER_CANARY);
    expect(res.stderr).not.toContain(HEADER_CANARY);

    // 2. Audit row was POSTed with the right variant + locator hash.
    expect(collector.bodies.length).toBeGreaterThan(beforeCount);
    const lastBody = collector.bodies[collector.bodies.length - 1] as Record<string, unknown>;
    expect(lastBody.variant).toBe("header-inject");
    expect(lastBody.headerNameHash).toBe(sha256Hex("X-Auth"));
    expect(lastBody.pointer).toBe("arg://token");
    // Canary NEVER in the audit body itself.
    expect(JSON.stringify(lastBody)).not.toContain(HEADER_CANARY);

    // 3. Upstream request DID get the canary in the header (this is the
    //    sanctioned destination — the wire to the real endpoint).
    expect(collector.upstreamHits.length).toBeGreaterThan(0);
    const lastHit = collector.upstreamHits[collector.upstreamHits.length - 1];
    expect(lastHit.headers["x-auth"]).toBe(HEADER_CANARY);

    // 4. Session files canary-clean.
    await assertNoCanaryInSessionsDir(HEADER_CANARY);
  }, 30_000);

  it("execute --params '{\"q\":\"arg://query\"}': posts payload-field audit row, no PAYLOAD leak", async () => {
    const endpointId = "ep-payload-canary";
    collector.endpoints[endpointId] = {
      url: `${collector.url}/upstream/payload-test`,
      method: "POST",
    };
    const beforeCount = collector.bodies.length;

    const res = await runCli(
      [
        "breath", "execute", endpointId,
        "--params", JSON.stringify({ q: "arg://query" }),
        "--argScope", JSON.stringify({ query: PAYLOAD_CANARY }),
        "--json",
      ],
      { UNBROWSE_API_URL: collector.url },
    );

    expect(res.code).toBe(0);

    // Canary leak-checks.
    expect(res.stdout).not.toContain(PAYLOAD_CANARY);
    expect(res.stderr).not.toContain(PAYLOAD_CANARY);

    expect(collector.bodies.length).toBeGreaterThan(beforeCount);
    const lastBody = collector.bodies[collector.bodies.length - 1] as Record<string, unknown>;
    expect(lastBody.variant).toBe("payload-field");
    expect(lastBody.payloadPath).toBe("$.q");
    expect(lastBody.pointer).toBe("arg://query");
    expect(JSON.stringify(lastBody)).not.toContain(PAYLOAD_CANARY);

    // Upstream POST got the canary in the body JSON (sanctioned).
    const lastHit = collector.upstreamHits[collector.upstreamHits.length - 1];
    expect(lastHit.bodyText).toContain(PAYLOAD_CANARY);

    await assertNoCanaryInSessionsDir(PAYLOAD_CANARY);
  }, 30_000);

  it("auth-capture: cookie value lands in keychain ONLY; sidecar + stdout carry pointer", async () => {
    // Spawn a tiny login server that sets the canary cookie on /login.
    const loginPort = collector.port; // reuse collector? — no, need /login
    void loginPort;

    const loginServer = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/login") {
          return new Response(
            `<html><body>logged in</body></html>`,
            {
              status: 200,
              headers: {
                "content-type": "text/html",
                // Set-Cookie: canary value lands here. Path=/, no domain →
                // Chrome stores under the loginServer host (127.0.0.1).
                "set-cookie": `session=${AUTH_CANARY}; Path=/; HttpOnly`,
              },
            },
          );
        }
        return new Response("not_found", { status: 404 });
      },
    });
    const loginUrl = `http://127.0.0.1:${loginServer.port}/login`;

    try {
      const res = await runCli(
        [
          "breath", "auth-capture", loginUrl,
          "--domain", "127.0.0.1",
          "--settle", "1000",
          "--timeout", "30000",
          "--json",
        ],
      );

      // CANARY must NEVER appear in stdout/stderr.
      expect(res.stdout).not.toContain(AUTH_CANARY);
      expect(res.stderr).not.toContain(AUTH_CANARY);

      expect(res.code).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.ok).toBe(true);
      expect(out.pointer).toBe("keychain://unbrowse-auth/127.0.0.1");
      expect(Array.isArray(out.cookie_names)).toBe(true);
      expect(out.cookie_names).toContain("session");

      // Session record on disk — canary-clean.
      await assertNoCanaryInSessionsDir(AUTH_CANARY);

      // Stateless: no cleartext auth_profile.json sidecar — only a sha256 inventory
      // ref crosses to disk (STATELESS_BOUNDARY §H invariant 7). Assert the sealed
      // shape and that the canary leaks nowhere (a hash cannot carry it).
      expect(out.cookies_inventory_ref).toMatch(/^[0-9a-f]{64}$/);
      expect(out.cookies_inventory_ref).not.toContain(AUTH_CANARY);

      // Cleanup the keychain entry we just wrote so re-runs are idempotent.
      try {
        const { spawn: cpSpawn } = await import("node:child_process");
        await new Promise<void>((resolveP) => {
          const c = cpSpawn("/usr/bin/security", ["delete-generic-password", "-s", "unbrowse-auth", "-a", "127.0.0.1"], { stdio: "ignore" });
          c.on("close", () => resolveP());
          c.on("error", () => resolveP());
        });
      } catch { /* best-effort */ }
    } finally {
      loginServer.stop(true);
    }
  }, 120_000);
});
