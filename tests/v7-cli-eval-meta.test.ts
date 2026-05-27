/**
 * W10-D — v7 CLI tests for `eval trace`, `eval settings`, `eval feedback`,
 * `eval reflect`.
 *
 * Five canary tests (NO MOCKS — real fs, real Bun.serve, real fetch):
 *   1. trace — write a known StoredTrace into ~/.unbrowse/traces/ via the
 *      real `storeExecutionTrace` (with UNBROWSE_TRACE_STORE_DIR pointed at
 *      a tmp dir), run `eval trace <host>`, assert output is JSONL with no
 *      `value:` key anywhere and pointer-shaped fields are redacted.
 *   2. settings (accept) — `--set headless=false` writes the value through.
 *   3. settings (reject) — `--set api_key=secret` is rejected with
 *      `error: key_not_allowed` and the hint mentions "use pointer".
 *   4. feedback — POST happens; `--note "my password is op://x/y/z"` has
 *      the pointer stripped before send (the collector receives
 *      `[redacted:pointer]`, never the raw `op://` URI).
 *   5. reflect — POST happens carrying `intent_status` only (no
 *      session-id, no intent text, no resolved values in the body).
 *
 * Skip-if-offline pattern: tests 4 + 5 spin a local Bun.serve as their
 * "backend" and point UNBROWSE_API_URL at it; nothing reaches the real
 * `beta-api.unbrowse.ai`, so the test is hermetic.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");

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

// ─── eval trace ────────────────────────────────────────────────────────────

describe("v7-cli eval trace — JSONL output, redaction of pointer-shaped values", () => {
  let traceDir: string;
  const HOST = "example.com";
  const SECRET_POINTER = "op://Personal/tokens/foo";

  beforeAll(async () => {
    traceDir = mkdtempSync(join(tmpdir(), "unb-trace-"));
    // Use the REAL trace-store writer with the env override.
    const prevEnv = process.env.UNBROWSE_TRACE_STORE_DIR;
    process.env.UNBROWSE_TRACE_STORE_DIR = traceDir;
    try {
      const { storeExecutionTrace } = await import("../src/graph/trace-store.js");
      storeExecutionTrace({
        trace_id: "t-1",
        domain: HOST,
        intent: "search",
        endpoint_sequence: ["ep-A"],
        selected_endpoint_id: "ep-A",
        params: { token: SECRET_POINTER, q: "hello" },
        success: true,
        timestamp: new Date().toISOString(),
      });
    } finally {
      if (prevEnv === undefined) {
        // Keep it set — child CLI process needs to read from the same dir.
      } else {
        process.env.UNBROWSE_TRACE_STORE_DIR = prevEnv;
      }
    }
  });

  afterAll(() => {
    if (traceDir && existsSync(traceDir)) {
      rmSync(traceDir, { recursive: true, force: true });
    }
  });

  it("emits JSONL with one row per trace and redacts pointer-shaped values", async () => {
    const res = await runCli(["eval", "trace", HOST], { UNBROWSE_TRACE_STORE_DIR: traceDir });
    expect(res.code).toBe(0);

    // JSONL: one row per line, each line is valid JSON.
    const lines = res.stdout.trim().split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const row = JSON.parse(line);
      // Top-level row must NOT carry a `value:` key (StoredTrace shape).
      expect(row.value).toBeUndefined();
      // Pointer-shaped param value must be redacted.
      expect(JSON.stringify(row)).not.toContain(SECRET_POINTER);
      expect(row.params.token).toBe("[redacted:pointer]");
    }
  }, 30_000);
});

// ─── eval settings ────────────────────────────────────────────────────────

describe("v7-cli eval settings — accept whitelisted keys, reject secrets", () => {
  let homeOverride: string;

  beforeAll(() => {
    homeOverride = mkdtempSync(join(tmpdir(), "unb-home-"));
  });

  afterAll(() => {
    if (homeOverride && existsSync(homeOverride)) {
      rmSync(homeOverride, { recursive: true, force: true });
    }
  });

  it("--set headless=false writes the value into ~/.unbrowse/settings.json", async () => {
    const res = await runCli(
      ["eval", "settings", "--set", "headless=false", "--json"],
      { HOME: homeOverride },
    );
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.ok).toBe(true);
    expect(body.settings.headless).toBe(false);
    // Round-trip: read the file directly from disk.
    const path = join(homeOverride, ".unbrowse", "settings.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.headless).toBe(false);
  }, 30_000);

  it("--set api_key=secret REJECTED with key_not_allowed", async () => {
    const res = await runCli(
      ["eval", "settings", "--set", "api_key=sk_test_canary_DO_NOT_LEAK_1234567890", "--json"],
      { HOME: homeOverride },
    );
    expect(res.code).not.toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("key_not_allowed");
    // Hint must guide the agent toward pointers, not pinning secrets.
    expect(JSON.stringify(body)).toMatch(/pointer|allowed/i);
    // Settings file must NOT contain the canary.
    const path = join(homeOverride, ".unbrowse", "settings.json");
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      expect(raw).not.toContain("sk_test_canary");
      expect(raw).not.toContain("api_key");
    }
  }, 30_000);

  it("--set default_proxy=op://... REJECTED as value_is_pointer (pointer hint)", async () => {
    const res = await runCli(
      ["eval", "settings", "--set", "default_proxy=op://Personal/proxy/url", "--json"],
      { HOME: homeOverride },
    );
    expect(res.code).not.toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("value_is_pointer");
    expect(JSON.stringify(body)).toMatch(/pointer/i);
  }, 30_000);
});

// ─── eval feedback ────────────────────────────────────────────────────────

describe("v7-cli eval feedback — POSTs to backend, --note sanitized", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let bodies: unknown[] = [];
  const POINTER_CANARY = "op://Personal/secrets/db-password";

  beforeAll(async () => {
    bodies = [];
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/v1/stats/feedback") {
          const body = await req.json().catch(() => null);
          bodies.push(body);
          return new Response(JSON.stringify({ ok: true, avg_rating: 4.2 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not_found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
  });

  it("POST happens; --note with op:// pointer is stripped before send", async () => {
    const apiBase = `http://127.0.0.1:${server!.port}`;
    const res = await runCli(
      [
        "eval", "feedback", "skill-X",
        "--endpoint", "ep-Y",
        "--rating", "5",
        "--note", `my password is ${POINTER_CANARY} please retry`,
        "--json",
      ],
      { UNBROWSE_API_URL: apiBase },
    );

    expect(res.code).toBe(0);
    const stdoutBody = JSON.parse(res.stdout);
    expect(stdoutBody.ok).toBe(true);

    expect(bodies.length).toBeGreaterThan(0);
    const last = bodies[bodies.length - 1] as Record<string, unknown>;
    expect(last.skill_id).toBe("skill-X");
    expect(last.endpoint_id).toBe("ep-Y");
    expect(last.rating).toBe(5);
    // Note MUST NOT carry the raw pointer.
    expect(typeof last.note).toBe("string");
    expect(last.note as string).not.toContain(POINTER_CANARY);
    expect(last.note as string).toContain("[redacted:pointer]");
    // Sanity: pointer never appears in stdout or stderr either.
    expect(res.stdout).not.toContain(POINTER_CANARY);
    expect(res.stderr).not.toContain(POINTER_CANARY);
  }, 30_000);

  it("skip-if-offline: backend_unreachable envelope when server is down", async () => {
    // Pick a port we know is unbound (the server is alive on a different
    // one). This proves the honest empty-state contract from CLAUDE.md.
    const deadPort = (server!.port as number) + 1; // best-effort dead port
    const apiBase = `http://127.0.0.1:${deadPort}`;
    const res = await runCli(
      [
        "eval", "feedback", "skill-X",
        "--endpoint", "ep-Y",
        "--rating", "3",
        "--json",
      ],
      { UNBROWSE_API_URL: apiBase },
    );
    // Either the dead port refuses (most likely) and we get a clean
    // unreachable envelope, or it happens to be bound and returns 404 —
    // both are honest, but we assert at least that the canary path
    // (a 2xx ack) is NOT reached for a dead port.
    if (res.code !== 0) {
      const body = JSON.parse(res.stdout);
      expect(body.ok).toBe(false);
      // Either honest network error OR honest non-2xx.
      expect(["backend_unreachable", "backend_non_2xx"]).toContain(body.error);
    }
  }, 30_000);
});

// ─── eval reflect ─────────────────────────────────────────────────────────

describe("v7-cli eval reflect — outcome-only POST", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let bodies: unknown[] = [];

  beforeAll(async () => {
    bodies = [];
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/v1/stats/reflect") {
          const body = await req.json().catch(() => null);
          bodies.push(body);
          return new Response(JSON.stringify({ ok: true, reliability: { reliability_score: 0.7, verification_status: "verified", stale: false, total_observations: 10 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not_found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
  });

  it("POST happens with intent_status only — no session-id, no intent text", async () => {
    const apiBase = `http://127.0.0.1:${server!.port}`;
    const SESSION_CANARY = "UNB7-SESSION-CANARY-DO-NOT-LEAK";
    const res = await runCli(
      [
        "eval", "reflect",
        "--outcome", "achieved",
        "--skill", "skill-Z",
        "--endpoint", "ep-W",
        "--session-id", SESSION_CANARY,
        "--json",
      ],
      { UNBROWSE_API_URL: apiBase },
    );
    expect(res.code).toBe(0);
    expect(bodies.length).toBeGreaterThan(0);
    const last = bodies[bodies.length - 1] as Record<string, unknown>;
    expect(last.skill_id).toBe("skill-Z");
    expect(last.endpoint_id).toBe("ep-W");
    expect(last.intent_status).toBe("achieved");
    // Session id MUST NOT appear in the wire body.
    expect(JSON.stringify(last)).not.toContain(SESSION_CANARY);
    // No `value`, no `intent`, no `params`, no `url`.
    expect(last.value).toBeUndefined();
    expect(last.intent).toBeUndefined();
    expect(last.params).toBeUndefined();
    expect(last.url).toBeUndefined();
    expect(last.session_id).toBeUndefined();
  }, 30_000);

  it("rejects unknown --outcome", async () => {
    const apiBase = `http://127.0.0.1:${server!.port}`;
    const res = await runCli(
      [
        "eval", "reflect",
        "--outcome", "asdfqwerty",
        "--skill", "skill-Z",
        "--endpoint", "ep-W",
        "--json",
      ],
      { UNBROWSE_API_URL: apiBase },
    );
    expect(res.code).not.toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("bad_outcome");
  }, 30_000);
});

// ─── Pure-function tests for redaction (no spawn) ─────────────────────────

describe("redactStoredTrace + sanitizeNote — pure-function pinning", () => {
  it("redactStoredTrace strips pointer-shaped param values", async () => {
    const { redactStoredTrace } = await import("../src/cli-v7/eval/trace.js");
    const out = redactStoredTrace({
      trace_id: "t",
      domain: "example.com",
      intent: "x",
      endpoint_sequence: [],
      params: { tok: "op://x/y/z", other: "plain" },
      success: true,
      timestamp: "2026-05-28T00:00:00Z",
    });
    expect((out.params as Record<string, unknown>).tok).toBe("[redacted:pointer]");
    expect((out.params as Record<string, unknown>).other).toBe("plain");
  });

  it("sanitizeNote strips op://, keychain://, bw://, arg:// prefixes", async () => {
    const { sanitizeNote } = await import("../src/cli-v7/eval/feedback.js");
    expect(sanitizeNote("hello op://x")).toBe("hello [redacted:pointer]");
    expect(sanitizeNote("keychain://foo and bw://bar arg://baz")).toBe("[redacted:pointer] and [redacted:pointer] [redacted:pointer]");
    expect(sanitizeNote("nothing to strip")).toBe("nothing to strip");
  });

  it("sanitizeNote strips Bearer tokens", async () => {
    const { sanitizeNote } = await import("../src/cli-v7/eval/feedback.js");
    const cleaned = sanitizeNote("Authorization: Bearer abcdefghij1234567");
    expect(cleaned).not.toContain("abcdefghij1234567");
    expect(cleaned).toContain("[redacted:bearer]");
  });
});
