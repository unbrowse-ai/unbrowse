import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("packaged setup does not autoinstall MCP", () => {
  it("rejects the removed mcp host mode and writes no MCP config", () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-no-mcp-installer-"));
    tmpDirs.push(homeDir);

    const res = spawnSync("./setup", [
      "--host",
      "mcp",
      "--no-start",
      "--accept-tos",
      "--agent-email",
      "agent@example.com",
      "--skip-wallet-setup",
      "--non-interactive",
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: path.join(homeDir, ".config"),
        UNBROWSE_BIN_DIR: path.join(homeDir, ".local", "bin"),
      },
      encoding: "utf-8",
      timeout: 30_000,
    });

    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(res.status).not.toBe(0);
    expect(out).not.toContain("wrote MCP config");
    expect(out).not.toContain("mcpServers");

    const configPath = path.join(homeDir, ".config", "unbrowse", "mcp", "unbrowse.json");
    expect(existsSync(configPath)).toBe(false);
  });
});
