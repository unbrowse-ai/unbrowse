import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  INSTALL_CMD_CLAUDE,
  INSTALL_CMD_CODEX,
  INSTALL_CMD_GENERIC,
  INSTALL_CMD_MCP,
  MCP_CONFIG_JSON,
  MCP_CONFIG_PATH,
  UPGRADE_CMD_GENERIC,
  UPGRADE_CMD_MCP,
} from "../frontend/src/lib/install-command";

const ROOT = path.resolve(import.meta.dir, "..");

describe("bootstrap install flow", () => {
  it("publishes deterministic clone-and-setup commands", () => {
    expect(INSTALL_CMD_GENERIC).toContain("git clone --single-branch --depth 1");
    expect(INSTALL_CMD_GENERIC).toContain("./setup --host off");
    expect(INSTALL_CMD_MCP).toContain("./setup --host mcp");
    expect(INSTALL_CMD_CODEX).toContain("./setup --host codex");
    expect(INSTALL_CMD_CLAUDE).toContain("./setup --host claude");
    expect(UPGRADE_CMD_GENERIC).toContain("git pull --ff-only");
    expect(UPGRADE_CMD_MCP).toContain("./setup --host mcp");
    expect(MCP_CONFIG_PATH).toContain("unbrowse/mcp/unbrowse.json");
    expect(MCP_CONFIG_JSON).toContain("\"mcpServers\"");
    expect(MCP_CONFIG_JSON).toContain("\"command\": \"unbrowse\"");
    expect(MCP_CONFIG_JSON).toContain("\"args\": [");
    expect(MCP_CONFIG_JSON).toContain("\"mcp\"");
  });

  it("ships a repo bootstrap script that builds the packaged runtime and installs a shim", () => {
    const script = readFileSync(path.join(ROOT, "setup"), "utf8");

    expect(script).toContain("packages/skill/scripts/prepare-pack.mjs");
    expect(script).toContain("packages/skill/bin/unbrowse-wrapper.mjs");
    expect(script).toContain('CODEX_HOME_DIR/skills/unbrowse');
    expect(script).toContain('$HOME/.claude/skills/unbrowse');
    expect(script).toContain("auto|codex|claude|mcp|off");
    expect(script).toContain('MCP_CONFIG_DIR="$(resolve_config_home)/unbrowse/mcp"');
    expect(script).toContain('log "wrote MCP config: $MCP_CONFIG_PATH"');
    expect(script).toContain('"args": ["mcp"]');
    expect(script).toContain("--accept-tos");
    expect(script).toContain("--agent-email");
    expect(script).toContain("UNBROWSE_TOS_ACCEPTED=1");
    expect(script).toContain("UNBROWSE_AGENT_EMAIL");
    expect(script).toContain("UNBROWSE_SKIP_WALLET_SETUP=1");
  });

  it("ships a standalone skill bootstrap script for the public repo clone path", () => {
    const script = readFileSync(path.join(ROOT, "packages", "skill", "setup"), "utf8");

    expect(script).toContain("node scripts/prepare-pack.mjs");
    expect(script).toContain('exec node "$ROOT_DIR/bin/unbrowse-wrapper.mjs"');
    expect(script).toContain('CODEX_HOME_DIR/skills/unbrowse');
    expect(script).toContain('$HOME/.claude/skills/unbrowse');
    expect(script).toContain("auto|codex|claude|mcp|off");
    expect(script).toContain('MCP_CONFIG_DIR="$(resolve_config_home)/unbrowse/mcp"');
    expect(script).toContain('log "wrote MCP config: $MCP_CONFIG_PATH"');
    expect(script).toContain('"args": ["mcp"]');
    expect(script).toContain("--accept-tos");
    expect(script).toContain("--agent-email");
    expect(script).toContain("UNBROWSE_TOS_ACCEPTED=1");
    expect(script).toContain("UNBROWSE_AGENT_EMAIL");
    expect(script).toContain("UNBROWSE_SKIP_WALLET_SETUP=1");
  });
});
