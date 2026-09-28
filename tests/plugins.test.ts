// Host plugins that are configuration plus shell hooks: Claude Code, Codex, Grok Build.
// The code plugins (OpenClaw, Hermes, elizaOS) carry their own tests under plugins/<host>/tests.
import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const json = (p: string) => JSON.parse(read(p));

/** Run a hook script with a JSON event on stdin; returns parsed stdout (or null when it printed nothing). */
function hook(script: string, event: object, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync("sh", [join(root, script), ...args], { input: JSON.stringify(event), env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const decision = (out: { hookSpecificOutput?: { permissionDecision?: string } } | null) => out?.hookSpecificOutput?.permissionDecision ?? "allow";

const REDIRECTS = ["plugins/claude-code/scripts/redirect.sh", "plugins/codex/scripts/redirect.sh", "plugins/grok-build/scripts/redirect.sh"];

test("skill copies and shared hook scripts match their sources", () => {
  const out = execFileSync("node", ["scripts/sync-plugins.mjs", "--check"], { cwd: root, encoding: "utf8" });
  expect(out).toContain("PLUGIN_SKILLS_OK");
});

test("every plugin version matches the CLI package", () => {
  const { version, mcpName } = json("packages/cli/package.json");
  const server = json("server.json");
  expect(json("gemini-extension.json")).toMatchObject({ name: "unbrowse", version, mcpServers: { unbrowse: { httpUrl: "https://unbrowse.ai/mcp" } } });
  expect(server).toMatchObject({ name: mcpName, version, packages: [{ identifier: "unbrowse", version }], remotes: [{ url: "https://unbrowse.ai/mcp" }] });
  expect(json("plugins/claude-code/.claude-plugin/plugin.json").version).toBe(version);
  expect(json("plugins/codex/.codex-plugin/plugin.json").version).toBe(version);
  expect(json("plugins/grok-build/.grok-plugin/plugin.json").version).toBe(version);
  expect(json("plugins/grok-build/.mcp.json").mcpServers.unbrowse.args).toContain(`unbrowse@${version}`);
  expect(json("plugins/openclaw/package.json").version).toBe(version);
  expect(json("plugins/openclaw/openclaw.plugin.json").version).toBe(version);
  expect(json("plugins/elizaos/package.json").version).toBe(version);
  expect(read("plugins/hermes/plugin.yaml")).toContain(`version: ${version}`);
  expect(read("plugins/hermes/pypi/pyproject.toml")).toContain(`version = "${version}"`);
});

test("marketplaces point at existing plugin roots", () => {
  const claude = json(".claude-plugin/marketplace.json");
  expect(claude.plugins[0]).toMatchObject({ name: "unbrowse", source: "./plugins/claude-code" });
  expect(existsSync(join(root, "plugins/claude-code/.claude-plugin/plugin.json"))).toBe(true);
  const codex = json(".agents/plugins/marketplace.json");
  expect(codex.plugins[0].source).toEqual({ source: "local", path: "./plugins/codex" });
  expect(existsSync(join(root, "plugins/codex/.codex-plugin/plugin.json"))).toBe(true);
  const grok = json(".grok-plugin/marketplace.json");
  expect(grok.plugins[0].source).toEqual({ type: "local", path: "./plugins/grok-build" });
  expect(existsSync(join(root, "plugins/grok-build/.grok-plugin/plugin.json"))).toBe(true);
});

test("MCP configs: Claude Code http + headersHelper, Codex streamable-http, Grok stdio proxy", () => {
  expect(json("plugins/claude-code/.mcp.json").mcpServers.unbrowse).toMatchObject({ type: "http", headersHelper: "${CLAUDE_PLUGIN_ROOT}/scripts/headers.sh" });
  expect(json("plugins/codex/.mcp.json").mcpServers.unbrowse).toEqual({ type: "streamable-http", url: "https://unbrowse.ai/mcp" });
  expect(json("plugins/grok-build/.mcp.json").mcpServers.unbrowse).toMatchObject({ type: "stdio", command: "npx" });
});

test("hook manifests reference scripts that exist", () => {
  for (const [file, rootVar] of [["plugins/claude-code/hooks/hooks.json", "${CLAUDE_PLUGIN_ROOT}"], ["plugins/codex/hooks/hooks.json", "$PLUGIN_ROOT"], ["plugins/grok-build/hooks/hooks.json", "${GROK_PLUGIN_ROOT}"]] as const) {
    const hooks = json(file).hooks as Record<string, { hooks: { command: string }[] }[]>;
    for (const group of Object.values(hooks).flat()) for (const h of group.hooks) {
      expect(h.command).toContain(rootVar);
      const script = h.command.match(/\/(scripts\/[a-z-]+\.sh)/)![1];
      expect(existsSync(join(root, file.split("/").slice(0, 2).join("/"), script))).toBe(true);
    }
  }
});

test("redirect denies built-in web tools, browser MCPs and remote agent-browser; allows local and unrelated calls", () => {
  for (const script of REDIRECTS) {
    expect(decision(hook(script, { tool_name: "WebFetch", tool_input: { url: "https://example.com", prompt: "x" } }))).toBe("deny");
    expect(decision(hook(script, { tool_name: "WebSearch", tool_input: { query: "x" } }))).toBe("deny");
    expect(decision(hook(script, { tool_name: "mcp__playwright__browser_navigate", tool_input: { url: "https://x.com" } }))).toBe("deny");
    expect(decision(hook(script, { tool_name: "Bash", tool_input: { command: "agent-browser open https://news.ycombinator.com && agent-browser snapshot" } }))).toBe("deny");
    // Grok's camelCase event and tool names
    expect(decision(hook(script, { hookEventName: "pre_tool_use", toolName: "web_fetch", toolInput: { url: "https://a.test" } }))).toBe("deny");
    expect(decision(hook(script, { toolName: "web_search", toolInput: { query: "x" } }))).toBe("deny");
    expect(decision(hook(script, { toolName: "run_terminal_command", toolInput: { command: "agent-browser goto https://a.test" } }))).toBe("deny");

    expect(decision(hook(script, { tool_name: "WebFetch", tool_input: { url: "http://localhost:8080/" } }))).toBe("allow");
    expect(decision(hook(script, { tool_name: "Bash", tool_input: { command: "agent-browser open http://127.0.0.1:8080" } }))).toBe("allow");
    expect(decision(hook(script, { tool_name: "Bash", tool_input: { command: "agent-browser click @e3" } }))).toBe("allow");
    expect(decision(hook(script, { tool_name: "Bash", tool_input: { command: "ls -la" } }))).toBe("allow");
    expect(decision(hook(script, { toolName: "run_terminal_command", toolInput: { command: "npm test" } }))).toBe("allow");
  }
});

test("redirect reason names the host's Unbrowse tool and the opt-out; opt-out allows everything", () => {
  const claude = hook(REDIRECTS[0], { tool_name: "WebFetch", tool_input: { url: "https://a.test" } });
  expect(claude.hookSpecificOutput.permissionDecisionReason).toContain("mcp__plugin_unbrowse_unbrowse__unbrowse_scrape");
  const grok = hook(REDIRECTS[2], { toolName: "web_fetch", toolInput: { url: "https://a.test" } }, ["unbrowse__unbrowse_"]);
  expect(grok.hookSpecificOutput.permissionDecisionReason).toContain("unbrowse__unbrowse_scrape");
  expect(grok.hookSpecificOutput.permissionDecisionReason).toContain("UNBROWSE_ALLOW_BUILTIN_BROWSER=1");
  expect(hook(REDIRECTS[0], { tool_name: "WebSearch" }, [], { UNBROWSE_ALLOW_BUILTIN_BROWSER: "1" })).toBeNull();
});

test("session hook emits SessionStart context with the host's tool prefix", () => {
  for (const [script, prefix] of [["plugins/claude-code/scripts/session.sh", "mcp__plugin_unbrowse_unbrowse__unbrowse_"], ["plugins/codex/scripts/session.sh", "mcp__unbrowse__unbrowse_"]] as const) {
    const out = hook(script, {}, prefix === "mcp__unbrowse__unbrowse_" ? [prefix] : []);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain(`${prefix}scrape`);
  }
});

test("Claude Code headers helper: env key, then the CLI's saved key, else no headers (OAuth)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ub-hdr-"));
  const run = (env: Record<string, string>) => JSON.parse(execFileSync("sh", [join(root, "plugins/claude-code/scripts/headers.sh")], { env: { PATH: process.env.PATH!, HOME: dir, ...env }, encoding: "utf8" }));
  expect(run({})).toEqual({});
  expect(run({ UNBROWSE_API_KEY: "ub_live_env" })).toEqual({ Authorization: "Bearer ub_live_env" });
  writeFileSync(join(dir, "cli.json"), JSON.stringify({ baseUrl: "https://unbrowse.ai", apiKey: "ub_live_saved" }, null, 2));
  expect(run({ UNBROWSE_CONFIG_DIR: dir })).toEqual({ Authorization: "Bearer ub_live_saved" });
  expect(run({ UNBROWSE_CONFIG_DIR: dir, UNBROWSE_END_USER: "u1" })).toEqual({ Authorization: "Bearer ub_live_saved", "X-Unbrowse-End-User": "u1" });
  writeFileSync(join(dir, "cli.json"), JSON.stringify({ baseUrl: "https://unbrowse.ai", oauth: { accessToken: "x" } }, null, 2));
  expect(run({ UNBROWSE_CONFIG_DIR: dir })).toEqual({}); // an OAuth login for the API is not an MCP credential
});

test("Grok global-hook installer writes and removes ~/.grok/hooks/unbrowse.json", () => {
  const home = mkdtempSync(join(tmpdir(), "ub-grok-"));
  execFileSync("sh", [join(root, "plugins/grok-build/scripts/install-global-hook.sh")], { env: { PATH: process.env.PATH!, GROK_HOME: home } });
  const cfg = JSON.parse(readFileSync(join(home, "hooks/unbrowse.json"), "utf8"));
  expect(cfg.hooks.PreToolUse[0].hooks[0].command).toContain("plugins/grok-build/scripts/redirect.sh");
  execFileSync("sh", [join(root, "plugins/grok-build/scripts/install-global-hook.sh"), "--remove"], { env: { PATH: process.env.PATH!, GROK_HOME: home } });
  expect(existsSync(join(home, "hooks/unbrowse.json"))).toBe(false);
});
