/**
 * W21 — v7 CLI tests for `eval auth-inventory`.
 *
 * Always-wrap rule (Num 13:18 — "See what the land is..."): this test
 * harness IS the scouting that proves the scouting primitive doesn't
 * leak. The canary string `UNB7-COOKIE-VALUE-CANARY-DO-NOT-LEAK` is
 * planted in the `value` column of a synthetic Chrome-shaped sqlite
 * and assertion is global: it must NOT appear anywhere in stdout,
 * stderr, JSON, or any composed AST row.
 *
 * NO MOCKS. Synthetic SQLite files are built with bun:sqlite, real
 * fs paths, real CLI subprocess.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeInventory,
  runInventory,
  topN,
  type AuthInventory,
} from "../src/cli-v7/eval/auth-inventory.js";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");
const CANARY = "UNB7-COOKIE-VALUE-CANARY-DO-NOT-LEAK";

// Chrome stores times as microseconds since 1601-01-01.
const CHROME_EPOCH_OFFSET_S = 11644473600;
function unixSecondsToChromeUs(unixS: number): number {
  return (unixS + CHROME_EPOCH_OFFSET_S) * 1_000_000;
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

/**
 * Build a Chrome-shaped Cookies sqlite at `path` with the given cookie rows.
 * IMPORTANT: includes the `value` and `encrypted_value` columns so we can
 * prove the handler refuses to read them (canary test).
 */
function buildChromeCookieDb(
  path: string,
  rows: Array<{
    host_key: string;
    name: string;
    value: string;
    expires_unix: number;
    is_httponly?: number;
    is_secure?: number;
  }>,
): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL,
      host_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB DEFAULT '',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL
    )
  `);
  const ins = db.prepare(
    "INSERT INTO cookies (creation_utc, host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) {
    ins.run(
      unixSecondsToChromeUs(Math.floor(Date.now() / 1000)),
      r.host_key,
      r.name,
      r.value,
      Buffer.from(`encrypted::${r.value}`), // also contains canary if planted
      "/",
      unixSecondsToChromeUs(r.expires_unix),
      r.is_secure ?? 0,
      r.is_httponly ?? 0,
    );
  }
  db.close();
}

/** Build a Chrome-shaped History sqlite. */
function buildChromeHistoryDb(
  path: string,
  rows: Array<{ url: string; visit_count: number; last_visit_unix: number }>,
): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE urls (
      id INTEGER PRIMARY KEY,
      url TEXT,
      title TEXT,
      visit_count INTEGER DEFAULT 0,
      typed_count INTEGER DEFAULT 0,
      last_visit_time INTEGER DEFAULT 0,
      hidden INTEGER DEFAULT 0
    )
  `);
  const ins = db.prepare(
    "INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, ?, ?)",
  );
  let i = 0;
  for (const r of rows) {
    ins.run(r.url, `title-${i++}`, r.visit_count, unixSecondsToChromeUs(r.last_visit_unix));
  }
  db.close();
}

/** Build a Chrome-shaped Bookmarks JSON file. */
function buildChromeBookmarksJson(
  path: string,
  urls: string[],
): void {
  const json = {
    roots: {
      bookmark_bar: {
        children: urls.map((u, i) => ({ type: "url", name: `bm-${i}`, url: u })),
        type: "folder",
      },
      other: { children: [], type: "folder" },
      synced: { children: [], type: "folder" },
    },
  };
  writeFileSync(path, JSON.stringify(json));
}

/** Build a Firefox-shaped cookies.sqlite. */
function buildFirefoxCookiesDb(
  path: string,
  rows: Array<{ host: string; name: string; value: string; expiry_unix: number }>,
): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE moz_cookies (
      id INTEGER PRIMARY KEY,
      host TEXT,
      name TEXT,
      value TEXT,
      path TEXT,
      expiry INTEGER,
      isSecure INTEGER,
      isHttpOnly INTEGER
    )
  `);
  const ins = db.prepare(
    "INSERT INTO moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) {
    ins.run(r.host, r.name, r.value, "/", r.expiry_unix, 0, 0);
  }
  db.close();
}

/** Build a Firefox-shaped places.sqlite with history + bookmarks. */
function buildFirefoxPlacesDb(
  path: string,
  history: Array<{ url: string; visit_count: number; last_visit_unix: number }>,
  bookmarks: string[],
): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE moz_places (
      id INTEGER PRIMARY KEY,
      url TEXT,
      title TEXT,
      visit_count INTEGER DEFAULT 0,
      last_visit_date INTEGER
    )
  `);
  db.run(`
    CREATE TABLE moz_bookmarks (
      id INTEGER PRIMARY KEY,
      type INTEGER,
      fk INTEGER,
      title TEXT
    )
  `);
  const insPlace = db.prepare(
    "INSERT INTO moz_places (url, title, visit_count, last_visit_date) VALUES (?, ?, ?, ?)",
  );
  for (const h of history) {
    insPlace.run(h.url, "t", h.visit_count, h.last_visit_unix * 1_000_000);
  }
  const insBm = db.prepare(
    "INSERT INTO moz_bookmarks (type, fk, title) VALUES (?, ?, ?)",
  );
  for (const url of bookmarks) {
    // create a synthetic place + bookmark row pointing at it
    insPlace.run(url, "bm", 0, null);
    const id = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
    insBm.run(1, id?.id ?? 0, "bm");
  }
  db.close();
}

// ─── 1. CANARY: cookie `value` never leaks ─────────────────────────────────

describe("v7-cli eval auth-inventory — canary: cookie values never leak", () => {
  let profileDir: string;

  beforeAll(() => {
    profileDir = mkdtempSync(join(tmpdir(), "unb7-test-canary-"));
    // Cookie value contains the canary string.
    buildChromeCookieDb(join(profileDir, "Cookies"), [
      {
        host_key: ".github.com",
        name: "user_session",
        value: CANARY,
        expires_unix: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      },
    ]);
    buildChromeHistoryDb(join(profileDir, "History"), [
      { url: "https://github.com/lekt9/repo", visit_count: 100, last_visit_unix: Math.floor(Date.now() / 1000) },
    ]);
    buildChromeBookmarksJson(join(profileDir, "Bookmarks"), [
      "https://github.com/",
    ]);
  });

  afterAll(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("CLI --json output never contains the canary", async () => {
    const res = await runCli([
      "eval",
      "auth-inventory",
      "--chrome-profile",
      profileDir,
      "--firefox-profile",
      "/nonexistent",
    ]);
    expect(res.stdout).not.toContain(CANARY);
    expect(res.stderr).not.toContain(CANARY);
    expect(res.code).toBe(0);
    // Sanity: but the domain IS surfaced.
    expect(res.stdout).toContain("github.com");
    expect(res.stdout).toContain("user_session");
  });

  it("runInventory programmatic output never contains the canary", async () => {
    const result = await runInventory({
      chromeProfileOverride: profileDir,
      firefoxProfileOverride: "/nonexistent",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CANARY);
    // And the domain DID land.
    expect(result.inventory["github.com"]).toBeDefined();
    expect(result.inventory["github.com"]?.cookie_names).toContain("user_session");
  });
});

// ─── 2 & 3. Likely-logged-in heuristic ─────────────────────────────────────

describe("v7-cli eval auth-inventory — likely_logged_in_score heuristic", () => {
  it("auth-shaped cookie name + fresh expiry → score ≥ 0.6", () => {
    const now = 1_700_000_000;
    const inv = composeInventory({
      cookies: [
        {
          host_key: "example.com",
          name: "session",
          expires_utc_unix: now + 365 * 24 * 3600,
        },
      ],
      history: [],
      bookmarks: [],
      nowUnix: now,
    });
    expect(inv["example.com"]?.likely_logged_in_score).toBeGreaterThanOrEqual(0.6);
    expect(inv["example.com"]?.fresh_cookie).toBe(true);
  });

  it("non-auth-shaped cookie only → score < 0.3", () => {
    const now = 1_700_000_000;
    const inv = composeInventory({
      cookies: [
        {
          host_key: "example.com",
          name: "_ga", // analytics pref, doesn't match auth regex
          expires_utc_unix: now + 365 * 24 * 3600,
        },
      ],
      history: [],
      bookmarks: [],
      nowUnix: now,
    });
    expect(inv["example.com"]?.likely_logged_in_score).toBeLessThan(0.3);
    expect(inv["example.com"]?.fresh_cookie).toBe(false);
  });
});

// ─── 4. Lock handling ──────────────────────────────────────────────────────

describe("v7-cli eval auth-inventory — lock handling never throws", () => {
  let profileDir: string;

  beforeAll(() => {
    profileDir = mkdtempSync(join(tmpdir(), "unb7-test-lock-"));
    // Build the cookies db, then open it exclusively to simulate the
    // Chrome-running lock state.
    buildChromeCookieDb(join(profileDir, "Cookies"), [
      {
        host_key: ".locked.com",
        name: "session",
        value: "irrelevant",
        expires_unix: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      },
    ]);
  });

  afterAll(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("returns a result (success via immutable=1, copy-fallback, or per-source locked) — never throws", async () => {
    // Even with an open exclusive writer, the handler must not throw.
    // We don't actually need to hold a writer here because bun:sqlite
    // doesn't enforce process-level exclusive locks the same way Chrome
    // does; the immutable=1 path will succeed. The point of this test
    // is to assert the no-throw contract, not the exact branch taken.
    const result = await runInventory({
      chromeProfileOverride: profileDir,
      firefoxProfileOverride: "/nonexistent",
    });
    // Either the domain landed (immutable=1 or copy worked), OR the
    // source is in locked_sources. NEVER an unhandled throw.
    const hasDomain = !!result.inventory["locked.com"];
    const wasLocked = result.locked_sources.some((s) => s.includes("Cookies"));
    expect(hasDomain || wasLocked).toBe(true);
  });
});

// ─── 5. Hostname-only for history ──────────────────────────────────────────

describe("v7-cli eval auth-inventory — history URL paths never leak", () => {
  let profileDir: string;
  const PATH_SECRET = "PATHSECRET-TOKEN-123-LEAKED";

  beforeAll(() => {
    profileDir = mkdtempSync(join(tmpdir(), "unb7-test-pathsecret-"));
    buildChromeHistoryDb(join(profileDir, "History"), [
      {
        url: `https://github.com/owner/repo?token=${PATH_SECRET}`,
        visit_count: 100,
        last_visit_unix: Math.floor(Date.now() / 1000),
      },
    ]);
  });

  afterAll(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("path-embedded secret never reaches the AST", async () => {
    const result = await runInventory({
      chromeProfileOverride: profileDir,
      firefoxProfileOverride: "/nonexistent",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PATH_SECRET);
    expect(serialized).not.toContain("/owner/repo");
    expect(result.inventory["github.com"]).toBeDefined();
  });
});

// ─── 6. Hostname-only for bookmarks ────────────────────────────────────────

describe("v7-cli eval auth-inventory — bookmark URL paths never leak", () => {
  let profileDir: string;
  const BM_SECRET = "BOOKMARK-APIKEY-LEAKAGE-456";

  beforeAll(() => {
    profileDir = mkdtempSync(join(tmpdir(), "unb7-test-bmsecret-"));
    buildChromeBookmarksJson(join(profileDir, "Bookmarks"), [
      `https://app.com/page?api_key=${BM_SECRET}`,
    ]);
  });

  afterAll(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("bookmark query-string secret never reaches the AST", async () => {
    const result = await runInventory({
      chromeProfileOverride: profileDir,
      firefoxProfileOverride: "/nonexistent",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(BM_SECRET);
    expect(serialized).not.toContain("api_key");
    expect(result.inventory["app.com"]).toBeDefined();
    expect(result.inventory["app.com"]?.bookmarked).toBe(true);
  });
});

// ─── 7. Platform skip on windows ───────────────────────────────────────────

describe("v7-cli eval auth-inventory — platform skip", () => {
  it("on darwin/linux: emits supported=true; on windows: honest skip", async () => {
    // We can't actually flip process.platform mid-run, but we CAN assert
    // the CLI emits one of the two shapes.
    const res = await runCli([
      "eval",
      "auth-inventory",
      "--chrome-profile",
      "/nonexistent-zzz",
      "--firefox-profile",
      "/nonexistent-zzz",
    ]);
    expect(res.code).toBe(0);
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(res.stdout).toContain('"supported":true');
    } else {
      expect(res.stdout).toContain('"supported":false');
      expect(res.stdout).toContain("skipped_reason");
    }
  });
});

// ─── 8. Top-N limit ────────────────────────────────────────────────────────

describe("v7-cli eval auth-inventory — top-N limit", () => {
  it("topN returns ≤ N entries sorted by score desc", () => {
    const now = 1_700_000_000;
    // 5 domains, varied scores.
    const inv: AuthInventory = composeInventory({
      cookies: [
        { host_key: "a.com", name: "session", expires_utc_unix: now + 365 * 86400 },
        { host_key: "b.com", name: "session", expires_utc_unix: now + 365 * 86400 },
        { host_key: "c.com", name: "pref", expires_utc_unix: now + 365 * 86400 },
      ],
      history: [
        { hostname: "a.com", visit_count: 100, last_visit_unix: now - 86400 },
        { hostname: "d.com", visit_count: 200, last_visit_unix: now - 86400 },
      ],
      bookmarks: [{ hostname: "a.com" }, { hostname: "e.com" }],
      nowUnix: now,
    });
    expect(Object.keys(inv).length).toBe(5);
    const trimmed = topN(inv, 2);
    expect(Object.keys(trimmed).length).toBe(2);
    // a.com has the highest score (fresh auth cookie + visits + bookmark).
    const sortedKeys = Object.keys(trimmed);
    expect(sortedKeys[0]).toBe("a.com");
  });
});

// ─── 9. CLI --limit flag end-to-end ────────────────────────────────────────

describe("v7-cli eval auth-inventory — --limit flag end-to-end", () => {
  let profileDir: string;

  beforeAll(() => {
    profileDir = mkdtempSync(join(tmpdir(), "unb7-test-limit-"));
    // 3 distinct domains in history.
    buildChromeHistoryDb(join(profileDir, "History"), [
      { url: "https://a.com/", visit_count: 100, last_visit_unix: Math.floor(Date.now() / 1000) },
      { url: "https://b.com/", visit_count: 100, last_visit_unix: Math.floor(Date.now() / 1000) },
      { url: "https://c.com/", visit_count: 100, last_visit_unix: Math.floor(Date.now() / 1000) },
    ]);
  });

  afterAll(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("--limit=1 returns at most 1 domain", async () => {
    const res = await runCli([
      "eval",
      "auth-inventory",
      "--limit",
      "1",
      "--chrome-profile",
      profileDir,
      "--firefox-profile",
      "/nonexistent",
    ]);
    expect(res.code).toBe(0);
    // Parse JSON envelope. The emit() helper wraps in {ok, ...}.
    const m = res.stdout.match(/\{[\s\S]+\}/);
    expect(m).toBeTruthy();
    const parsed = JSON.parse(m![0]);
    expect(parsed.domain_count).toBeLessThanOrEqual(1);
  });
});

// ─── 10. Firefox path ─────────────────────────────────────────────────────

describe("v7-cli eval auth-inventory — firefox source", () => {
  let profileDir: string;
  const FF_CANARY = "FIREFOX-COOKIE-VALUE-CANARY-DO-NOT-LEAK";

  beforeAll(() => {
    profileDir = mkdtempSync(join(tmpdir(), "unb7-test-ff-"));
    buildFirefoxCookiesDb(join(profileDir, "cookies.sqlite"), [
      {
        host: ".gitlab.com",
        name: "_gitlab_session",
        value: FF_CANARY,
        expiry_unix: Math.floor(Date.now() / 1000) + 365 * 86400,
      },
    ]);
    buildFirefoxPlacesDb(
      join(profileDir, "places.sqlite"),
      [{ url: "https://gitlab.com/me", visit_count: 80, last_visit_unix: Math.floor(Date.now() / 1000) }],
      ["https://gitlab.com/"],
    );
  });

  afterAll(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("firefox profile contributes to inventory without leaking the value", async () => {
    const result = await runInventory({
      chromeProfileOverride: "/nonexistent",
      firefoxProfileOverride: profileDir,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FF_CANARY);
    expect(result.inventory["gitlab.com"]).toBeDefined();
    expect(result.inventory["gitlab.com"]?.has_cookie).toBe(true);
    expect(result.inventory["gitlab.com"]?.fresh_cookie).toBe(true);
    expect(result.inventory["gitlab.com"]?.bookmarked).toBe(true);
  });
});
