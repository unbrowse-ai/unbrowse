import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  INSTALL_CMD_CLAUDE,
  INSTALL_CMD_CODEX,
  INSTALL_CMD_GENERIC,
  UPGRADE_CMD_GENERIC,
} from "../frontend/src/lib/install-command";

const ROOT = path.resolve(import.meta.dir, "..");

describe("bootstrap install flow", () => {
  it("publishes deterministic clone-and-setup commands", () => {
    expect(INSTALL_CMD_GENERIC).toContain("git clone --single-branch --depth 1");
    expect(INSTALL_CMD_GENERIC).toContain("./setup --host off");
    expect(INSTALL_CMD_CODEX).toContain("./setup --host codex");
    expect(INSTALL_CMD_CLAUDE).toContain("./setup --host claude");
    expect(UPGRADE_CMD_GENERIC).toContain("git pull --ff-only");
  });

  it("ships a repo bootstrap script that builds the packaged runtime and installs a shim", () => {
    const script = readFileSync(path.join(ROOT, "setup"), "utf8");

    expect(script).toContain("packages/skill/scripts/prepare-pack.mjs");
    expect(script).toContain("packages/skill/bin/unbrowse-wrapper.mjs");
    expect(script).toContain('CODEX_HOME_DIR/skills/unbrowse');
    expect(script).toContain('$HOME/.claude/skills/unbrowse');
    expect(script).toContain("--accept-tos");
    expect(script).toContain("--agent-email");
    expect(script).toContain("UNBROWSE_TOS_ACCEPTED=1");
    expect(script).toContain("UNBROWSE_AGENT_EMAIL");
    expect(script).toContain("UNBROWSE_SKIP_WALLET_SETUP=1");
  });
});
