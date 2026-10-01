// Continuous cookie sync: `cookies daemon start|status|stop`, `cookies watch`, and the opt-in after sign-in.
// A fake HOME holds a real Firefox profile (cookies.sqlite written with bun:sqlite) so the real reader runs; a stub
// Unbrowse server records uploads; systemd commands are captured, never run.
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "unbrowse-home-"));
process.env.HOME = HOME;
process.env.UNBROWSE_COOKIES_HOME = HOME; // never the real browsers of the machine running the tests
process.env.UNBROWSE_CONFIG_DIR = join(HOME, ".config", "unbrowse");
delete process.env.UNBROWSE_API_KEY;

import { afterAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { main } from "../src/cli.ts";
import * as D from "../src/cookie-daemon.ts";
import { save } from "../src/auth.ts";

const TOKEN = "ub_live_daemon_0123456789";
const uploads: Array<{ domain: string; name: string; value: string }[]> = [];
let refuse = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/api\/v1\//, "");
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}` || refuse) return Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
    if (path === "me") return Response.json({ workspaceId: "ws_d" });
    if (path === "cookies" && req.method === "POST") {
      const body = (await req.json()) as { cookies: { domain: string; name: string; value: string }[] };
      uploads.push(body.cookies);
      const sites = new Set(body.cookies.map((c) => c.domain.replace(/^\./, "").split(".").slice(-2).join(".")));
      return Response.json({ sites: sites.size, cookies: body.cookies.length, origins: [] });
    }
    return Response.json({ error: { code: "not_found", message: path } }, { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

// A Firefox profile with a signed-in github.com, a bank the person did not choose, and an expired cookie.
const profileDir = join(HOME, ".mozilla", "firefox", "abc.default-release");
mkdirSync(profileDir, { recursive: true });
writeFileSync(join(HOME, ".mozilla", "firefox", "profiles.ini"), "[Profile0]\nName=default-release\nIsRelative=1\nPath=abc.default-release\nDefault=1\n");
const future = Math.floor(Date.now() / 1000) + 30 * 86400;
const db = new Database(join(profileDir, "cookies.sqlite"));
db.run("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER)");
const put = db.prepare("INSERT INTO moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly) VALUES (?, ?, ?, ?, ?, 1, 1)");
put.run(".github.com", "user_session", "gh-session-1", "/", future);
put.run("github.com", "logged_in", "yes", "/", future);
put.run(".github.com", "old", "stale", "/", 1000);
put.run(".mybank.example", "auth", "bank-secret", "/", future);
db.close();
const setGithubSession = (v: string) => {
  const d = new Database(join(profileDir, "cookies.sqlite"));
  d.run("UPDATE moz_cookies SET value = ? WHERE name = 'user_session'", [v]);
  d.close();
};

const service = { os: "linux" as const, home: HOME, node: "/usr/bin/node", cli: "/opt/unbrowse/cli.js" };
function cli(argv: string[], over: { interactive?: boolean; answers?: string[]; status?: number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const execs: string[][] = [];
  const asked: string[] = [];
  const answers = [...(over.answers ?? [])];
  return main([...argv, "--base-url", BASE], {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    open: () => {},
    interactive: over.interactive ?? false,
    ask: async (q) => (asked.push(q), answers.shift() ?? ""),
    exec: (cmd) => (execs.push(cmd), { status: cmd.includes("is-active") ? (over.status ?? 0) : 0, stdout: "", stderr: "" }),
    service,
  }).then((code) => ({ code, out, err, execs, asked, json: () => JSON.parse(out[0]!) }));
}
const unit = join(HOME, ".config", "systemd", "user", "unbrowse-cookies.service");
const cfgDir = process.env.UNBROWSE_CONFIG_DIR!;

beforeEach(async () => {
  uploads.length = 0;
  refuse = false;
  save({ baseUrl: BASE, apiKey: TOKEN });
  await cli(["cookies", "daemon", "stop"]);
});

test("pure parts: sites are hosts, the fingerprint follows values, backoff doubles to an hour", () => {
  expect(D.parseSites("https://www.GitHub.com/settings, linkedin.com  .x.com nope")).toEqual(["github.com", "linkedin.com", "x.com"]);
  const a = [{ domain: ".a.com", name: "s", value: "1", path: "/", expires: 0 }];
  expect(D.digest(a)).toBe(D.digest([...a]));
  expect(D.digest(a)).not.toBe(D.digest([{ ...a[0]!, value: "2" }]));
  const cfg = { sites: ["a.com"], intervalMin: 15 };
  expect(D.nextDelayMs(cfg, { sites: {} })).toBe(15 * 60_000);
  expect(D.nextDelayMs(cfg, { sites: {}, failures: 1 })).toBe(30 * 60_000);
  expect(D.nextDelayMs(cfg, { sites: {}, failures: 9 })).toBe(60 * 60_000);
  expect(D.ephemeralCli("/home/u/.npm/_npx/123/node_modules/unbrowse/dist/cli.js")).toBe(true);
  expect(D.ephemeralCli("/usr/lib/node_modules/unbrowse/dist/cli.js")).toBe(false);
  const mac = D.servicePlan({ os: "darwin", home: "/Users/u", node: "/opt/node", cli: "/opt/cli.js", uid: 501 })!;
  expect(mac.path).toBe("/Users/u/Library/LaunchAgents/ai.unbrowse.cookies.plist");
  expect(mac.content).toContain("<string>cookies</string><string>watch</string>");
  expect(mac.enable.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", mac.path]);
  expect(D.servicePlan({ os: "win32", node: "n", cli: "c" })).toBeUndefined();
  // "everything": `*` (or `all`) wins over any names; registrable-site grouping folds subdomains and multi-label TLDs.
  expect(D.parseSites("github.com, *")).toEqual(["*"]);
  expect(D.parseSites("all")).toEqual(["*"]);
  expect(D.allSites({ sites: ["*"] })).toBe(true);
  expect(D.siteOf("accounts.google.com")).toBe("google.com");
  expect(D.siteOf(".google.com")).toBe("google.com");
  expect(D.siteOf("id.singpass.gov.sg")).toBe("singpass.gov.sg");
  expect(D.siteOf("www.bbc.co.uk")).toBe("bbc.co.uk");
});

test("all-sites: syncOnce uploads every site in the profile, grouped by registrable site, in batches", async () => {
  const { findProfiles, readCookies } = await import("../src/cookies.ts");
  const batches: number[] = [];
  const state: D.SyncState = { sites: {} };
  // Profile holds github (chosen test seed), a bank and plain github.com + .github.com (one registrable site).
  const r = await D.syncOnce({ findProfiles, readCookies, upload: async (c) => (batches.push(c.length), { sites: 1, cookies: c.length }), now: Date.now }, { sites: ["*"], intervalMin: 15 }, state);
  expect(r.error).toBeUndefined();
  expect(r.uploaded).toContain("github.com");
  expect(r.uploaded).toContain("mybank.example"); // "everything" means the bank too
  expect(state.sites["github.com"]!.cookies).toBe(2); // github.com + .github.com folded, expired "old" dropped
  expect(batches.every((n) => n <= D.UPLOAD_BATCH)).toBe(true);
  // Nothing changed: a second pass uploads nothing.
  const again = await D.syncOnce({ findProfiles, readCookies, upload: async () => ({ sites: 0, cookies: 0 }), now: Date.now }, { sites: ["*"], intervalMin: 15 }, state);
  expect(again.uploaded).toEqual([]);
  expect(again.unchanged).toContain("github.com");
});

test("install: one real sync of only the chosen site (live cookies), then a systemd user service that runs `cookies watch`", async () => {
  const r = await cli(["cookies", "daemon", "start", "--domain", "github.com", "--yes"]);
  expect(r.code).toBe(0);
  expect(uploads.length).toBe(1);
  expect(uploads[0]!.map((c) => c.name).sort()).toEqual(["logged_in", "user_session"]);
  expect(JSON.stringify(uploads)).not.toContain("bank-secret");
  expect(JSON.stringify(uploads)).not.toContain("stale");
  const content = readFileSync(unit, "utf8");
  expect(content).toContain("ExecStart=/usr/bin/node /opt/unbrowse/cli.js cookies watch");
  expect(content).toContain(`Environment=UNBROWSE_BASE_URL=${BASE}`);
  expect(content).toContain("Restart=on-failure");
  expect(r.execs).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "unbrowse-cookies.service"]]);
  expect(JSON.parse(readFileSync(join(cfgDir, "cookie-sync.json"), "utf8"))).toMatchObject({ sites: ["github.com"], intervalMin: 15 });
  const state = readFileSync(join(cfgDir, "cookie-sync.state.json"), "utf8");
  expect(state).not.toContain("gh-session-1");

  const st = await cli(["cookies", "daemon", "status", "--json"]);
  expect(st.code).toBe(0);
  expect(st.json()).toMatchObject({ installed: true, running: true, service: "systemd", sites: ["github.com"], intervalMin: 15 });
  expect(st.json().uploaded["github.com"].cookies).toBe(2);
  const stopped = await cli(["cookies", "daemon", "status"], { status: 3 });
  expect(stopped.code).toBe(1);
  expect(stopped.err.join("\n")).toContain("installed but not running");
});

test("watch uploads a site again only when its cookies change, and keeps going through a refused upload", async () => {
  await cli(["cookies", "daemon", "start", "--domain", "github.com", "--yes"]);
  uploads.length = 0;
  const { findProfiles, readCookies } = await import("../src/cookies.ts");
  const { Unbrowse } = await import("@unbrowse/sdk");
  const deps = async () => ({ findProfiles, readCookies, upload: (c: never) => new Unbrowse({ apiKey: TOKEN, baseUrl: BASE }).importCookies(c), now: Date.now });
  const cfg = { sites: ["github.com"], intervalMin: 15 };
  const statePath = join(cfgDir, "cookie-sync.state.json");
  const logs: string[] = [];
  let rounds = 0;
  const stop = new AbortController();
  await D.watch({
    deps,
    cfg,
    statePath,
    log: (s) => logs.push(s),
    signal: stop.signal,
    sleep: async () => {
      rounds++;
      if (rounds === 1) setGithubSession("gh-session-2"); // the person signed in again: new value
      if (rounds === 2) refuse = true; // Unbrowse refuses the next upload
      if (rounds === 3) (refuse = false), setGithubSession("gh-session-3");
      if (rounds === 4) stop.abort();
    },
  });
  expect(logs[0]).toContain("unchanged github.com");
  expect(logs[1]).toContain("uploaded github.com (2 cookies)");
  setGithubSession("gh-session-1");
  expect(logs[2]).toContain("unchanged github.com");
  expect(logs[3]).toContain("uploaded github.com");
  expect(uploads.map((u) => u.find((c) => c.name === "user_session")!.value)).toEqual(["gh-session-2", "gh-session-3"]);
});

test("a refused upload is reported, counted for backoff, and status names it", async () => {
  const state: D.SyncState = { sites: {} };
  const { findProfiles, readCookies } = await import("../src/cookies.ts");
  const r = await D.syncOnce({ findProfiles, readCookies, upload: async () => Promise.reject(Object.assign(new Error("Unauthorized"), { status: 401 })), now: Date.now }, { sites: ["github.com"], intervalMin: 15 }, state);
  expect(r.error).toContain("signed out of Unbrowse");
  expect(state.failures).toBe(1);
  expect(state.sites["github.com"]).toBeUndefined();
});

test("install needs consent: not interactive and no --yes is refused, nothing is uploaded or installed", async () => {
  const r = await cli(["cookies", "daemon", "start", "--domain", "github.com"]);
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toContain("--yes");
  expect(uploads.length).toBe(0);
  expect(existsSync(unit)).toBe(false);
  const noSites = await cli(["cookies", "daemon", "start", "--yes"]);
  expect(noSites.code).toBe(1);
  expect(noSites.err.join("\n")).toContain("name the sites");
});

test("daemon start --all-sites: confirms the full scope, then syncs every site and saves sites: ['*']", async () => {
  const r = await cli(["cookies", "daemon", "start", "--all-sites", "--yes"]);
  expect(r.code).toBe(0);
  // Both the chosen seed site and the bank are uploaded (everything).
  expect(JSON.stringify(uploads)).toContain("user_session");
  expect(JSON.stringify(uploads)).toContain("bank-secret");
  expect(JSON.parse(readFileSync(join(cfgDir, "cookie-sync.json"), "utf8")).sites).toEqual(["*"]);
  const st = await cli(["cookies", "daemon", "status"]);
  expect(st.err.join("\n")).toContain("every site");
});

test("all-sites install without --yes names the full scope in the confirmation and refuses when not interactive", async () => {
  const r = await cli(["cookies", "daemon", "start", "--all-sites"]);
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toContain("EVERY site");
  expect(r.err.join("\n")).toMatch(/banking|payments/);
  expect(existsSync(unit)).toBe(false);
});

test("uninstall stops the service and removes the unit, config and state", async () => {
  await cli(["cookies", "daemon", "start", "--domain", "github.com", "--yes"]);
  const r = await cli(["cookies", "daemon", "stop"]);
  expect(r.code).toBe(0);
  expect(r.execs[0]).toEqual(["systemctl", "--user", "disable", "--now", "unbrowse-cookies.service"]);
  expect(existsSync(unit)).toBe(false);
  expect(existsSync(join(cfgDir, "cookie-sync.json"))).toBe(false);
  expect((await cli(["cookies", "daemon", "status"])).err.join("\n")).toContain("not running");
});

test("onboarding: after sign-in at a terminal the CLI offers sync once; the named sites are installed, Enter skips", async () => {
  const yes = await cli(["login", "--key", TOKEN], { interactive: true, answers: ["github.com"] });
  expect(yes.code).toBe(0);
  expect(yes.asked.join("\n")).toContain("Sites to keep in sync");
  expect(existsSync(unit)).toBe(true);
  expect(uploads.length).toBe(1);
  // Already set up: not asked again.
  const again = await cli(["login", "--key", TOKEN], { interactive: true, answers: ["x.com"] });
  expect(again.asked.length).toBe(0);

  await cli(["cookies", "daemon", "stop"]);
  uploads.length = 0;
  const skip = await cli(["login", "--key", TOKEN], { interactive: true, answers: [""] });
  expect(skip.code).toBe(0);
  expect(skip.err.join("\n")).toContain("Skipped");
  expect(existsSync(unit)).toBe(false);
  expect(uploads.length).toBe(0);
  // A script (no terminal) is never asked.
  const script = await cli(["login", "--key", TOKEN]);
  expect(script.asked.length).toBe(0);
});
