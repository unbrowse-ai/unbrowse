/**
 * Witness for the cleartext auth-extraction trace.
 *
 * `extractBrowserCookies` appended one JSONL line per extraction to
 * ~/.unbrowse/traces/auth-extract.jsonl containing `{n: name, v: value, d: domain}`
 * for EVERY cookie it returned — i.e. every live session credential in the user's
 * browser, in cleartext, to a file that:
 *   - nothing in this repo ever reads,
 *   - nothing ever rotates or bounds,
 *   - no environment variable ever gated,
 *   - and which failed silently, being wrapped in `try {} catch {}`.
 *
 * It looked harmless only because extraction had been returning zero cookies on
 * Linux since the profile-discovery bug: on this machine the file held 69 entries
 * and zero recorded cookies. Fixing profile discovery is precisely what ARMS this
 * leak, so the two must land together — that is why this gate exists.
 *
 * The vacuity guard is the load-bearing part. "No cookie value appears in the
 * trace" is trivially true when no cookie was extracted, which is exactly the
 * broken state the leak hid behind. So the first assertion proves the fixture
 * cookie really WAS extracted, and the trace entry really did record n >= 1,
 * before any absence is claimed to mean anything.
 *
 * NO MOCKS and NO real profiles: a synthetic HOME with a Flatpak-shaped Firefox
 * profile and a synthetic sqlite fixture. Probes run in a subprocess because both
 * `os.homedir()` and the UNBROWSE_TRACE_AUTH gate are read at module load — env
 * has to be set on spawn, which also guarantees this test can never read the
 * developer's real cookie jar.
 *
 * Run: bun test tests/auth-extract-trace-no-secrets.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

// Reserved-by-RFC-2606 fixture host. Nothing on this machine can own it, so a
// passing assertion can never be a real domain leaking into the output.
const FIXTURE_DOMAIN = "auth-trace-fixture.invalid";

// Distinctive enough that a substring search for it cannot collide with base64
// noise, a timestamp, or the domain itself.
const SENTINEL_NAME = "sentinel_session_name_9f31";
const SENTINEL_VALUE = "SENTINEL-COOKIE-VALUE-b7c2f19e4a5d-DO-NOT-PERSIST";

const nowS = Math.floor(Date.now() / 1000);

const tempDirs: string[] = [];
function newTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function buildFirefoxProfile(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true });
  const db = new Database(join(profileDir, "cookies.sqlite"));
  // `sameSite` is part of the real SELECT — omit it and the query throws into a
  // swallowed catch, extraction returns [], and this whole gate goes vacuous.
  db.run(`
    CREATE TABLE moz_cookies (
      id INTEGER PRIMARY KEY,
      host TEXT, name TEXT, value TEXT, path TEXT,
      expiry INTEGER, lastAccessed INTEGER, isSecure INTEGER, isHttpOnly INTEGER,
      sameSite INTEGER
    )
  `);
  db.run(
    "INSERT INTO moz_cookies (host, name, value, path, expiry, lastAccessed, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [FIXTURE_DOMAIN, SENTINEL_NAME, SENTINEL_VALUE, "/", nowS + 365 * 86400, nowS * 1_000_000, 1, 1, 1],
  );
  db.close();
}

interface Probe {
  n: number;
  found: boolean;
}

/** Run one extraction in a subprocess under a synthetic HOME + UNBROWSE_HOME. */
function runProbe(home: string, unbrowseHome: string, traceAuth: string | null): Probe {
  const script = join(home, "probe.ts");
  writeFileSync(
    script,
    [
      `import { extractBrowserCookies } from ${JSON.stringify(join(REPO, "src/auth/browser-cookies.js"))};`,
      `const r = extractBrowserCookies(${JSON.stringify(FIXTURE_DOMAIN)});`,
      `console.log(JSON.stringify({`,
      `  n: r.cookies.length,`,
      `  found: r.cookies.some((c) => c.value === ${JSON.stringify(SENTINEL_VALUE)}),`,
      `}));`,
    ].join("\n"),
  );

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.HOME = home;
  env.UNBROWSE_HOME = unbrowseHome;
  delete env.UNBROWSE_TRACE_AUTH;
  if (traceAuth !== null) env.UNBROWSE_TRACE_AUTH = traceAuth;

  const res = spawnSync("bun", ["run", script], { env, encoding: "utf8" });
  const line = (res.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!line) {
    throw new Error(`probe produced no JSON (status=${res.status}) stderr=${res.stderr}`);
  }
  return JSON.parse(line) as Probe;
}

const tracePath = (unbrowseHome: string) => join(unbrowseHome, "traces", "auth-extract.jsonl");

// ─── 1. Vacuity guard: the extraction under test really does return the cookie ──

describe("the fixture extraction actually works", () => {
  let probe: Probe;
  let unbrowseHome: string;

  beforeAll(() => {
    const home = newTemp("unb-authtrace-live-");
    unbrowseHome = join(home, ".unbrowse");
    buildFirefoxProfile(
      join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox", "ab12cd34.default-release"),
    );
    probe = runProbe(home, unbrowseHome, "1");
  });

  // Without this, every "the secret is absent" assertion below is vacuously
  // true — absent because nothing was extracted, not because anything refused.
  test("the sentinel cookie is extracted from the synthetic profile", () => {
    expect(probe.n).toBeGreaterThan(0);
    expect(probe.found).toBe(true);
  });

  test("and the trace recorded that non-empty extraction", () => {
    const lines = readFileSync(tracePath(unbrowseHome), "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]!);
    expect(entry.n).toBeGreaterThan(0);
    expect(entry.d).toBe(FIXTURE_DOMAIN);
  });
});

// ─── 2. The refusal: no credential reaches the disk ────────────────────────────

describe("the auth-extract trace never contains cookie secrets", () => {
  let unbrowseHome: string;
  let raw: string;

  beforeAll(() => {
    const home = newTemp("unb-authtrace-secrets-");
    unbrowseHome = join(home, ".unbrowse");
    buildFirefoxProfile(
      join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox", "ab12cd34.default-release"),
    );
    runProbe(home, unbrowseHome, "1");
    raw = readFileSync(tracePath(unbrowseHome), "utf8");
  });

  test("the cookie VALUE never appears in the trace bytes", () => {
    expect(raw).not.toContain(SENTINEL_VALUE);
  });

  test("the cookie NAME never appears either", () => {
    // `session_id @ bank.example` is a credential's fingerprint, and a name plus
    // a domain is still browsing history. Same boundary telemetry.ts draws.
    expect(raw).not.toContain(SENTINEL_NAME);
  });

  test("the entry carries only counts and provenance", () => {
    const entry = JSON.parse(raw.trim().split("\n").pop()!);
    expect(Object.keys(entry).sort()).toEqual(["d", "n", "src", "t"]);
  });

  test("the trace file is not readable by other local users", () => {
    expect(statSync(tracePath(unbrowseHome)).mode & 0o077).toBe(0);
  });
});

// ─── 3. Off unless asked for, and bounded when it is ───────────────────────────

describe("collection is opt-in and bounded", () => {
  test("no trace file is created at all when UNBROWSE_TRACE_AUTH is unset", () => {
    const home = newTemp("unb-authtrace-default-");
    const unbrowseHome = join(home, ".unbrowse");
    buildFirefoxProfile(
      join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox", "ab12cd34.default-release"),
    );
    const probe = runProbe(home, unbrowseHome, null);

    // Extraction still works — it is the recording that is off, not the feature.
    expect(probe.found).toBe(true);
    expect(existsSync(tracePath(unbrowseHome))).toBe(false);
  });

  test("UNBROWSE_TRACE_AUTH=0 is off, not on", () => {
    const home = newTemp("unb-authtrace-zero-");
    const unbrowseHome = join(home, ".unbrowse");
    buildFirefoxProfile(
      join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox", "ab12cd34.default-release"),
    );
    runProbe(home, unbrowseHome, "0");
    expect(existsSync(tracePath(unbrowseHome))).toBe(false);
  });

  test("an oversized trace is truncated rather than appended to forever", () => {
    const home = newTemp("unb-authtrace-cap-");
    const unbrowseHome = join(home, ".unbrowse");
    buildFirefoxProfile(
      join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox", "ab12cd34.default-release"),
    );
    const file = tracePath(unbrowseHome);
    mkdirSync(join(unbrowseHome, "traces"), { recursive: true });
    writeFileSync(file, "x".repeat(2 * 1024 * 1024) + "\n");
    expect(statSync(file).size).toBeGreaterThan(1024 * 1024);

    runProbe(home, unbrowseHome, "1");

    const after = readFileSync(file, "utf8");
    expect(after.length).toBeLessThan(1024 * 1024);
    expect(after).not.toContain("xxxxxxxxxx");
    expect(after.trim().split("\n").length).toBe(1);
  });
});
