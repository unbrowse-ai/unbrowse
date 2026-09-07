/**
 * Witness for the SIXTH — and worst — hand-rolled browser-profile path.
 *
 * `src/auth/browser-preferences.ts` had NO platform branch at all:
 *
 *   function userDataDirFor(macPath: string): string {
 *     return join(homedir(), "Library", "Application Support", macPath);
 *   }
 *
 * A macOS path, built unconditionally. So on Linux and on Windows
 * `pickMostRecentBrowser()` returned null for every browser in the list and the
 * entire preference signal — bookmarks (strong) AND recent history (weak) — was
 * not degraded but DEAD on two of three platforms, silently, with
 * `browserPreferences()` still returning a well-formed all-empty shape that
 * looks exactly like "this user has no browsers".
 *
 * Both halves are asserted separately and neither is redundant:
 *   - a NATIVE `~/.config/google-chrome` profile is found. Fixing only the
 *     sandbox half would leave every conventional Linux install just as dead,
 *     and the sibling `browser-history.ts` bug proves that is not hypothetical:
 *     its Linux branch was `~/.config/<macPath.toLowerCase()>`, i.e.
 *     `google/chrome`, a directory Chrome has never used.
 *   - a FLATPAK `~/.var/app/com.google.Chrome/config/google-chrome` profile is
 *     found — SteamOS, Silverblue, Bazzite ship browsers this way and nothing
 *     else on the machine looks there.
 * Plus: Brave's CAPITALS survive (`~/.config/BraveSoftware/Brave-Browser`), and
 * the winner is still chosen by History mtime, not by list order.
 *
 * NO MOCKS (`mock.module` is process-wide in bun and breaks unrelated files) and
 * NO real browser data: a synthetic HOME in a temp dir with synthetic sqlite +
 * Bookmarks fixtures, driven in a SUBPROCESS because `os.homedir()` is fixed at
 * process start — HOME has to be set on spawn, which is also what makes this
 * test structurally incapable of reading the developer's real profile. Every
 * fixture host is RFC-2606 `.invalid`, so a passing assertion can never be a
 * real visited or bookmarked domain.
 *
 * Run: bun test tests/browser-preferences-profile-roots.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

// RFC-2606 reserved — unresolvable, unownable, and therefore impossible to
// confuse with something the developer actually visited or bookmarked.
const NATIVE_HISTORY_HOST = "native-pref-history.invalid";
const NATIVE_BOOKMARK_HOST = "native-pref-bookmark.invalid";
const FLATPAK_HISTORY_HOST = "flatpak-pref-history.invalid";
const FLATPAK_BOOKMARK_HOST = "flatpak-pref-bookmark.invalid";
const BRAVE_BOOKMARK_HOST = "brave-pref-bookmark.invalid";
const CHROMIUM_BOOKMARK_HOST = "chromium-pref-bookmark.invalid";

/** Never surfaces: a bookmark title is exactly what the privacy contract forbids. */
const SECRET_TITLE = "SECRETBOOKMARKTITLE";

const CHROME_EPOCH_OFFSET_S = 11644473600;
const nowS = Math.floor(Date.now() / 1000);
const unixToChromeUs = (unixS: number): number => (unixS + CHROME_EPOCH_OFFSET_S) * 1_000_000;

const tempDirs: string[] = [];
function newHome(prefix: string): string {
  // realpath so the HOME we spawn with is byte-identical to what `os.homedir()`
  // hands back inside the child — the path assertions below compare exactly.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A Chromium `History` DB at `<userDataDir>/Default/History`.
 *
 * Every column the production SELECT names is created (`url`, `visit_count`,
 * `last_visit_time`). A missing column makes the query throw into a swallowed
 * `catch`, extraction returns empty, and the gate goes vacuously green.
 */
function buildHistoryDb(userDataDir: string, host: string, mtimeS?: number): void {
  const profile = join(userDataDir, "Default");
  mkdirSync(profile, { recursive: true });
  const dbPath = join(profile, "History");
  const db = new Database(dbPath);
  db.run(
    "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)",
  );
  db.run(
    "INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?)",
    [`https://sub.${host}/deep/path?q=secret`, SECRET_TITLE, 9, 1, unixToChromeUs(nowS - 3600), 0],
  );
  db.close();
  // mtime IS the recency signal `pickMostRecentBrowser` sorts on, so the test
  // that asserts the winner has to be able to set it.
  if (mtimeS !== undefined) utimesSync(dbPath, mtimeS, mtimeS);
}

/** A Chromium `Bookmarks` JSON file at `<userDataDir>/Default/Bookmarks`. */
function buildBookmarks(userDataDir: string, host: string): void {
  const profile = join(userDataDir, "Default");
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, "Bookmarks"),
    JSON.stringify({
      roots: {
        bookmark_bar: {
          children: [
            { type: "url", url: `https://www.${host}/private/path?token=abc`, name: SECRET_TITLE },
          ],
        },
        other: { children: [] },
        synced: { children: [] },
      },
    }),
  );
}

interface Probe {
  pick: { name: string; userDataDir: string; lastActiveMs: number } | null;
  prefs: {
    browser: string | null;
    last_active: string | null;
    bookmark_domains: string[];
    recent_domains: string[];
    redacted: boolean;
  };
}

function probeUnderHome(home: string): Probe {
  const script = join(home, "probe.ts");
  writeFileSync(
    script,
    [
      `import { pickMostRecentBrowser, browserPreferences } from ${JSON.stringify(join(REPO, "src/auth/browser-preferences.js"))};`,
      "const pick = pickMostRecentBrowser();",
      "const prefs = browserPreferences({ sinceDaysAgo: 7 });",
      "console.log(JSON.stringify({ pick, prefs }));",
    ].join("\n"),
  );

  // HOME on spawn is the whole point: `os.homedir()` is frozen at process
  // start, so discovery inside the child can only ever see the fixture.
  const res = spawnSync("bun", ["run", script], {
    env: { ...process.env, HOME: home },
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

describe("browser-preferences profile discovery on Linux", () => {
  test("a NATIVE ~/.config/google-chrome profile is found", () => {
    // The old code looked in ~/Library/Application Support/Google/Chrome — on
    // Linux, on every machine, forever.
    const home = newHome("unb-pref-native-");
    const udd = join(home, ".config", "google-chrome");
    buildHistoryDb(udd, NATIVE_HISTORY_HOST);
    buildBookmarks(udd, NATIVE_BOOKMARK_HOST);

    const { pick, prefs } = probeUnderHome(home);

    expect(pick).not.toBeNull();
    expect(pick?.name).toBe("Chrome");
    // Exact path, under the synthetic HOME: an assertion that merely ended in
    // "google-chrome" would also pass against the developer's real profile.
    expect(pick?.userDataDir).toBe(udd);
    expect(pick?.lastActiveMs).toBeGreaterThan(0);

    expect(prefs.browser).toBe("Chrome");
    expect(prefs.last_active).not.toBeNull();
    expect(prefs.bookmark_domains).toContain(NATIVE_BOOKMARK_HOST);
    expect(prefs.recent_domains).toContain(NATIVE_HISTORY_HOST);
  }, 60_000);

  test("a FLATPAK ~/.var/app/com.google.Chrome profile is found", () => {
    const home = newHome("unb-pref-flatpak-");
    const udd = join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome");
    buildHistoryDb(udd, FLATPAK_HISTORY_HOST);
    buildBookmarks(udd, FLATPAK_BOOKMARK_HOST);

    const { pick, prefs } = probeUnderHome(home);

    expect(pick).not.toBeNull();
    expect(pick?.name).toBe("Chrome");
    expect(pick?.userDataDir).toBe(udd);

    expect(prefs.browser).toBe("Chrome");
    expect(prefs.bookmark_domains).toContain(FLATPAK_BOOKMARK_HOST);
    expect(prefs.recent_domains).toContain(FLATPAK_HISTORY_HOST);
  }, 60_000);

  test("a HOME with no browser profiles yields nothing — the vacuity guard", () => {
    // Without this, "Chrome was found" above could be reporting the developer's
    // REAL Chrome rather than the fixture, and the gate would prove nothing.
    const { pick, prefs } = probeUnderHome(newHome("unb-pref-empty-"));

    expect(pick).toBeNull();
    expect(prefs.browser).toBeNull();
    expect(prefs.last_active).toBeNull();
    expect(prefs.bookmark_domains).toEqual([]);
    expect(prefs.recent_domains).toEqual([]);
    expect(prefs.redacted).toBe(true);
  }, 60_000);

  test("the winner is still the most-recently-active browser, and Brave keeps its capitals", () => {
    // Two things at once, both regressions the fix could have introduced:
    // WHERE roots are found changed; HOW the winner is picked must not have.
    // Chromium sorts LAST in the browser list and is given the NEWER History,
    // so a routing change that quietly returned "first root that exists" would
    // answer Brave here. Brave's root also proves the leaf is named explicitly:
    // a lowercased macPath would look in `bravesoftware/brave-browser`.
    const home = newHome("unb-pref-recency-");
    const brave = join(home, ".config", "BraveSoftware", "Brave-Browser");
    const chromium = join(home, ".config", "chromium");
    buildHistoryDb(brave, "brave-pref-history.invalid", nowS - 86_400);
    buildBookmarks(brave, BRAVE_BOOKMARK_HOST);
    buildHistoryDb(chromium, "chromium-pref-history.invalid", nowS - 60);
    buildBookmarks(chromium, CHROMIUM_BOOKMARK_HOST);

    const { pick, prefs } = probeUnderHome(home);

    expect(pick?.name).toBe("Chromium");
    expect(pick?.userDataDir).toBe(chromium);
    expect(prefs.browser).toBe("Chromium");
    // Bookmarks come from the WINNER only — Brave's must not appear.
    expect(prefs.bookmark_domains).toContain(CHROMIUM_BOOKMARK_HOST);
    expect(prefs.bookmark_domains).not.toContain(BRAVE_BOOKMARK_HOST);
    // Brave's root was still discovered — recent history sweeps every browser.
    expect(prefs.recent_domains).toContain("brave-pref-history.invalid");
  }, 60_000);

  test("the privacy contract holds — eTLD+1 only, never a subdomain, path, query or title", () => {
    const home = newHome("unb-pref-redact-");
    const udd = join(home, ".config", "google-chrome");
    buildHistoryDb(udd, NATIVE_HISTORY_HOST);
    buildBookmarks(udd, NATIVE_BOOKMARK_HOST);

    const { prefs } = probeUnderHome(home);

    // Non-vacuous: there IS something to redact.
    expect(prefs.bookmark_domains.length).toBeGreaterThan(0);
    expect(prefs.recent_domains.length).toBeGreaterThan(0);
    for (const d of [...prefs.bookmark_domains, ...prefs.recent_domains]) {
      expect(d).not.toContain("/");
      expect(d).not.toContain("?");
      expect(d).not.toContain("www.");
      expect(d).not.toContain("sub.");
      expect(d).not.toContain("secret");
      expect(d).not.toContain(SECRET_TITLE);
    }
  }, 60_000);
});
