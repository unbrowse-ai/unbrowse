/**
 * Witness for the Flatpak/Snap profile-discovery bug.
 *
 * Before this fix, Linux discovery was hardcoded to `~/.mozilla/firefox` and
 * `~/.config/<userData>` in four separate places, so a Firefox or Chromium
 * installed as a Flatpak (SteamOS, Silverblue) or a Snap (Ubuntu) was never
 * found: `act go` returned logged-out pages and `eval auth-inventory` reported
 * `sources_scanned: []` on a machine full of cookies. Patching two of the four
 * sites made `act go` work while auth-inventory still returned nothing — the
 * duplication IS the bug, so this file asserts BOTH the resolver and that the
 * real call sites go through it.
 *
 * NO MOCKS and NO real profiles: every assertion runs against a synthetic HOME
 * built in a temp dir with Flatpak/Snap-shaped directories and synthetic
 * sqlite fixtures. The route tests run in a subprocess because `os.homedir()`
 * is fixed at process start — HOME has to be set on spawn, which also
 * guarantees this test can never read the developer's real cookie jar.
 *
 * Run: bun test tests/linux-flatpak-profile-roots.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHROMIUM_PROFILE_TARGET,
  CHROME_PROFILE_TARGET,
  FIREFOX_PROFILE_TARGET,
  LINUX_FLATPAK_APP_IDS,
  existingBrowserProfileRoots,
  hasSandboxedBrowserProfileRoots,
  resolveBrowserExecutable,
  resolveBrowserProfileRoot,
  resolveBrowserProfileRoots,
} from "../src/auth/browser-profile-roots.js";

const REPO = join(import.meta.dir, "..");
const LINUX = { platform: "linux" } as const;

// Reserved-by-RFC-2606 fixture hosts. Nothing on this machine can own them,
// so a passing assertion can never be a real domain leaking into the output.
const FF_FIXTURE_DOMAIN = "flatpak-firefox-fixture.invalid";
const CR_FIXTURE_DOMAIN = "flatpak-chromium-fixture.invalid";

const CHROME_EPOCH_OFFSET_S = 11644473600;
const unixToChromeUs = (unixS: number): number => (unixS + CHROME_EPOCH_OFFSET_S) * 1_000_000;
const nowS = Math.floor(Date.now() / 1000);

const tempDirs: string[] = [];
function newHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function buildFirefoxProfile(profileDir: string, host: string): void {
  mkdirSync(profileDir, { recursive: true });
  const db = new Database(join(profileDir, "cookies.sqlite"));
  db.run(`
    CREATE TABLE moz_cookies (
      id INTEGER PRIMARY KEY,
      host TEXT, name TEXT, value TEXT, path TEXT,
      expiry INTEGER, lastAccessed INTEGER, isSecure INTEGER, isHttpOnly INTEGER
    )
  `);
  db.run(
    "INSERT INTO moz_cookies (host, name, value, path, expiry, lastAccessed, isSecure, isHttpOnly) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [host, "session", "FIXTURE-NOT-A-REAL-COOKIE", "/", nowS + 365 * 86400, nowS * 1_000_000, 1, 1],
  );
  db.close();
}

function buildChromiumProfile(profileDir: string, host: string): void {
  mkdirSync(profileDir, { recursive: true });
  const db = new Database(join(profileDir, "Cookies"));
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
  db.run(
    "INSERT INTO cookies (creation_utc, host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      unixToChromeUs(nowS),
      host,
      "session",
      "FIXTURE-NOT-A-REAL-COOKIE",
      Buffer.from(""),
      "/",
      unixToChromeUs(nowS + 365 * 86400),
      1,
      1,
    ],
  );
  db.close();
}

// ─── 1. The resolver: candidate order and every Linux layout ───────────────

describe("resolveBrowserProfileRoots — Linux layouts", () => {
  test("Firefox candidates: native FIRST, then both Flatpak layouts, then Snap", () => {
    const home = "/home/fixture";
    const roots = resolveBrowserProfileRoots(FIREFOX_PROFILE_TARGET, { home, ...LINUX });
    expect(roots[0]).toBe("/home/fixture/.mozilla/firefox");
    // Both Flatpak layouts exist in the wild; missing either loses real users.
    expect(roots).toContain("/home/fixture/.var/app/org.mozilla.firefox/.mozilla/firefox");
    expect(roots).toContain("/home/fixture/.var/app/org.mozilla.firefox/config/mozilla/firefox");
    expect(roots).toContain("/home/fixture/snap/firefox/common/.mozilla/firefox");
  });

  test("Chromium candidates: native FIRST, then Flatpak app-id, then Snap", () => {
    const home = "/home/fixture";
    const roots = resolveBrowserProfileRoots(CHROMIUM_PROFILE_TARGET, { home, ...LINUX });
    expect(roots[0]).toBe("/home/fixture/.config/chromium");
    expect(roots).toContain("/home/fixture/.var/app/org.chromium.Chromium/config/chromium");
    expect(roots).toContain("/home/fixture/.var/app/org.chromium.Chromium/.config/chromium");
    expect(roots.some((r) => r.startsWith("/home/fixture/snap/chromium/common"))).toBe(true);
  });

  test("the linuxUserData -> Flatpak app-id map covers the Chromium family", () => {
    expect(LINUX_FLATPAK_APP_IDS["google-chrome"]).toBe("com.google.Chrome");
    expect(LINUX_FLATPAK_APP_IDS["chromium"]).toBe("org.chromium.Chromium");
    expect(LINUX_FLATPAK_APP_IDS["BraveSoftware/Brave-Browser"]).toBe("com.brave.Browser");
    expect(LINUX_FLATPAK_APP_IDS["microsoft-edge"]).toBe("com.microsoft.Edge");
    expect(LINUX_FLATPAK_APP_IDS["vivaldi"]).toBe("com.vivaldi.Vivaldi");
    expect(LINUX_FLATPAK_APP_IDS["opera"]).toBe("com.opera.Opera");

    // A multi-segment leaf keeps its shape inside the sandbox: XDG_CONFIG_HOME
    // is ~/.var/app/<id>/config, so Brave writes the SAME relative path there.
    const brave = resolveBrowserProfileRoots(
      { family: "chromium", macPath: "BraveSoftware/Brave-Browser", linuxUserData: "BraveSoftware/Brave-Browser" },
      { home: "/home/fixture", ...LINUX },
    );
    expect(brave[0]).toBe("/home/fixture/.config/BraveSoftware/Brave-Browser");
    expect(brave).toContain("/home/fixture/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser");
  });

  test("a native install still resolves to its native path when a Flatpak also exists", () => {
    const home = newHome("unb-flatpak-native-");
    const native = join(home, ".mozilla", "firefox");
    const flatpak = join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox");
    mkdirSync(native, { recursive: true });
    mkdirSync(flatpak, { recursive: true });

    expect(resolveBrowserProfileRoot(FIREFOX_PROFILE_TARGET, { home, ...LINUX })).toBe(native);
    // …and the inventory walk still sees BOTH, native first.
    expect(existingBrowserProfileRoots(FIREFOX_PROFILE_TARGET, { home, ...LINUX })).toEqual([native, flatpak]);
  });

  test("Flatpak layout A (~/.var/app/<id>/.mozilla/firefox) resolves", () => {
    const home = newHome("unb-flatpak-a-");
    const root = join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox");
    mkdirSync(root, { recursive: true });
    expect(resolveBrowserProfileRoot(FIREFOX_PROFILE_TARGET, { home, ...LINUX })).toBe(root);
  });

  test("Flatpak layout B (~/.var/app/<id>/config/mozilla/firefox) resolves", () => {
    const home = newHome("unb-flatpak-b-");
    const root = join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox");
    mkdirSync(root, { recursive: true });
    expect(resolveBrowserProfileRoot(FIREFOX_PROFILE_TARGET, { home, ...LINUX })).toBe(root);
  });

  test("Snap (~/snap/<name>/common/) resolves for Firefox and Chromium", () => {
    const home = newHome("unb-snap-");
    const ff = join(home, "snap", "firefox", "common", ".mozilla", "firefox");
    const cr = join(home, "snap", "chromium", "common", "chromium");
    mkdirSync(ff, { recursive: true });
    mkdirSync(cr, { recursive: true });
    expect(resolveBrowserProfileRoot(FIREFOX_PROFILE_TARGET, { home, ...LINUX })).toBe(ff);
    expect(resolveBrowserProfileRoot(CHROMIUM_PROFILE_TARGET, { home, ...LINUX })).toBe(cr);
  });

  test("nothing installed -> the NATIVE path, so diagnostics name a path users know", () => {
    const home = newHome("unb-empty-");
    expect(resolveBrowserProfileRoot(FIREFOX_PROFILE_TARGET, { home, ...LINUX })).toBe(
      join(home, ".mozilla", "firefox"),
    );
    expect(resolveBrowserProfileRoot(CHROME_PROFILE_TARGET, { home, ...LINUX })).toBe(
      join(home, ".config", "google-chrome"),
    );
    expect(existingBrowserProfileRoots(FIREFOX_PROFILE_TARGET, { home, ...LINUX })).toEqual([]);
  });

  test("darwin and win32 shapes are untouched by the Linux work", () => {
    expect(
      resolveBrowserProfileRoots(CHROME_PROFILE_TARGET, { home: "/Users/fixture", platform: "darwin" }),
    ).toEqual(["/Users/fixture/Library/Application Support/Google/Chrome"]);
    expect(
      resolveBrowserProfileRoots(FIREFOX_PROFILE_TARGET, { home: "/Users/fixture", platform: "darwin" }),
    ).toEqual(["/Users/fixture/Library/Application Support/Firefox/Profiles"]);
    const win = resolveBrowserProfileRoots(CHROME_PROFILE_TARGET, {
      home: "C:\\Users\\fixture",
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" },
    });
    expect(win.length).toBe(1);
    expect(win[0]).toContain("Google");
    expect(win[0]).toContain("User Data");
  });
});

// ─── 2. Flatpak launcher as the executable ─────────────────────────────────

describe("resolveBrowserExecutable — the second, independent Flatpak failure", () => {
  test("a Flatpak userDataDir accepts the flatpak launcher when no native binary exists", () => {
    const home = newHome("unb-exec-flatpak-");
    const userDataDir = join(home, ".var", "app", "org.chromium.Chromium", "config", "chromium");
    mkdirSync(userDataDir, { recursive: true });
    const launcher = join(home, "fake-usr-bin-flatpak");
    writeFileSync(launcher, "");

    // Without this, a correctly resolved userDataDir is still thrown away and
    // the browser is reported as not installed.
    expect(
      resolveBrowserExecutable(["/usr/bin/chromium-does-not-exist"], userDataDir, {
        ...LINUX,
        launchers: [launcher],
      }),
    ).toBe(launcher);
  });

  test("a native binary always wins over the launcher", () => {
    const home = newHome("unb-exec-native-");
    const userDataDir = join(home, ".var", "app", "org.chromium.Chromium", "config", "chromium");
    mkdirSync(userDataDir, { recursive: true });
    const nativeBin = join(home, "fake-usr-bin-chromium");
    const launcher = join(home, "fake-usr-bin-flatpak");
    writeFileSync(nativeBin, "");
    writeFileSync(launcher, "");
    expect(
      resolveBrowserExecutable([nativeBin], userDataDir, { ...LINUX, launchers: [launcher] }),
    ).toBe(nativeBin);
  });

  test("a NON-Flatpak userDataDir never accepts the launcher", () => {
    const home = newHome("unb-exec-reject-");
    const userDataDir = join(home, ".config", "chromium");
    mkdirSync(userDataDir, { recursive: true });
    const launcher = join(home, "fake-usr-bin-flatpak");
    writeFileSync(launcher, "");
    expect(
      resolveBrowserExecutable(["/usr/bin/chromium-does-not-exist"], userDataDir, {
        ...LINUX,
        launchers: [launcher],
      }),
    ).toBeNull();
  });
});

// ─── 3. The native-only cookie probe is blind, not authoritative ───────────

describe("hasSandboxedBrowserProfileRoots", () => {
  test("true when a Flatpak profile root exists, false on a native-only machine", () => {
    const sandboxed = newHome("unb-sandboxed-");
    mkdirSync(join(sandboxed, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox"), {
      recursive: true,
    });
    expect(hasSandboxedBrowserProfileRoots({ home: sandboxed, ...LINUX })).toBe(true);

    const native = newHome("unb-native-only-");
    mkdirSync(join(native, ".mozilla", "firefox"), { recursive: true });
    expect(hasSandboxedBrowserProfileRoots({ home: native, ...LINUX })).toBe(false);
  });
});

// ─── 4. The call sites actually route through the resolver ─────────────────
//
// This is the assertion the previous fix failed: `act go` found Firefox while
// `eval auth-inventory` still returned `sources_scanned: []`, because they do
// not share a resolver. A synthetic HOME is handed to a subprocess so
// `os.homedir()` (fixed at process start) points at the fixture.

interface RouteProbe {
  sources_scanned: string[];
  inventory_domains: string[];
  browsers_scanned: string[];
  cookie_domains: string[];
}

describe("call sites route through the one resolver (synthetic Flatpak HOME)", () => {
  let home: string;
  let probe: RouteProbe;
  let raw: { status: number | null; stdout: string; stderr: string };

  beforeAll(() => {
    home = newHome("unb-flatpak-route-");
    // A Flatpak-only machine: no ~/.mozilla/firefox, no ~/.config/chromium.
    buildFirefoxProfile(
      join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox", "ab12cd34.default-release"),
      FF_FIXTURE_DOMAIN,
    );
    buildChromiumProfile(
      join(home, ".var", "app", "org.chromium.Chromium", "config", "chromium", "Default"),
      CR_FIXTURE_DOMAIN,
    );

    const script = join(home, "probe.ts");
    writeFileSync(
      script,
      [
        `import { runInventory } from ${JSON.stringify(join(REPO, "src/cli-v7/eval/auth-inventory.js"))};`,
        `import { listCookieDomains } from ${JSON.stringify(join(REPO, "src/auth/browser-cookies.js"))};`,
        "const inv = await runInventory({});",
        "const scan = listCookieDomains();",
        "console.log(JSON.stringify({",
        "  sources_scanned: inv.sources_scanned,",
        "  inventory_domains: Object.keys(inv.inventory),",
        "  browsers_scanned: scan.browsers_scanned,",
        "  cookie_domains: scan.domains.map((d) => d.domain),",
        "}));",
      ].join("\n"),
    );

    const res = spawnSync("bun", ["run", script], {
      // HOME is the whole point: discovery must find the fixture, not this
      // machine's real profiles.
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    raw = { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    const line = raw.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}";
    probe = JSON.parse(line) as RouteProbe;
  });

  test("the probe subprocess ran", () => {
    expect(raw.status).toBe(0);
  });

  test("eval auth-inventory discovers the Flatpak Firefox profile", () => {
    // The exact regression from the report: sources_scanned was [].
    const ff = probe.sources_scanned.filter((s) => s.startsWith("firefox:"));
    expect(ff.length).toBeGreaterThan(0);
    expect(ff.some((s) => s.includes("/.var/app/org.mozilla.firefox/config/mozilla/firefox/"))).toBe(true);
    expect(probe.inventory_domains).toContain(FF_FIXTURE_DOMAIN);
  });

  test("eval auth-inventory discovers the Flatpak Chromium profile", () => {
    const cr = probe.sources_scanned.filter((s) => s.includes("/.var/app/org.chromium.Chromium/"));
    expect(cr.length).toBeGreaterThan(0);
    expect(probe.inventory_domains).toContain(CR_FIXTURE_DOMAIN);
  });

  test("the browser-cookies domain scan sees the same Flatpak profiles", () => {
    expect(probe.browsers_scanned).toContain("Firefox");
    expect(probe.browsers_scanned).toContain("Chromium");
    expect(probe.cookie_domains).toContain(FF_FIXTURE_DOMAIN);
    expect(probe.cookie_domains).toContain(CR_FIXTURE_DOMAIN);
  });

  test("no real domain from this machine leaks into the fixture run", () => {
    // Everything discovered must come from the synthetic HOME.
    expect(new Set(probe.cookie_domains)).toEqual(new Set([FF_FIXTURE_DOMAIN, CR_FIXTURE_DOMAIN]));
    expect(new Set(probe.inventory_domains)).toEqual(new Set([FF_FIXTURE_DOMAIN, CR_FIXTURE_DOMAIN]));
  });
});
