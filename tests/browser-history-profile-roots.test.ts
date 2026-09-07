/**
 * Witness for the FIFTH hand-rolled browser-profile path.
 *
 * The Flatpak fix collapsed four cookie-discovery sites onto one resolver, but
 * `browser-history.ts` kept its own expression:
 *
 *   join(home, ".config", browser.macPath.toLowerCase())
 *
 * That is not merely sandbox-blind. On ANY Linux install it is the wrong path
 * for most of the browser list, because the macOS leaf lowercased is not the
 * Linux leaf: Chrome lives at `~/.config/google-chrome`, not `google/chrome`;
 * Edge at `microsoft-edge`, not `microsoft edge`; Brave keeps its capitals on a
 * case-sensitive filesystem. Of the eight browsers, only Vivaldi and Chromium
 * ever resolved — so `unbrowse://browser-history/recent` silently returned an
 * empty scan for Linux Chrome users, native or sandboxed, and reported
 * `source_browsers: []` as though the machine had no browsers on it.
 *
 * Both halves are asserted here, because fixing only the sandbox half would leave
 * native Linux Chrome just as invisible as it was before.
 *
 * NO MOCKS and NO real history: a synthetic HOME with synthetic sqlite fixtures,
 * driven in a subprocess because `os.homedir()` is fixed at process start — which
 * also guarantees this test can never read the developer's real browsing history.
 *
 * Run: bun test tests/browser-history-profile-roots.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHROMIUM_BROWSERS_HISTORY } from "../src/auth/browser-history.js";
import { resolveBrowserProfileRoots } from "../src/auth/browser-profile-roots.js";

const REPO = join(import.meta.dir, "..");

// Reserved-by-RFC-2606 fixture hosts — nothing on this machine can own them, so
// a passing assertion can never be a real visited domain leaking into output.
const NATIVE_HOST = "native-chrome-fixture.invalid";
const FLATPAK_HOST = "flatpak-chrome-fixture.invalid";

const CHROME_EPOCH_OFFSET_S = 11644473600;
const nowS = Math.floor(Date.now() / 1000);
const unixToChromeUs = (unixS: number): number => (unixS + CHROME_EPOCH_OFFSET_S) * 1_000_000;

const tempDirs: string[] = [];
function newHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Chromium `History` DB under `<userDataDir>/Default/History`. */
function buildHistoryDb(userDataDir: string, host: string): void {
  const profile = join(userDataDir, "Default");
  mkdirSync(profile, { recursive: true });
  const db = new Database(join(profile, "History"));
  db.run("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER, last_visit_time INTEGER)");
  db.run("INSERT INTO urls (url, visit_count, last_visit_time) VALUES (?, ?, ?)", [
    `https://${host}/some/path?q=secret`,
    7,
    unixToChromeUs(nowS - 3600),
  ]);
  db.close();
}

interface Report {
  domains: string[];
  source_browsers: string[];
}

function scanUnderHome(home: string): Report {
  const script = join(home, "probe.ts");
  writeFileSync(
    script,
    [
      `import { listRecentDomains } from ${JSON.stringify(join(REPO, "src/auth/browser-history.js"))};`,
      "const r = listRecentDomains({ sinceDaysAgo: 7 });",
      "console.log(JSON.stringify({",
      "  domains: r.domains.map((d) => d.etld_plus_one),",
      "  source_browsers: r.source_browsers,",
      "}));",
    ].join("\n"),
  );

  // HOME is the whole point: discovery must find the fixture, never this
  // machine's real profiles.
  const res = spawnSync("bun", ["run", script], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  const line = (res.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!line) throw new Error(`probe produced no JSON (status=${res.status}) stderr=${res.stderr?.slice(-2000)}`);
  return JSON.parse(line) as Report;
}

// ─── Windows: the leaf that macOS uses is NOT the leaf Windows uses ───────────
//
// This machine cannot run a real Windows probe, so this asserts the production
// target table through the resolver rather than an end-to-end scan. It is not
// tautological only because it imports the REAL CHROMIUM_BROWSERS_HISTORY — a
// test that re-declared the targets would assert its own copy and prove nothing.
describe("Chromium history discovery on Windows", () => {
  const LOCALAPPDATA = "C:\\Users\\u\\AppData\\Local";
  const winRootFor = (name: string): string | undefined => {
    const entry = CHROMIUM_BROWSERS_HISTORY.find((b) => b.name === name);
    if (!entry) throw new Error(`no such browser in the production table: ${name}`);
    return resolveBrowserProfileRoots(entry.target, {
      platform: "win32",
      home: "C:\\Users\\u",
      env: { LOCALAPPDATA },
    })[0];
  };

  test("Edge is under Microsoft\\Edge, not a single 'Microsoft Edge' segment", () => {
    // `%LOCALAPPDATA%/<macPath>/User Data` gave "Microsoft Edge/User Data",
    // a directory Edge has never used on Windows.
    expect(winRootFor("Edge")).toBe(`${LOCALAPPDATA}/Microsoft/Edge/User Data`);
  });

  test("Arc and Dia do not double their 'User Data' segment", () => {
    // Their macOS leaf already ends in "User Data", so the shared win32 branch
    // appended a second one.
    expect(winRootFor("Arc")).toBe(`${LOCALAPPDATA}/Arc/User Data`);
    expect(winRootFor("Dia")).toBe(`${LOCALAPPDATA}/Dia/User Data`);
  });

  test("browsers whose macOS leaf IS the Windows leaf are untouched", () => {
    // The vacuity guard for this block: if winPath were applied indiscriminately
    // these would break, so they prove the fix is targeted rather than blanket.
    expect(winRootFor("Chrome")).toBe(`${LOCALAPPDATA}/Google/Chrome/User Data`);
    expect(winRootFor("Brave")).toBe(`${LOCALAPPDATA}/BraveSoftware/Brave-Browser/User Data`);
  });
});

describe("Chromium history discovery on Linux", () => {
  test("a NATIVE ~/.config/google-chrome profile is found", () => {
    // Was `~/.config/google/chrome` — a directory Chrome has never used.
    const home = newHome("unb-hist-native-");
    buildHistoryDb(join(home, ".config", "google-chrome"), NATIVE_HOST);

    const report = scanUnderHome(home);
    expect(report.source_browsers).toContain("Chrome");
    expect(report.domains).toContain(NATIVE_HOST);
  }, 60_000);

  test("a FLATPAK Chrome profile is found", () => {
    const home = newHome("unb-hist-flatpak-");
    buildHistoryDb(
      join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome"),
      FLATPAK_HOST,
    );

    const report = scanUnderHome(home);
    expect(report.source_browsers).toContain("Chrome");
    expect(report.domains).toContain(FLATPAK_HOST);
  }, 60_000);

  test("a machine with no browser profiles reports nothing", () => {
    // The vacuity guard in reverse: proves the assertions above are detecting the
    // fixture rather than something ambient on the developer's machine.
    const report = scanUnderHome(newHome("unb-hist-empty-"));
    expect(report.source_browsers).toEqual([]);
    expect(report.domains).toEqual([]);
  }, 60_000);

  test("the scan stays redacted — no path or query survives", () => {
    const home = newHome("unb-hist-redact-");
    buildHistoryDb(join(home, ".config", "google-chrome"), NATIVE_HOST);

    const report = scanUnderHome(home);
    expect(report.domains).toContain(NATIVE_HOST);
    for (const d of report.domains) {
      expect(d).not.toContain("/");
      expect(d).not.toContain("secret");
    }
  }, 60_000);
});
