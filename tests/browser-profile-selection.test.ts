/**
 * Witness for the SEVENTH hand-rolled browser-profile path — the one INSIDE a root.
 *
 * Root discovery was collapsed onto `browser-profile-roots.ts`, but choosing a
 * profile *within* a root stayed hand-rolled in four places, each keyed on a
 * NAME: `name.includes("default-release")` for Firefox, `Default` for the
 * Chromium cookie jar, `["Default","Profile 1"]` for preferences and history.
 *
 * Firefox profile directories are named by the USER (`ij8zicoh.stream`), and a
 * signed-in Chromium user can be on `Profile 3`. On a real machine that made
 * cookie extraction read a DIFFERENT, logged-out jar and report "no session"
 * while the browser was logged in — the exact symptom that looked like broken
 * auto-detection. Adding the missing names cannot fix it: the set of profile
 * names is unbounded. A profile is now a candidate because it HOLDS the jar,
 * and the winner is the jar carrying auth-shaped cookies (`sessionQuality`),
 * which is the same scorer that already ranked jars across browsers.
 *
 * NO MOCKS: a synthetic HOME with real sqlite fixtures, driven in a subprocess
 * because `os.homedir()` is fixed at process start — which also guarantees this
 * test can never read the developer's real cookies.
 *
 * Run: bun test tests/browser-profile-selection.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listProfileArtifactsInRoot } from "../src/auth/browser-profile-roots.js";

const REPO = join(import.meta.dir, "..");

// Reserved-by-RFC-2606 fixture host — nothing on this machine can own it, so a
// passing assertion can never be a real cookie leaking into the output.
const HOST = "session-fixture.invalid";

const tempDirs: string[] = [];
function newHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A Firefox `cookies.sqlite` under `<root>/<profile>/`. `authShaped` decides
 * whether the jar looks like a real session (httpOnly+secure auth cookie) or
 * the guest jar a logged-out profile accumulates.
 */
function buildFirefoxJar(root: string, profile: string, authShaped: boolean): void {
  const dir = join(root, profile);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "cookies.sqlite"));
  db.run(
    "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, expiry INTEGER)",
  );
  const rows: Array<[string, string, number, number]> = authShaped
    ? [
        ["auth_token", "fixture-auth-value", 1, 1],
        ["ct0", "fixture-csrf-value", 1, 0],
        ["guest_id", "fixture-guest", 0, 0],
      ]
    : [
        ["guest_id", "fixture-guest", 0, 0],
        ["personalization_id", "fixture-pers", 0, 0],
      ];
  for (const [name, value, secure, httpOnly] of rows) {
    db.run(
      "INSERT INTO moz_cookies (name, value, host, path, isSecure, isHttpOnly, sameSite, expiry) VALUES (?, ?, ?, '/', ?, ?, 0, ?)",
      [name, value, `.${HOST}`, secure, httpOnly, Math.floor(Date.now() / 1000) + 86400],
    );
  }
  db.close();
}

interface Probe {
  source: string | null;
  names: string[];
}

function extractUnderHome(home: string): Probe {
  const script = join(home, "probe.ts");
  writeFileSync(
    script,
    [
      `import { extractFromFirefox } from ${JSON.stringify(join(REPO, "src/auth/browser-cookies.js"))};`,
      `const r = extractFromFirefox(${JSON.stringify(HOST)});`,
      "console.log(JSON.stringify({ source: r.source, names: r.cookies.map((c) => c.name) }));",
    ].join("\n"),
  );

  // HOME is the whole point: discovery must find the fixture, never this
  // machine's real profiles.
  const res = spawnSync("bun", ["run", script], {
    env: { ...process.env, HOME: home, UNBROWSE_HOME: join(home, ".unbrowse") },
    encoding: "utf8",
  });
  const line = (res.stdout ?? "")
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) {
    throw new Error(
      `probe produced no JSON (status=${res.status}) stderr=${res.stderr?.slice(-2000)}`,
    );
  }
  return JSON.parse(line) as Probe;
}

describe("Firefox profile selection is by evidence, not by name", () => {
  test("the logged-in profile wins even though its name matches no convention", () => {
    const home = newHome("unbrowse-profile-sel-");
    const root = join(home, ".mozilla", "firefox");
    // The guest jar carries the conventional name; the session lives in a
    // user-named profile — exactly the real machine that exposed this bug.
    buildFirefoxJar(root, "aaaa1111.default-release", false);
    buildFirefoxJar(root, "zzzz9999.stream", true);

    const probe = extractUnderHome(home);
    expect(probe.source).toBe('Firefox profile "zzzz9999.stream"');
    expect(probe.names).toContain("auth_token");
    expect(probe.names).toContain("ct0");
  });

  test("a lone conventional profile still resolves (no regression)", () => {
    // The vacuity guard: if selection merely inverted the old preference this
    // would break. The conventional name must still work when it is the only
    // profile — and when it is the one holding the session.
    const home = newHome("unbrowse-profile-sel-solo-");
    const root = join(home, ".mozilla", "firefox");
    buildFirefoxJar(root, "aaaa1111.default-release", true);

    const probe = extractUnderHome(home);
    expect(probe.source).toBe('Firefox profile "aaaa1111.default-release"');
    expect(probe.names).toContain("auth_token");
  });

  test("a Flatpak-only install is discovered the same way", () => {
    // Root discovery (Flatpak) and profile discovery must compose: this fixture
    // has NO native ~/.mozilla at all.
    const home = newHome("unbrowse-profile-sel-flatpak-");
    const root = join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox");
    buildFirefoxJar(root, "bbbb2222.default-release", false);
    buildFirefoxJar(root, "cccc3333.work", true);

    const probe = extractUnderHome(home);
    expect(probe.source).toBe('Firefox profile "cccc3333.work"');
    expect(probe.names).toContain("auth_token");
  });
});

describe("listProfileArtifactsInRoot", () => {
  // Pure: injected exists/readdir/mtime, so these assert the contract without
  // touching a filesystem at all.
  const root = "/fixture/root";
  const opts = (present: string[], mtimes: Record<string, number> = {}) => ({
    exists: (p: string) => present.includes(p),
    readdir: (dir: string) =>
      dir === root ? ["Default", "Profile 3", "Crash Reports"] : [],
    mtimeMs: (p: string) => mtimes[p] ?? 0,
  });

  test("finds a profile no name list would have named", () => {
    const jar = `${root}/Profile 3/Cookies`;
    const found = listProfileArtifactsInRoot(root, ["Network/Cookies", "Cookies"], opts([jar]));
    expect(found.map((a) => a.path)).toEqual([jar]);
    expect(found[0].profile).toBe("Profile 3");
  });

  test("orders by recency — the profile in use comes first", () => {
    const stale = `${root}/Default/Cookies`;
    const active = `${root}/Profile 3/Cookies`;
    const found = listProfileArtifactsInRoot(
      root,
      "Cookies",
      opts([stale, active], { [stale]: 1_000, [active]: 9_000 }),
    );
    expect(found.map((a) => a.path)).toEqual([active, stale]);
  });

  test("probes the root itself — some layouts hand us a profile dir", () => {
    const jar = `${root}/Cookies`;
    const found = listProfileArtifactsInRoot(root, "Cookies", opts([jar]));
    expect(found.map((a) => a.path)).toEqual([jar]);
    expect(found[0].profile).toBe("");
  });

  test("a directory without the artifact is not a candidate", () => {
    // "Crash Reports" is a real Chromium root entry and must never be offered
    // as a profile just because it is a directory.
    const found = listProfileArtifactsInRoot(root, "Cookies", opts([]));
    expect(found).toEqual([]);
  });
});
