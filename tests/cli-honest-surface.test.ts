/**
 * The CLI must not tell the user things that are not true.
 *
 * Two defects, one theme:
 *
 *  1. `--no-browser-cookies` was parsed (src/cli.ts parseArgs), advertised in
 *     `--help`, and consumed by exactly ONE command (`fetch`). The two guards
 *     that actually decide whether the user's real browser session gets attached
 *     read only `UNBROWSE_IMPORT_BROWSER_COOKIES`, and nothing in src/ ever set
 *     it — so on `get`, the recommended one-call path, an explicit opt-out was
 *     silently ignored. A credential control that fails OPEN.
 *
 *  2. A capture failure was reported by its coarse routing code alone
 *     (`capture_failed`), and a speculative sentence — "site may need
 *     authentication or different intent" — was appended purely because
 *     `endpoints.length === 0`. With UNBROWSE_KURI_BIN pointing at a missing
 *     binary the CLI printed `capture_failed`, and the real sentence
 *     "Kuri binary not found at … (from UNBROWSE_KURI_BIN)" appeared on neither
 *     stdout nor stderr.
 *
 * Everything here is offline and deterministic: one loopback fixture origin, a
 * synthetic $HOME with a synthetic Firefox cookie jar, and a kuri binary path
 * that is guaranteed not to exist. No live site is contacted.
 *
 * Child processes are the only way to move the browser-profile readers off the
 * real machine — bun resolves `os.homedir()` once per process, so HOME has to be
 * set at SPAWN time. `Bun.spawn` (async), never `spawnSync`: spawnSync blocks
 * this event loop, the in-process fixture origin would never answer, and every
 * "no cookie was sent" assertion would pass on a request that never happened.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCaptureEnvelope, oneHoleTerminalExitCode, redactReflectedSecrets } from "../src/cli.js";
import { describeCaptureFailure } from "../src/execution/index.js";

const REPO_ROOT = join(import.meta.dir, "..");

/** Synthetic. Never a real cookie value, and never read from a real profile. */
const SYNTHETIC_COOKIE_NAME = "synthetic_session_probe";
const SYNTHETIC_COOKIE_VALUE = "SYNTHETIC-COOKIE-VALUE-NOT-REAL";

/** A path that cannot exist, so `requireKuriBinary` throws its honest error. */
const MISSING_KURI = "/nonexistent/kuri-that-does-not-exist";

test("direct authorized responses redact reflected header, bearer, and cookie values", () => {
  const headerSecret = "opaque-header-secret";
  const bearerSecret = "opaque-bearer-secret";
  const cookieSecret = "opaque-cookie-secret";
  const reflected = JSON.stringify({
    headers: { "x-api-key": headerSecret, authorization: `Bearer ${bearerSecret}` },
    cookie: `sid=${cookieSecret}`,
    useful: "response metadata survives",
  });
  const redacted = redactReflectedSecrets(reflected, [headerSecret, bearerSecret, cookieSecret]);
  expect(redacted).not.toContain(headerSecret);
  expect(redacted).not.toContain(bearerSecret);
  expect(redacted).not.toContain(cookieSecret);
  expect(redacted).toContain("response metadata survives");
  expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(3);
});

test("one-hole terminal envelopes map failures to a nonzero shell status", () => {
  expect(oneHoleTerminalExitCode({ trace: { success: false }, error: "no_relevant_route" })).toBe(1);
  expect(oneHoleTerminalExitCode({ trace: { success: false }, error: "endpoint_not_found" })).toBe(1);
  expect(oneHoleTerminalExitCode({ ok: false, blocker: "auth_required" })).toBe(1);
  expect(oneHoleTerminalExitCode({ ok: true, trace: { success: true }, result: { items: [1] } })).toBe(0);
});

interface Observed {
  tag: string;
  cookie: string | null;
}

// ---------------------------------------------------------------------------
// Shared loopback fixture + synthetic browser profile
// ---------------------------------------------------------------------------

let home = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let origin = "";
const observed: Observed[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "unbrowse-honest-"));

  // Firefox is the plaintext-SQLite path the cookie harvester tries first, so
  // no keychain and no decryption is involved and the fixture stays hermetic.
  const profile = join(home, ".mozilla", "firefox", "aaaaaaaa.default-release");
  mkdirSync(profile, { recursive: true });
  const db = new Database(join(profile, "cookies.sqlite"), { create: true });
  db.run(
    "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT, "
      + "isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, expiry INTEGER)",
  );
  db.run(
    "INSERT INTO moz_cookies (name, value, host, path, isSecure, isHttpOnly, sameSite, expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [SYNTHETIC_COOKIE_NAME, SYNTHETIC_COOKIE_VALUE, "127.0.0.1", "/", 0, 1, 1, 4_102_444_800],
  );
  db.close();

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      observed.push({ tag: url.searchParams.get("run") ?? "untagged", cookie: req.headers.get("cookie") });
      const body = Array.from(
        { length: 120 },
        (_, i) => `<p>Fixture paragraph ${i}: this loopback origin serves a plain document for the honest-surface tests.</p>`,
      ).join("");
      return new Response(
        `<!doctype html><html><head><title>Honest surface fixture</title></head><body><main><h1>Fixture</h1>${body}</main></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
});

/**
 * Child env. HOME must be set at spawn. UNBROWSE_URL is DELETED so the CLI uses
 * its in-process runtime instead of talking to whatever daemon the developer
 * happens to have running; UNBROWSE_UPDATE_COMMAND is neutered because an HTTP
 * 426 otherwise triggers the self-update path.
 */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
  env.UNBROWSE_UPDATE_COMMAND = "exit 1";
  env.UNBROWSE_NON_INTERACTIVE = "1";
  delete env.UNBROWSE_URL;
  // Never inherit an ambient opt-out: this suite must observe the FLAG doing
  // the work, not an env var the developer's shell already exported.
  delete env.UNBROWSE_IMPORT_BROWSER_COOKIES;
  return { ...env, ...extra };
}

async function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    env: childEnv(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(9), 150_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function seen(tag: string): Observed[] {
  return observed.filter((o) => o.tag === tag);
}

/** Last JSON object printed on stdout — the CLI's payload line. */
function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Defect 1 — the credential opt-out must actually reach the guard
// ---------------------------------------------------------------------------

describe("--no-browser-cookies suppresses the browser session on the one-call path", () => {
  test(
    "VACUITY GUARD: without the flag this exact fixture DOES receive the synthetic cookie",
    async () => {
      const tag = "get-no-flag";
      const { code } = await runCli(["get", "read the page", "--url", `${origin}/page?run=${tag}`]);
      expect(code).toBe(0);

      const reqs = seen(tag);
      // The request must have HAPPENED — otherwise "no cookie" below is vacuous.
      expect(reqs.length).toBeGreaterThan(0);
      expect(reqs.some((r) => (r.cookie ?? "").includes(SYNTHETIC_COOKIE_NAME))).toBe(true);
      expect(reqs.some((r) => (r.cookie ?? "").includes(SYNTHETIC_COOKIE_VALUE))).toBe(true);
    },
    150_000,
  );

  test(
    "with the flag, NO request carries a cookie — and the request still happened",
    async () => {
      const tag = "get-with-flag";
      const { code } = await runCli([
        "get",
        "read the page",
        "--url",
        `${origin}/page?run=${tag}`,
        "--no-browser-cookies",
      ]);
      expect(code).toBe(0);

      const reqs = seen(tag);
      expect(reqs.length).toBeGreaterThan(0);
      for (const r of reqs) {
        expect(r.cookie ?? "").not.toContain(SYNTHETIC_COOKIE_NAME);
        expect(r.cookie ?? "").not.toContain(SYNTHETIC_COOKIE_VALUE);
      }
    },
    150_000,
  );

  test(
    "the flag bridges to the guard the runtime consults, so it is inheritable by children",
    async () => {
      // The bridge is observable, not just its effect: any child of the CLI run
      // (browser drivers, drain workers) must see the same refusal.
      const { code, stdout } = await runCli([
        "get",
        "read the page",
        "--url",
        `${origin}/page?run=guard-bridge`,
        "--no-browser-cookies",
      ]);
      expect(code).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
      const reqs = seen("guard-bridge");
      expect(reqs.length).toBeGreaterThan(0);
      for (const r of reqs) expect(r.cookie ?? "").not.toContain(SYNTHETIC_COOKIE_NAME);
    },
    150_000,
  );
});

// ---------------------------------------------------------------------------
// Defect 2 — a specific failure must survive to the caller
// ---------------------------------------------------------------------------

describe("describeCaptureFailure keeps the cause next to the routing code", () => {
  test("a specific error's text survives verbatim under the coarse code", () => {
    const real =
      "Kuri binary not found at /nonexistent (from UNBROWSE_KURI_BIN). "
      + "Point UNBROWSE_KURI_BIN at an existing kuri binary, or unset it to search standard paths:\n  - /nonexistent";
    const out = describeCaptureFailure(new Error(real));
    // The routing family stays stable — the orchestrator restarts Kuri on it.
    expect(out.error).toBe("capture_failed");
    // …but it is NOT the only thing the caller gets.
    expect(out.message).toBe(real);
    expect(out.message).toContain("Kuri binary not found");
  });

  test("the existing routing codes are unchanged, and still carry their message", () => {
    const conn = describeCaptureFailure(new Error("Unable to connect to Kuri at 127.0.0.1:8080"));
    expect(conn.error).toBe("connection_failed");
    expect(conn.message).toContain("Unable to connect");

    const slow = describeCaptureFailure(new Error("capture timed out after 45000ms"));
    expect(slow.error).toBe("capture_timeout");
    expect(slow.message).toContain("timed out");
  });

  test("a non-Error throw is described, not blanked", () => {
    const out = describeCaptureFailure({});
    expect(out.error).toBe("capture_failed");
    expect(out.message.trim().length).toBeGreaterThan(0);
    expect(out.message).not.toBe("[object Object]");
  });
});

describe("buildCaptureEnvelope reports the cause, and never guesses in its place", () => {
  const ctx = { url: "https://example.test/list", intent: "list items", ms: 12 };

  test("the real error message reaches the envelope instead of only the code", () => {
    const env = buildCaptureEnvelope(
      {
        endpoints: [],
        endpoints_discovered: 0,
        error: "capture_failed",
        error_message: "Kuri binary not found at /nonexistent (from UNBROWSE_KURI_BIN).",
      },
      ctx,
    );
    expect(env.error).toBe("capture_failed");
    expect(String(env.error_message)).toContain("Kuri binary not found");
    // The speculation must be gone, and the next step must point at the cause.
    expect(JSON.stringify(env)).not.toContain("may need authentication");
    expect(String(env.next_step)).toContain("error_message");
  });

  test("the in-process shape (`message`) is honoured too, not just the HTTP rename", () => {
    const env = buildCaptureEnvelope(
      { endpoints: [], error: "connection_failed", message: "Unable to connect to Kuri at 127.0.0.1:8080" },
      ctx,
    );
    expect(String(env.error_message)).toContain("Unable to connect");
  });

  test("zero endpoints with no error does NOT assert an auth wall", () => {
    const env = buildCaptureEnvelope({ endpoints: [], endpoints_discovered: 0 }, ctx);
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain("may need authentication");
    expect(serialized).not.toContain("authentication");
    expect(env.possible_cause).toBeUndefined();
    // Still actionable, and still matches the documented "no endpoints" shape.
    expect(String(env.next_step)).toContain("no endpoints");
  });

  test("an auth hint appears only on real evidence, is marked a guess, and never displaces the error", () => {
    const env = buildCaptureEnvelope(
      {
        endpoints: [],
        error: "capture_failed",
        error_message: "captured 0 XHRs after login redirect",
        auth_recommended: true,
        auth_hint: "login redirect to accounts.example.test observed",
      },
      ctx,
    );
    expect(String(env.possible_cause)).toContain("unverified guess");
    expect(String(env.possible_cause)).toContain("login redirect");
    // The actual error is still the headline.
    expect(env.error).toBe("capture_failed");
    expect(String(env.error_message)).toContain("captured 0 XHRs");
    expect(String(env.next_step)).toContain("capture failed");
  });

  test("a successful capture's next_step is untouched", () => {
    const env = buildCaptureEnvelope(
      { endpoints: [{ endpoint_id: "e1", method: "GET", url_template: "https://example.test/api/items" }], skill_id: "skill-1" },
      ctx,
    );
    expect(String(env.next_step)).toContain("unbrowse resolve");
    expect(env.error).toBeUndefined();
    expect(env.error_message).toBeUndefined();
  });
});

describe("end-to-end: a missing Kuri binary is never laundered into an auth claim", () => {
  test(
    "`unbrowse capture` reports either runtime unavailability or the factual HTTP fallback result",
    async () => {
      const tag = "capture-missing-kuri";
      expect(existsSync(MISSING_KURI)).toBe(false);

      const { code, stdout, stderr } = await runCli(
        ["capture", "--url", `${origin}/page?run=${tag}`, "--intent", "list items"],
        { UNBROWSE_KURI_BIN: MISSING_KURI },
      );
      expect(code).toBe(0);

      const envelope = lastJson(stdout);
      // VACUITY GUARD: the failure must have actually occurred, or grepping for
      // its message below would be a green on a run that never errored.
      expect(envelope.error).toBeDefined();
      expect(envelope.endpoints_discovered).toBe(0);

      // Capture may still complete its HTTP fallback without Kuri. In that case
      // it must report only what the fallback observed, never invent an auth wall.
      const errorMessage = String(envelope.error_message);
      const reportedMissingRuntime = errorMessage.includes("Kuri binary not found")
        && errorMessage.includes("UNBROWSE_KURI_BIN");
      const reportedFallbackObservation = errorMessage.includes("No API endpoints or structured DOM data were observed");
      expect(reportedMissingRuntime || reportedFallbackObservation).toBe(true);

      // …and nothing invented an auth wall, on either stream.
      expect(stdout).not.toContain("may need authentication");
      expect(stderr).not.toContain("may need authentication");
    },
    150_000,
  );
});
