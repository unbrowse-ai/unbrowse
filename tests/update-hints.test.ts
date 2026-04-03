import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildUpgradeCommand, checkForUpdates, saveInstallSource } from "../src/runtime/update-hints.js";

const tmpDirs: string[] = [];
const originalHome = process.env.HOME;
const originalConfigDir = process.env.UNBROWSE_CONFIG_DIR;
const originalSetupMethod = process.env.UNBROWSE_SETUP_METHOD;
const originalSetupHost = process.env.UNBROWSE_SETUP_HOST;
const originalSetupRoot = process.env.UNBROWSE_SETUP_ROOT;
const originalFetch = global.fetch;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.UNBROWSE_CONFIG_DIR;
  else process.env.UNBROWSE_CONFIG_DIR = originalConfigDir;
  if (originalSetupMethod === undefined) delete process.env.UNBROWSE_SETUP_METHOD;
  else process.env.UNBROWSE_SETUP_METHOD = originalSetupMethod;
  if (originalSetupHost === undefined) delete process.env.UNBROWSE_SETUP_HOST;
  else process.env.UNBROWSE_SETUP_HOST = originalSetupHost;
  if (originalSetupRoot === undefined) delete process.env.UNBROWSE_SETUP_ROOT;
  else process.env.UNBROWSE_SETUP_ROOT = originalSetupRoot;
  global.fetch = originalFetch;
  mock.restore();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("update hints", () => {
  it("persists repo-clone install metadata and derives the exact upgrade command", () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-update-home-"));
    tmpDirs.push(homeDir);
    process.env.HOME = homeDir;
    process.env.UNBROWSE_CONFIG_DIR = path.join(homeDir, ".unbrowse");
    process.env.UNBROWSE_SETUP_METHOD = "repo-clone";
    process.env.UNBROWSE_SETUP_HOST = "codex";
    process.env.UNBROWSE_SETUP_ROOT = path.join(homeDir, ".codex", "skills", "unbrowse");

    mkdirSync(process.env.UNBROWSE_SETUP_ROOT, { recursive: true });

    const state = saveInstallSource(import.meta.url);
    expect(state.method).toBe("repo-clone");
    expect(state.host).toBe("codex");
    expect(buildUpgradeCommand(state)).toBe(
      `cd ${process.env.UNBROWSE_SETUP_ROOT} && git pull --ff-only && ./setup --host codex`,
    );

    const saved = readFileSync(path.join(process.env.UNBROWSE_CONFIG_DIR, "install-source.json"), "utf8");
    expect(saved).toContain('"host": "codex"');
    expect(saved).toContain('"method": "repo-clone"');
  });

  it("checks npm for newer versions and falls back to the install script for generic installs", async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-update-check-"));
    tmpDirs.push(homeDir);
    process.env.HOME = homeDir;
    process.env.UNBROWSE_CONFIG_DIR = path.join(homeDir, ".unbrowse");
    process.env.UNBROWSE_SETUP_METHOD = "npm-global";
    delete process.env.UNBROWSE_SETUP_HOST;
    delete process.env.UNBROWSE_SETUP_ROOT;

    global.fetch = mock(async () => new Response(JSON.stringify({ version: "9.9.9" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof global.fetch;

    const result = await checkForUpdates(import.meta.url, { force: true });
    expect(result.has_update).toBe(true);
    expect(result.latest).toBe("9.9.9");
    expect(result.command).toBe("curl -fsSL https://unbrowse.ai/install.sh | bash");
  });
});
