// `unbrowse setup` (every agent reaches for Unbrowse) and `unbrowse bug` (an Unbrowse failure becomes a report an
// agent can turn into a fix PR). Both run against a temp home and config folder: nothing real is touched.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { hint, isBug, redact, redactArgv } from "../src/bug.ts";
import { RULE_BEGIN, RULE_END, withRule, withoutRule } from "../src/setup.ts";

const config = mkdtempSync(join(tmpdir(), "ub-bug-"));
const saved = { dir: process.env.UNBROWSE_CONFIG_DIR, key: process.env.UNBROWSE_API_KEY };
process.env.UNBROWSE_CONFIG_DIR = config;
afterAll(() => {
  process.env.UNBROWSE_CONFIG_DIR = saved.dir;
  if (saved.key === undefined) delete process.env.UNBROWSE_API_KEY;
  else process.env.UNBROWSE_API_KEY = saved.key;
});

function io(home: string) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  return {
    out,
    err,
    calls,
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), open: () => {}, interactive: false, exec: (cmd: string[]) => (calls.push(cmd), { status: 1, stdout: "", stderr: "" }), service: { home } } as never,
  };
}

function home(...hosts: string[]) {
  const h = mkdtempSync(join(tmpdir(), "ub-home-"));
  for (const d of hosts) mkdirSync(join(h, d), { recursive: true });
  return h;
}

test("setup puts both skills into every installed agent and ~/.agents, and the always-use rule where a host reads one", async () => {
  const h = home(".claude", ".codex", ".cursor", ".config/opencode");
  const t = io(h);
  expect(await main(["setup", "--no-mcp"], t.io)).toBe(0);
  for (const dir of [".claude/skills", ".codex/skills", ".cursor/skills", ".config/opencode/skills", ".agents/skills"]) {
    expect(readFileSync(join(h, dir, "unbrowse/SKILL.md"), "utf8")).toMatch(/^---\nname: unbrowse\n/);
    expect(existsSync(join(h, dir, "unbrowse/references/tools.json"))).toBe(true);
    expect(readFileSync(join(h, dir, "unbrowse-contribute/SKILL.md"), "utf8")).toMatch(/^---\nname: unbrowse-contribute\n/);
  }
  for (const rules of [".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/opencode/AGENTS.md"]) {
    const text = readFileSync(join(h, rules), "utf8");
    expect(text).toContain(RULE_BEGIN);
    expect(text).toContain("Unbrowse is the browser");
    expect(text).toContain("unbrowse-contribute");
  }
  // Not installed here: left alone.
  expect(existsSync(join(h, ".gemini"))).toBe(false);
  expect(existsSync(join(h, ".codeium"))).toBe(false);
  expect(t.err.join("\n")).toContain("Unbrowse is set up for: Claude Code, Codex, Cursor, opencode, shared ~/.agents.");
});

test("setup keeps what the person wrote, is idempotent, and --remove takes back only its own block and skills", async () => {
  const h = home(".codex");
  writeFileSync(join(h, ".codex/AGENTS.md"), "# My rules\n\nBe brief.\n");
  await main(["setup", "--no-mcp"], io(h).io);
  const once = readFileSync(join(h, ".codex/AGENTS.md"), "utf8");
  expect(once.startsWith("# My rules\n\nBe brief.\n\n" + RULE_BEGIN)).toBe(true);
  const again = io(h);
  await main(["setup", "--no-mcp"], again.io);
  expect(readFileSync(join(h, ".codex/AGENTS.md"), "utf8")).toBe(once);
  expect(again.err.join("\n")).toContain("(up to date)");
  expect(once.split(RULE_BEGIN).length).toBe(2);

  expect(await main(["setup", "--remove"], io(h).io)).toBe(0);
  expect(readFileSync(join(h, ".codex/AGENTS.md"), "utf8")).toBe("# My rules\n\nBe brief.\n");
  expect(existsSync(join(h, ".codex/skills/unbrowse"))).toBe(false);
  expect(existsSync(join(h, ".agents/skills/unbrowse-contribute"))).toBe(false);
});

test("setup --dry-run writes nothing; a symlinked skill folder (a dev checkout) is left alone", async () => {
  const h = home(".claude");
  const t = io(h);
  expect(await main(["setup", "--dry-run", "--no-mcp"], t.io)).toBe(0);
  expect(existsSync(join(h, ".claude/skills"))).toBe(false);
  expect(existsSync(join(h, ".claude/CLAUDE.md"))).toBe(false);
  expect(t.err.join("\n")).toContain("would add");

  const mine = mkdtempSync(join(tmpdir(), "ub-dev-"));
  writeFileSync(join(mine, "SKILL.md"), "mine");
  mkdirSync(join(h, ".claude/skills"), { recursive: true });
  symlinkSync(mine, join(h, ".claude/skills/unbrowse"));
  await main(["setup", "--no-mcp", "--no-rules"], io(h).io);
  expect(readFileSync(join(mine, "SKILL.md"), "utf8")).toBe("mine");
  expect(existsSync(join(h, ".claude/CLAUDE.md"))).toBe(false);
});

test("setup with named agents only touches those, and registers the MCP proxy without replacing an existing one", async () => {
  const h = home(".claude", ".codex");
  const t = io(h);
  // `claude mcp get unbrowse` succeeds: a server is already there.
  (t.io as { exec: (c: string[]) => unknown }).exec = (cmd: string[]) => (t.calls.push(cmd), { status: cmd.includes("get") || cmd.includes("--version") ? 0 : 1, stdout: "", stderr: "" });
  expect(await main(["setup", "claude"], t.io)).toBe(0);
  expect(existsSync(join(h, ".claude/skills/unbrowse/SKILL.md"))).toBe(true);
  expect(existsSync(join(h, ".codex/skills"))).toBe(false);
  expect(t.calls.some((c) => c.join(" ").startsWith("claude mcp add"))).toBe(false);
  expect(t.calls.some((c) => c.join(" ").startsWith("codex"))).toBe(false);
  expect(t.err.join("\n")).toContain('"unbrowse" is already registered');
  expect(await main(["setup", "nope"], io(h).io)).toBe(1);
});

test("rule block helpers: replace in place, remove cleanly", () => {
  const block = withRule("");
  expect(block.startsWith(RULE_BEGIN) && block.trimEnd().endsWith(RULE_END)).toBe(true);
  const stale = `top\n\n${RULE_BEGIN}\nold\n${RULE_END}\n\nbottom\n`;
  expect(withRule(stale)).toBe(`top\n\n${withRule("").trimEnd()}\n\nbottom\n`);
  expect(withoutRule(stale)).toBe("top\n\nbottom\n");
  expect(withoutRule("no block\n")).toBe("no block\n");
});

test("redaction masks keys, bearer tokens, JWTs and name=value secrets, and secret flags on the command line", () => {
  const text = redact('Authorization: Bearer abc.def-123 key ub_live_0123456789abcdef {"apiKey":"s3cr3t","password": "hunter2"} token=xyz ghp_abcdefghijklmnop eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig');
  for (const secret of ["abc.def-123", "0123456789abcdef", "s3cr3t", "hunter2", "xyz", "abcdefghijklmnop", "eyJzdWIiOiIxMjM0"]) expect(text).not.toContain(secret);
  const argv = redactArgv(["login", "--key", "ub_live_zzzzzzzz", "--token=abc", "run", "--set", "password=pw1", "--set", "q=hello world", "--url", "https://x.com"]);
  expect(argv).toBe('login --key <redacted> --token=<redacted> run --set password=<redacted> --set "q=hello world" --url https://x.com');
});

test("only crashes and 5xx count as Unbrowse bugs", () => {
  expect(isBug({ name: "TypeError" }, false)).toBe(true);
  expect(isBug({ status: 502 }, false)).toBe(true);
  expect(isBug({ status: 404 }, false)).toBe(false);
  expect(isBug({ status: 401 }, false)).toBe(false);
  expect(isBug({ name: "Error" }, false)).toBe(false); // a message the code meant to give
  expect(isBug({ name: "TypeError" }, true)).toBe(false); // the connection
});

test("a 5xx is recorded (redacted), stderr tells the agent what to do, and `unbrowse bug` turns it into a report", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: { code: "internal", message: "boom for ub_live_leakleakleak" } }, { status: 500 }) });
  try {
    process.env.UNBROWSE_API_KEY = "ub_live_test_secretsecret";
    const t = io(home());
    expect(await main(["whoami", "--base-url", server.url.origin], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain(hint("dev"));
    const file = readFileSync(join(config, "last-error.json"), "utf8");
    expect(file).not.toContain("leakleakleak");
    expect(file).not.toContain("secretsecret");
    expect(JSON.parse(file)).toMatchObject({ status: 500, command: expect.stringContaining("whoami") });

    const json = io(home());
    expect(await main(["whoami", "--json", "--base-url", server.url.origin], json.io)).toBe(1);
    expect(JSON.parse(json.out.join("\n")).error.bug).toEqual({ report: "unbrowse bug", skill: "unbrowse-contribute" });

    const r = io(home());
    expect(await main(["bug", "whoami", "answers", "500"], r.io)).toBe(0);
    const text = r.out.join("\n");
    expect(text).toStartWith("# whoami answers 500");
    expect(text).toContain("unbrowse whoami");
    expect(text).toContain("HTTP 500");
    expect(text).toContain("gh issue list -R unbrowse-ai/unbrowse");
    expect(text).not.toContain("leakleakleak");
  } finally {
    server.stop(true);
    delete process.env.UNBROWSE_API_KEY;
  }
});

test("a 4xx is the request, not a bug: nothing recorded, no bug line", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: { code: "bad_input", message: "nope" } }, { status: 400 }) });
  try {
    process.env.UNBROWSE_API_KEY = "ub_live_test_secretsecret";
    const before = existsSync(join(config, "last-error.json")) ? readFileSync(join(config, "last-error.json"), "utf8") : "";
    const t = io(home());
    expect(await main(["whoami", "--base-url", server.url.origin], t.io)).toBe(1);
    expect(t.err.join("\n")).not.toContain("looks like a bug");
    const after = existsSync(join(config, "last-error.json")) ? readFileSync(join(config, "last-error.json"), "utf8") : "";
    expect(after).toBe(before);
  } finally {
    server.stop(true);
    delete process.env.UNBROWSE_API_KEY;
  }
});

// Other suites point these at temp folders; setup honours them, so each test here starts from the plain home.
const HOST_DIRS = ["XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
const hostDirs = Object.fromEntries(HOST_DIRS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  delete process.env.UNBROWSE_API_KEY;
  for (const k of HOST_DIRS) delete process.env[k];
});
afterAll(() => {
  for (const k of HOST_DIRS) if (hostDirs[k] !== undefined) process.env[k] = hostDirs[k];
});
