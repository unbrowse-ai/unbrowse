// Several Unbrowse accounts on one machine (issue #138): each named account keeps its own sign-in, so its own
// vault, saved logins and synced browser cookies. `--account NAME`, UNBROWSE_ACCOUNT or `accounts use` picks one.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectAccount } from "../src/auth.ts";
import { main } from "../src/cli.ts";
import * as D from "../src/cookie-daemon.ts";

// Every token is accepted; /me says which one arrived, so a test can tell the accounts apart.
const seen: (string | null)[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const auth = req.headers.get("authorization");
    seen.push(auth);
    if (!auth) return Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
    return Response.json({ workspaceId: `ws_for_${auth.replace(/^Bearer /, "")}` });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;
const saved = { ...process.env };
let dir = "";

function cli(argv: string[], over: { exec?: (c: string[]) => { status: number; stdout: string; stderr: string } } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return main([...argv, "--base-url", BASE], { out: (s) => out.push(s), err: (s) => err.push(s), open: () => {}, interactive: false, ...(over.exec ? { exec: over.exec, service: { node: "/usr/bin/node", cli: "/opt/unbrowse/cli.js" } } : {}) }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) }));
}

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ub-acct-claude-")); // never the developer's real one
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ub-acct-"));
  process.env.UNBROWSE_CONFIG_DIR = dir;
  delete process.env.UNBROWSE_API_KEY;
  delete process.env.UNBROWSE_ACCOUNT;
  seen.length = 0;
});
afterEach(() => {
  delete process.env.UNBROWSE_ACCOUNT;
  selectAccount("default");
});
afterAll(() => {
  server.stop(true);
  for (const k of ["UNBROWSE_CONFIG_DIR", "UNBROWSE_API_KEY", "UNBROWSE_ACCOUNT", "CLAUDE_CONFIG_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("each account keeps its own sign-in; --account picks one and whoami names it", async () => {
  expect((await cli(["login", "--key", "fake-token-home"])).code).toBe(0);
  const work = await cli(["login", "--key", "fake-token-work", "--account", "work"]);
  expect(work.code).toBe(0);
  expect(work.err).toContain('as account "work"');
  expect(JSON.parse(readFileSync(join(dir, "cli.json"), "utf8")).apiKey).toBe("fake-token-home");
  expect(JSON.parse(readFileSync(join(dir, "accounts", "work", "cli.json"), "utf8")).apiKey).toBe("fake-token-work");

  const home = await cli(["whoami"]);
  expect(home.json()).toMatchObject({ account: "default", workspaceId: "ws_for_fake-token-home" });
  const w = await cli(["whoami", "--account", "work"]);
  expect(w.json()).toMatchObject({ account: "work", workspaceId: "ws_for_fake-token-work" });
  expect(seen.at(-1)).toBe("Bearer fake-token-work");
});

test("UNBROWSE_ACCOUNT selects an account; --account wins over it", async () => {
  await cli(["login", "--key", "fake-token-work", "--account", "work"]);
  await cli(["login", "--key", "fake-token-biz", "--account", "biz"]);
  process.env.UNBROWSE_ACCOUNT = "biz";
  expect((await cli(["whoami"])).json().account).toBe("biz");
  expect(seen.at(-1)).toBe("Bearer fake-token-biz");
  expect((await cli(["whoami", "--account", "work"])).json().account).toBe("work");
  expect(seen.at(-1)).toBe("Bearer fake-token-work");
});

test("accounts lists the saved sign-ins without secrets; accounts use switches the default and back", async () => {
  await cli(["login", "--key", "fake-token-home"]);
  await cli(["login", "--key", "fake-token-work", "--account", "work"]);
  const list = await cli(["accounts"]);
  expect(list.json()).toEqual({ current: "default", accounts: [{ name: "default", baseUrl: BASE, signIn: "api key" }, { name: "work", baseUrl: BASE, signIn: "api key" }] });
  expect(list.out).not.toContain("fake-token");

  expect((await cli(["accounts", "use", "work"])).code).toBe(0);
  expect((await cli(["accounts"])).json().current).toBe("work");
  expect((await cli(["whoami"])).json()).toMatchObject({ account: "work", workspaceId: "ws_for_fake-token-work" });
  expect((await cli(["whoami", "--account", "default"])).json().account).toBe("default");

  const fresh = await cli(["accounts", "use", "travel"]);
  expect(fresh.err).toContain("not signed in yet: unbrowse login --account travel");

  await cli(["accounts", "use", "default"]);
  expect((await cli(["whoami"])).json().account).toBe("default");
  expect(seen.at(-1)).toBe("Bearer fake-token-home");
});

test("a named account with no sign-in exits 3 naming its own login, and never borrows another sign-in", async () => {
  await cli(["login", "--key", "fake-token-home"]);
  // Claude Code holds a valid sign-in for this origin: the default account may share it, a named one may not.
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ mcpOAuth: { "a|1": { serverName: "unbrowse", serverUrl: `${BASE}/api/mcp`, accessToken: "fake-token-shared", expiresAt: Date.now() + 3_600_000 } } }));
  seen.length = 0;
  try {
    const r = await cli(["whoami", "--account", "travel"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('as account "travel"');
    expect(r.err).toContain("npx unbrowse login --account travel");
    expect(seen).toEqual([]); // nothing was sent, with any token
  } finally {
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "{}");
  }
});

test("a bad account name is refused before anything is written", async () => {
  for (const bad of ["../x", "a/b", ".hidden", "x".repeat(41)]) {
    const r = await cli(["login", "--key", "fake-token-x", "--account", bad]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("invalid account name");
  }
  expect((await cli(["whoami", "--account"])).code).toBe(1);
  expect(existsSync(join(dir, "accounts"))).toBe(false);
  expect(existsSync(join(dir, "cli.json"))).toBe(false);
});

test("logout --account signs out of that account only", async () => {
  await cli(["login", "--key", "fake-token-home"]);
  await cli(["login", "--key", "fake-token-work", "--account", "work"]);
  const out = await cli(["logout", "--account", "work"]);
  expect(out.err).toContain('Signed out of account "work"');
  expect(existsSync(join(dir, "accounts", "work", "cli.json"))).toBe(false);
  expect(existsSync(join(dir, "cli.json"))).toBe(true);
});

test("per account: mcp add registers its own server, and cookie sync gets its own service", async () => {
  await cli(["login", "--key", "fake-token-work", "--account", "work"]);
  const dry = await cli(["mcp", "add", "claude", "--dry-run", "--account", "work"], { exec: () => ({ status: 0, stdout: "", stderr: "" }) });
  expect(dry.code).toBe(0);
  expect(dry.out).toContain("claude mcp add --scope user unbrowse-work ");
  expect(dry.out).toMatch(/ mcp --base-url \S+ --account work$/);
  expect(dry.out).not.toContain("fake-token");

  const linux = D.servicePlan({ os: "linux", home: "/home/u", node: "/opt/node", cli: "/opt/cli.js", account: "work", env: { UNBROWSE_ACCOUNT: "work" } })!;
  expect(linux.path).toBe("/home/u/.config/systemd/user/unbrowse-cookies-work.service");
  expect(linux.content).toContain("Environment=UNBROWSE_ACCOUNT=work");
  expect(linux.enable.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", "unbrowse-cookies-work.service"]);
  const mac = D.servicePlan({ os: "darwin", home: "/Users/u", node: "/opt/node", cli: "/opt/cli.js", uid: 501, account: "work" })!;
  expect(mac.path).toBe("/Users/u/Library/LaunchAgents/ai.unbrowse.cookies.work.plist");
  // The default account's service keeps its name, so an existing install is not orphaned.
  expect(D.servicePlan({ os: "linux", home: "/home/u", node: "n", cli: "c" })!.path).toBe("/home/u/.config/systemd/user/unbrowse-cookies.service");
});
