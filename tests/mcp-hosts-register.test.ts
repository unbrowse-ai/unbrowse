import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { registerMcpHosts } from "../src/setup/mcp-hosts-register";

// Each test uses a fresh isolated $HOME under tmpdir so we never touch real
// editor configs. The functions read homeDir, so passing it scoped per call
// is safe.

let HOME: string;

beforeEach(() => {
  HOME = mkdtempSync(join(tmpdir(), "unbrowse-mcp-hosts-"));
});

afterEach(() => {
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
});

const SERVER = { serverCommand: "npx", serverArgs: ["-y", "unbrowse", "mcp"] };

function claudeDesktopPath(home: string): string {
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform() === "win32") return join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

describe("registerMcpHosts", () => {
  test("reports not_detected when no host configs exist", () => {
    const results = registerMcpHosts({ ...SERVER, homeDir: HOME });
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.action).toBe("not_detected");
    }
  });

  test("merges into existing Claude Desktop config without clobbering other servers", () => {
    const cfg = claudeDesktopPath(HOME);
    mkdirSync(join(cfg, ".."), { recursive: true });
    writeFileSync(cfg, JSON.stringify({
      mcpServers: {
        someOtherServer: { command: "node", args: ["other.js"] },
      },
    }, null, 2));

    const results = registerMcpHosts({ ...SERVER, homeDir: HOME, hosts: ["claude-desktop"] });
    expect(results[0].action).toBe("merged");
    const written = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(written.mcpServers.someOtherServer.command).toBe("node");
    expect(written.mcpServers.unbrowse.command).toBe("npx");
    expect(written.mcpServers.unbrowse.args).toEqual(["-y", "unbrowse", "mcp"]);
  });

  test("is idempotent — re-running on an already-merged config reports already_present", () => {
    const cfg = claudeDesktopPath(HOME);
    mkdirSync(join(cfg, ".."), { recursive: true });
    writeFileSync(cfg, "{}");

    const first = registerMcpHosts({ ...SERVER, homeDir: HOME, hosts: ["claude-desktop"] });
    expect(first[0].action).toBe("merged");
    const second = registerMcpHosts({ ...SERVER, homeDir: HOME, hosts: ["claude-desktop"] });
    expect(second[0].action).toBe("already_present");
  });

  test("Cursor: merges into ~/.cursor/mcp.json", () => {
    const cfg = join(HOME, ".cursor", "mcp.json");
    mkdirSync(join(HOME, ".cursor"), { recursive: true });
    writeFileSync(cfg, "{}");
    const results = registerMcpHosts({ ...SERVER, homeDir: HOME, hosts: ["cursor"] });
    expect(results[0].action).toBe("merged");
    const written = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(written.mcpServers.unbrowse.command).toBe("npx");
  });

  test("Codex: appends [mcp_servers.unbrowse] stanza to TOML without parsing existing entries", () => {
    const cfg = join(HOME, ".codex", "config.toml");
    mkdirSync(join(HOME, ".codex"), { recursive: true });
    writeFileSync(cfg, `# user codex config\nmodel = "gpt-5"\n\n[mcp_servers.someOtherServer]\ncommand = "node"\n`);
    const results = registerMcpHosts({ ...SERVER, homeDir: HOME, hosts: ["codex"] });
    expect(results[0].action).toBe("merged");
    const body = readFileSync(cfg, "utf-8");
    expect(body).toContain("[mcp_servers.someOtherServer]");
    expect(body).toContain("[mcp_servers.unbrowse]");
    expect(body).toContain('command = "npx"');
    expect(body).toContain('args = ["-y", "unbrowse", "mcp"]');
  });

  test("Codex idempotency: existing [mcp_servers.unbrowse] stanza is left untouched", () => {
    const cfg = join(HOME, ".codex", "config.toml");
    mkdirSync(join(HOME, ".codex"), { recursive: true });
    const original = `[mcp_servers.unbrowse]\ncommand = "custom-binary"\nargs = ["--custom"]\n`;
    writeFileSync(cfg, original);
    const results = registerMcpHosts({ ...SERVER, homeDir: HOME, hosts: ["codex"] });
    expect(results[0].action).toBe("already_present");
    expect(readFileSync(cfg, "utf-8")).toBe(original);
  });

  test("Continue: writes into experimental.modelContextProtocolServers array", () => {
    const cfg = join(HOME, ".continue", "config.json");
    mkdirSync(join(HOME, ".continue"), { recursive: true });
    writeFileSync(cfg, JSON.stringify({
      experimental: {
        modelContextProtocolServers: [
          { name: "other", transport: { type: "stdio", command: "x", args: [] } },
        ],
      },
    }, null, 2));
    const results = registerMcpHosts({ ...SERVER, homeDir: HOME, hosts: ["continue"] });
    expect(results[0].action).toBe("merged");
    const written = JSON.parse(readFileSync(cfg, "utf-8"));
    const names = (written.experimental.modelContextProtocolServers as Array<{ name: string }>).map((s) => s.name);
    expect(names).toContain("other");
    expect(names).toContain("unbrowse");
  });

  test("Windsurf: merges into ~/.codeium/windsurf/mcp_config.json", () => {
    const cfg = join(HOME, ".codeium", "windsurf", "mcp_config.json");
    mkdirSync(join(HOME, ".codeium", "windsurf"), { recursive: true });
    writeFileSync(cfg, "{}");
    const results = registerMcpHosts({ ...SERVER, homeDir: HOME, hosts: ["windsurf"] });
    expect(results[0].action).toBe("merged");
    expect(JSON.parse(readFileSync(cfg, "utf-8")).mcpServers.unbrowse.command).toBe("npx");
  });

  test("parse_error: malformed JSON config is backed up and reported, not overwritten", () => {
    const cfg = join(HOME, ".cursor", "mcp.json");
    mkdirSync(join(HOME, ".cursor"), { recursive: true });
    writeFileSync(cfg, "{ this is not json");
    const results = registerMcpHosts({ ...SERVER, homeDir: HOME, hosts: ["cursor"] });
    expect(results[0].action).toBe("parse_error");
    // Original file untouched (the backup is a separate file we don't assert on).
    expect(readFileSync(cfg, "utf-8")).toBe("{ this is not json");
  });

  test("explicit skip list reports skipped without writing", () => {
    const cfg = join(HOME, ".cursor", "mcp.json");
    mkdirSync(join(HOME, ".cursor"), { recursive: true });
    writeFileSync(cfg, "{}");
    const results = registerMcpHosts({ ...SERVER, homeDir: HOME, hosts: ["cursor"], skip: ["cursor"] });
    expect(results[0].action).toBe("skipped");
    expect(readFileSync(cfg, "utf-8")).toBe("{}");
  });
});
