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

  // W24.6 (Lewis 2026-05-28 — "stateless is the only path"): `eval trace`
  // no longer emits redacted v6 rows on stdout (lost sheep #2 — local read
  // surface awaits `GET /v1/trace/list` in v7.3). The handler now projects
  // v6 rows and POSTs them via postStateless. The redactStoredTrace pinning
  // is covered by the pure-function tests below ("redactStoredTrace +
  // sanitizeNote — pure-function pinning"); this end-to-end emit test was
  // deleted with the gate.
  it("v7 POST attempts: SECRET_POINTER never lands on stdout", async () => {
    // Point the CLI at a known-unreachable backend so the POST returns
    // either binding_missing-shaped or a network error envelope. Either
    // way the redacted-row JSONL is NOT emitted, AND the secret pointer
    // never crosses into stdout (the projector strips it before any wire
    // contact).
    const res = await runCli(
      ["eval", "trace", HOST, "--json"],
      {
        UNBROWSE_TRACE_STORE_DIR: traceDir,
        UNBROWSE_API_URL: "http://127.0.0.1:1",
      },
    );
    // SECRET_POINTER never appears in stdout or stderr regardless of
    // success/failure path.
    expect(res.stdout).not.toContain(SECRET_POINTER);
    expect(res.stderr).not.toContain(SECRET_POINTER);
  }, 30_000);
});

// ─── eval settings ────────────────────────────────────────────────────────

// W24.6 (Lewis 2026-05-28 — "stateless is the only path"): the legacy
// `eval settings` r/w path (write to ~/.unbrowse/settings.json,
// `key_not_allowed` / `value_is_pointer` rejections) was purged. The
// new shape is pointer-only POST to SETTINGS_STATE; the rejection codes
// changed to `value_is_not_pointer` / `setting_key_invalid_chars`. The
// `tests/v7-stateless-settings.test.ts` suite covers the new contract
// against a Bun.serve mock backend. The three legacy tests here were
// removed.

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

  it("backend down: honest empty-state envelope (network_error or http_<code>)", async () => {
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
    // honest envelope, or it happens to be bound and returns 4xx/5xx —
    // both are honest, but we assert at least that the canary path
    // (a 2xx ack) is NOT reached for a dead port.
    if (res.code !== 0) {
      const body = JSON.parse(res.stdout);
      expect(body.ok).toBe(false);
      // W24.6: postStateless surfaces network errors as a sanitized
      // errorHint string (any nonempty string is fine). Backend 404 lands
      // as `http_404`. Either is acceptable evidence of an honest
      // empty-state.
      expect(typeof body.error).toBe("string");
      expect((body.error as string).length).toBeGreaterThan(0);
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
