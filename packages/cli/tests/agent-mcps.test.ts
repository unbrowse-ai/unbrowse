// `unbrowse mcps` reads every agent's MCP config on this machine; `mcps import` brings them into Unbrowse without
// sending a key unless --with-keys (and a yes). Fixture configs for each host, a stand-in API, no network.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyOf, normalize, parseCodexToml, parseJsonc, rawEntry, scan, toImport, unique } from "../src/agent-mcps.ts";
import { main } from "../src/cli.ts";

// Fake values that look like keys to the CLI (long, or named token): never real-provider shapes, for push protection.
const SECRET = "fake-token-value-0000000000000000000000000000";
const KEY = "fake-api-key-1111111111111111111111111111111";
const home = mkdtempSync(join(tmpdir(), "mcps-home-"));
const cwd = mkdtempSync(join(tmpdir(), "mcps-proj-"));
const put = (path: string, text: string) => (mkdirSync(join(path, ".."), { recursive: true }), writeFileSync(path, text));

put(join(home, ".claude.json"), JSON.stringify({
  mcpServers: {
    linear: { type: "http", url: "https://mcp.linear.app/mcp" },
    unbrowse: { type: "http", url: "https://unbrowse.ai/mcp", headers: { Authorization: `Bearer ${KEY}` } },
    keyed: { type: "http", url: "https://keyed.example/mcp", headers: { Authorization: `Bearer ${KEY}` } },
  },
  projects: { [cwd]: { mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET } } } } },
}));
put(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/me", `--token=${SECRET}`] } } }));
put(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" }, sentry: { command: "npx", args: ["-y", "mcp-remote", "https://mcp.sentry.dev/sse"] } } }));
put(join(home, ".codex", "config.toml"), `model = "gpt-5"\n\n[mcp_servers.notion]\ncommand = "npx"\nargs = ["-y", "@notionhq/notion-mcp-server"]\nenv = { NOTION_TOKEN = "${SECRET}" }\n\n[mcp_servers."docs"]\nurl = "https://docs.example/mcp"\n\n[mcp_servers.docs.http_headers]\nX-Api-Key = "${KEY}"\n\n[profile.x]\nmodel = "o3"\n`);
put(join(home, ".config", "Code", "User", "mcp.json"), `{\n  // VS Code keeps comments\n  "servers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"], }, },\n}`);
put(join(home, ".codeium", "windsurf", "mcp_config.json"), JSON.stringify({ mcpServers: { stripe: { serverUrl: "https://mcp.stripe.com" } } }));
put(join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { off: { httpUrl: "https://off.example/mcp", disabled: true } } }));
put(join(home, ".config", "zed", "settings.json"), `{ "context_servers": { "postgres": { "command": { "path": "uvx", "args": ["mcp-server-postgres"], "env": { "DATABASE_URL": "postgres://u:pw@db/x" } } } } }`);
put(join(home, ".cursor", "broken", "x"), "");
const opts = { home, cwd, platform: "linux" as NodeJS.Platform, env: {} as NodeJS.ProcessEnv };

test("finds the servers of every agent, in each host's spelling, and skips disabled ones", () => {
  const { servers, skipped } = scan(opts);
  expect(skipped).toEqual([]);
  expect(servers.map((s) => `${s.host}:${s.name}`).sort()).toEqual([
    "claude-code:files", "claude-code:github", "claude-code:keyed", "claude-code:linear", "claude-code:unbrowse",
    "codex:docs", "codex:notion", "cursor:linear", "cursor:sentry", "vscode:playwright", "windsurf:stripe", "zed:postgres",
  ]);
  const by = Object.fromEntries(servers.map((s) => [`${s.host}:${s.name}`, s]));
  expect(by["claude-code:unbrowse"]!.self).toBe(true);
  expect(by["windsurf:stripe"]!.url).toBe("https://mcp.stripe.com");
  expect(by["cursor:sentry"]!.command).toBe("npx");
  expect(by["zed:postgres"]!.command).toBe("uvx");
  expect(by["codex:docs"]!.headerNames).toEqual(["X-Api-Key"]);
  expect(by["claude-code:github"]!.envNames).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
});

test("nothing found is ever a secret value: listed by name, and what goes to Unbrowse drops secret-looking args", () => {
  const { servers } = scan(opts);
  const dump = JSON.stringify(servers);
  for (const v of [SECRET, KEY, "postgres://u:pw@db/x"]) expect(dump).not.toContain(v);
  const sent = JSON.stringify(unique(servers.filter((s) => !s.self)).map(toImport));
  for (const v of [SECRET, KEY, "/home/me", "--token"]) expect(sent).not.toContain(v);
  expect(toImport(servers.find((s) => s.name === "github")!)).toEqual({ name: "github", command: "npx", args: ["@modelcontextprotocol/server-github"] });
  expect(toImport(servers.find((s) => s.name === "sentry")!)).toEqual({ name: "sentry", command: "npx", args: ["mcp-remote", "https://mcp.sentry.dev/sse"] });
});

test("the same server in two agents is imported once; a key is read only from a real header value", () => {
  const { servers } = scan(opts);
  expect(unique(servers).filter((s) => s.url === "https://mcp.linear.app/mcp")).toHaveLength(1);
  const keyed = servers.find((s) => s.name === "keyed")!;
  expect(keyOf(keyed, rawEntry(keyed, opts)!)).toEqual({ header: "authorization", key: `Bearer ${KEY}` });
  const docs = servers.find((s) => s.name === "docs")!;
  expect(keyOf(docs, rawEntry(docs, opts)!)).toEqual({ header: "x-api-key", key: KEY });
  expect(keyOf(normalize("x", "f", "e", { url: "https://e.example", headers: { Authorization: "Bearer ${TOKEN}" } }), { url: "https://e.example", headers: { Authorization: "Bearer ${TOKEN}" } })).toBeUndefined();
});

test("JSONC and the Codex TOML subset parse", () => {
  expect(parseJsonc('{ "a": "x // not a comment", /* c */ "b": [1,], }')).toEqual({ a: "x // not a comment", b: [1] });
  expect(parseCodexToml('[mcp_servers.a]\ncommand = "npx" # run it\nargs = ["-y", "pkg"]\nenabled = false\n')).toEqual({ a: { command: "npx", args: ["-y", "pkg"], enabled: false } });
});

// ---- the command, against a stand-in API
const seen: { path: string; body: any }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/api\/v1\//, "");
    const body = req.method === "POST" ? await req.json() : null;
    seen.push({ path, body });
    if (path === "connectors/import") return Response.json({ results: body.servers.map((s: any) => ({ name: s.name, status: body.dryRun ? "planned" : s.url ? "connected" : "sign_in", note: "ok", ...(s.url ? {} : { url: "https://unbrowse.ai/connect/x" }) })) });
    if (path === "connectors/connect") return Response.json({ status: "connected", app: `custom-${body.name}`, name: body.name, tools: 2 });
    return Response.json({ error: { code: "not_found", message: path } }, { status: 404 });
  },
});
const env = { ...process.env };
const out: string[] = [];
const err: string[] = [];
const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s), open: () => {}, interactive: false };
beforeAll(() => {
  process.env.HOME = home;
  process.env.UNBROWSE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "mcps-cfg-"));
  process.env.UNBROWSE_API_KEY = "ub_live_test";
  process.chdir(cwd);
});
afterAll(() => {
  server.stop(true);
  process.env = env;
});
beforeEach(() => ((seen.length = 0), (out.length = 0), (err.length = 0)));
const cli = (...a: string[]) => main([...a, "--base-url", `http://localhost:${server.port}`], io as never);

test("mcps lists them by agent with secret names only, and needs no account", async () => {
  delete process.env.UNBROWSE_API_KEY;
  expect(await cli("mcps")).toBe(0);
  process.env.UNBROWSE_API_KEY = "ub_live_test";
  const text = out.join("\n");
  expect(text).toContain("claude-code  ~/.claude.json");
  expect(text).toContain("(env GITHUB_PERSONAL_ACCESS_TOKEN)");
  expect(text).toContain("(Unbrowse itself)");
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(KEY);
  expect(seen).toEqual([]);
});

test("mcps import sends names, addresses and package names only; --dry-run connects nothing", async () => {
  expect(await cli("mcps", "import", "--dry-run", "--json")).toBe(0);
  expect(seen.map((s) => s.path)).toEqual(["connectors/import"]);
  expect(seen[0]!.body.dryRun).toBe(true);
  const names = seen[0]!.body.servers.map((s: any) => s.name);
  expect(names).not.toContain("unbrowse");
  expect(names.filter((n: string) => n === "linear")).toHaveLength(1);
  const wire = JSON.stringify(seen);
  for (const v of [SECRET, KEY]) expect(wire).not.toContain(v);
});

test("--with-keys needs --yes without a terminal; with it, the key goes only to connectors/connect for that server", async () => {
  expect(await cli("mcps", "import", "keyed", "--with-keys")).toBe(1);
  expect(err.join("\n")).toContain("--yes");
  expect(seen).toEqual([]);
  expect(await cli("mcps", "import", "keyed", "docs", "--with-keys", "--yes")).toBe(0);
  expect(seen.map((s) => s.path)).toEqual(["connectors/connect", "connectors/connect"]);
  expect(seen[0]!.body).toEqual({ url: "https://keyed.example/mcp", name: "keyed", transport: "streamable-http", header: "authorization", key: `Bearer ${KEY}` });
  expect(out.join("\n")).not.toContain(KEY);
});

test("a name that is not configured is a usage error", async () => {
  expect(await cli("mcps", "import", "nope")).toBe(1);
  expect(err.join("\n")).toContain("no MCP server named nope");
});
