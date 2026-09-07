/**
 * W9-A — v7 CLI breath {type, press, scroll} tests.
 *
 * Scope:
 *   1. `type "hello world"` (literal) — succeeds without audit POST.
 *   2. `type arg://greeting --arg greeting=hello` — resolves, dispatches
 *      Input.insertText, POSTs AuditFillBody with variant=fill, NO `value`
 *      in body.
 *   3. CANARY: type with pointer resolves to UNB7-TYPE-CANARY-DO-NOT-LEAK;
 *      assert nothing leaks the cleartext into stdout/stderr/session/audit.
 *   4. `press Enter` — dispatches Input.dispatchKeyEvent down+up, no audit.
 *   5. `press NotAKey` — exits 64 (EX_USAGE) with `unknown key`.
 *   6. `scroll 0,500` — viewport scroll, no audit.
 *   7. `scroll '#main' 0,200` — element-anchored scroll.
 *
 * Gating: tests that need a real Chrome session run only when
 * UNBROWSE_W5W6_READY=1. Pure-argv tests (no session needed: #5 and the
 * missing-positional / bad-amount sweeps) always run because the handlers
 * shortcut on those paths BEFORE attempting session resolution.
 *
 * No mocks (no-mocks rule). The audit endpoint is a local Bun.serve() —
 * a real network socket; the wire shape is what we're asserting.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const W5W6_READY = process.env.UNBROWSE_W5W6_READY === "1";
const TYPE_CANARY = "UNB7-TYPE-CANARY-DO-NOT-LEAK";
const SESSIONS_DIR = join(homedir(), ".unbrowse", "sessions");
const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");

interface AuditCapture {
  bodies: unknown[];
  port: number;
  url: string;
  stop: () => Promise<void>;
}

async function startAuditMock(): Promise<AuditCapture> {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/audit/fill") {
        return new Response("not_found", { status: 404 });
      }
      const body = await req.json().catch(() => null);
      bodies.push(body);
      return new Response(JSON.stringify({ ok: true, receiptId: "test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    bodies,
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
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

// ─── Always-on: pure-argv tests ────────────────────────────────────────────
// These exits happen BEFORE session resolution, so a non-running Chrome is
// fine.

describe("v7-cli breath press — pure-argv", () => {
  it("5. `press NotAKey` exits 64 (EX_USAGE) with `unknown key`", async () => {
    const res = await runCli(["breath", "press", "NotAKey", "--json"]);
    expect(res.code).toBe(64);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("unknown key");
    expect(out.key).toBe("NotAKey");
    expect(Array.isArray(out.valid_keys)).toBe(true);
    expect(out.valid_keys).toContain("Enter");
  });

  it("`press` with no key exits with missing_positional", async () => {
    const res = await runCli(["breath", "press", "--json"]);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.error).toBe("missing_positional");
  });

  it("`press --help` prints the subcommand surface and exits 64", async () => {
    const res = await runCli(["breath", "press", "--help", "--json"]);
    expect(res.code).toBe(64);
    const out = JSON.parse(res.stdout);
    expect(out.help).toBe(true);
    expect(out.subcommand).toBe("breath press");
    expect(out.op_kind).toBe("breath:press");
    expect(out.mcp_tool).toBe("unbrowse_press");
  });
});

describe("v7-cli breath scroll — pure-argv", () => {
  it("`scroll bogus` exits 64 (EX_USAGE) with bad_amount_format", async () => {
    const res = await runCli(["breath", "scroll", "bogus", "--json"]);
    expect(res.code).toBe(64);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("bad_amount_format");
  });

  it("`scroll` with no positional exits missing_positional", async () => {
    const res = await runCli(["breath", "scroll", "--json"]);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.error).toBe("missing_positional");
  });

  it("`scroll --help` carries the kind-map row", async () => {
    const res = await runCli(["breath", "scroll", "--help", "--json"]);
    expect(res.code).toBe(64);
    const out = JSON.parse(res.stdout);
    expect(out.subcommand).toBe("breath scroll");
    expect(out.op_kind).toBe("breath:scroll");
    expect(out.mcp_tool).toBe("unbrowse_scroll");
  });
});

describe("v7-cli breath type — pure-argv", () => {
  it("`type` with no positional exits missing_positional", async () => {
    const res = await runCli(["breath", "type", "--json"]);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.error).toBe("missing_positional");
  });

  it("`type --help` carries the kind-map row and pointer schemes", async () => {
    const res = await runCli(["breath", "type", "--help", "--json"]);
    expect(res.code).toBe(64);
    const out = JSON.parse(res.stdout);
    expect(out.subcommand).toBe("breath type");
    expect(out.op_kind).toBe("breath:type");
    expect(out.mcp_tool).toBe("unbrowse_type");
    // The help must warn that literal text is non-auditable.
    const positionalDesc = JSON.stringify(out.positional);
    expect(positionalDesc).toContain("arg://");
  });
});

// ─── End-to-end (gated on W5+W6 readiness) ─────────────────────────────────

describe.if(W5W6_READY)("v7-cli breath {type, press, scroll} (e2e — W5+W6 required)", () => {
  let audit: AuditCapture;
  let sessionId: string;

  beforeAll(async () => {
    await clearSessions();
    audit = await startAuditMock();

    // Open ONE session reused across the e2e tests.
    const res = await runCli(["breath", "go", "https://example.com", "--json"]);
    if (res.code !== 0) {
      throw new Error(`failed to open session: ${res.stderr}`);
    }
    const out = JSON.parse(res.stdout);
    sessionId = out.session_id as string;
  }, 30_000);

  afterAll(async () => {
    if (sessionId) {
      await runCli(["breath", "close", sessionId, "--json"]);
    }
    await audit?.stop();
    await clearSessions();
  });

  it("1. `type \"hello world\"` (literal) — succeeds without audit POST", async () => {
    const before = audit.bodies.length;
    const res = await runCli(
      ["breath", "type", "hello world", "--session", sessionId, "--json"],
      { UNBROWSE_API_URL: audit.url },
    );
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.path).toBe("literal");
    expect(out.audit).toBe(false);
    // Literal path echoes — caller passed it on CLI explicitly.
    expect(out.text).toBe("hello world");
    // NO new audit body was POSTed.
    expect(audit.bodies.length).toBe(before);
  }, 30_000);

  it("2. `type arg://greeting --arg greeting=hello` — POSTs valid AuditFillBody, no value field", async () => {
    const before = audit.bodies.length;
    const res = await runCli(
      [
        "breath", "type", "arg://greeting",
        "--argScope", JSON.stringify({ greeting: "hello" }),
        "--session", sessionId,
        "--json",
      ],
      { UNBROWSE_API_URL: audit.url },
    );
    expect(res.code).toBe(0);
    expect(audit.bodies.length).toBe(before + 1);
    const body = audit.bodies[audit.bodies.length - 1] as Record<string, unknown>;
    expect(body.pointer).toBe("arg://greeting");
    expect(typeof body.nonce).toBe("string");
    expect((body.contextHash as string)).toMatch(/^[0-9a-f]{64}$/);
    expect((body.commitment as string)).toMatch(/^[0-9a-f]{64}$/);
    expect((body.walletPubkey as string)).toMatch(/^[0-9a-f]{64}$/);
    expect((body.signature as string)).toMatch(/^[0-9a-f]{128}$/);
    expect(body.signatureScheme).toBe("ed25519-v7.0");
    expect(body.variant).toBe("fill");
    // Load-bearing forbidden-field check.
    expect("value" in body).toBe(false);
    expect("cleartext" in body).toBe(false);
    expect("secret" in body).toBe(false);

    const out = JSON.parse(res.stdout);
    expect(out.path).toBe("pointer");
    expect(out.audit).toBe(true);
    expect(out.pointer).toBe("arg://greeting");
    // The cleartext must NOT appear in the stdout receipt.
    expect(res.stdout).not.toContain("hello");
  }, 30_000);

  it("3. CANARY: `type` with pointer resolves to a canary — value MUST NOT leak", async () => {
    const beforeBodies = audit.bodies.length;
    const res = await runCli(
      [
        "breath", "type", "arg://canary",
        "--argScope", JSON.stringify({ canary: TYPE_CANARY }),
        "--session", sessionId,
        "--json",
      ],
      { UNBROWSE_API_URL: audit.url },
    );
    expect(res.code).toBe(0);

    // stdout/stderr — no canary leak.
    expect(res.stdout).not.toContain(TYPE_CANARY);
    expect(res.stderr).not.toContain(TYPE_CANARY);

    // Session file — no canary leak.
    if (sessionId) {
      const recPath = join(SESSIONS_DIR, `${sessionId}.json`);
      if (existsSync(recPath)) {
        const recRaw = await readFile(recPath, "utf8");
        expect(recRaw).not.toContain(TYPE_CANARY);
      }
    }

    // Audit body — the new POST must not contain the canary.
    expect(audit.bodies.length).toBe(beforeBodies + 1);
    const lastBody = audit.bodies[audit.bodies.length - 1];
    expect(JSON.stringify(lastBody)).not.toContain(TYPE_CANARY);

    // Defensive sweep — every session file canary-clean.
    if (existsSync(SESSIONS_DIR)) {
      for (const name of await readdir(SESSIONS_DIR)) {
        const txt = await readFile(join(SESSIONS_DIR, name), "utf8");
        expect(txt).not.toContain(TYPE_CANARY);
      }
    }
  }, 30_000);

  it("4. `press Enter` — dispatches keyDown+keyUp, no audit POST", async () => {
    const before = audit.bodies.length;
    const res = await runCli(
      ["breath", "press", "Enter", "--session", sessionId, "--json"],
      { UNBROWSE_API_URL: audit.url },
    );
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.subcommand).toBe("breath press");
    expect(out.key).toBe("Enter");
    expect(out.code).toBe("Enter");
    // No audit POST for press.
    expect(audit.bodies.length).toBe(before);
  }, 30_000);

  it("6. `scroll 0,500` — viewport scroll, no audit", async () => {
    const before = audit.bodies.length;
    const res = await runCli(
      ["breath", "scroll", "0,500", "--session", sessionId, "--json"],
      { UNBROWSE_API_URL: audit.url },
    );
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.selector).toBeNull();
    expect(out.dx).toBe(0);
    expect(out.dy).toBe(500);
    expect(out.anchor).toBeDefined();
    expect(typeof out.anchor.x).toBe("number");
    expect(typeof out.anchor.y).toBe("number");
    expect(audit.bodies.length).toBe(before);
  }, 30_000);

  it("7. `scroll body 0,200` — element-anchored scroll (`body` always exists on example.com)", async () => {
    const before = audit.bodies.length;
    const res = await runCli(
      ["breath", "scroll", "body", "0,200", "--session", sessionId, "--json"],
      { UNBROWSE_API_URL: audit.url },
    );
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.selector).toBe("body");
    expect(out.dx).toBe(0);
    expect(out.dy).toBe(200);
    expect(audit.bodies.length).toBe(before);
  }, 30_000);
});
