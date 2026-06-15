import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildUpgradeCommand, checkForUpdates, configureUpdateHintHooks, getInstalledVersion, saveInstallSource } from "../src/runtime/update-hints.js";

const tmpDirs: string[] = [];
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;
const originalConfigDir = process.env.UNBROWSE_CONFIG_DIR;
const originalSetupMethod = process.env.UNBROWSE_SETUP_METHOD;
const originalSetupHost = process.env.UNBROWSE_SETUP_HOST;
const originalSetupRoot = process.env.UNBROWSE_SETUP_ROOT;
const originalFetch = global.fetch;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
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

  it("repairs malformed Codex hook tables created by setup", () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-codex-hooks-"));
    tmpDirs.push(homeDir);
    const codexHome = path.join(homeDir, ".codex");
    mkdirSync(codexHome, { recursive: true });
    process.env.HOME = homeDir;
    process.env.CODEX_HOME = codexHome;
    process.env.UNBROWSE_CONFIG_DIR = path.join(homeDir, ".unbrowse");
    process.env.UNBROWSE_SETUP_HOST = "codex";

    const configPath = path.join(codexHome, "config.toml");
    writeFileSync(configPath, [
      "[features]",
      "codex_hooks = true",
      "",
      "# Unbrowse update hints — managed by unbrowse setup",
      "[[hooks]]",
      "event = \"SessionStart\"",
      "command = \"node \\\"/tmp/unbrowse-update-hint.mjs\\\"\"",
      "",
    ].join("\n"), "utf8");

    const [status] = configureUpdateHintHooks(import.meta.url, {
      method: "repo-clone",
      host: "codex",
      package_root: path.dirname(import.meta.path),
      recorded_at: new Date().toISOString(),
    });

    expect(status.action).toBe("updated");
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("# Unbrowse update hints — managed by unbrowse setup\n[hooks]\n");
    expect(config).not.toContain("\n[[hooks]]\nevent = \"SessionStart\"");
    expect(config).not.toContain("\n[[hooks]\n");
  });

  it("writes the Codex update hook as a single hooks table", () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-codex-hooks-fresh-"));
    tmpDirs.push(homeDir);
    const codexHome = path.join(homeDir, ".codex");
    mkdirSync(codexHome, { recursive: true });
    process.env.HOME = homeDir;
    process.env.CODEX_HOME = codexHome;
    process.env.UNBROWSE_CONFIG_DIR = path.join(homeDir, ".unbrowse");
    process.env.UNBROWSE_SETUP_HOST = "codex";

    const [status] = configureUpdateHintHooks(import.meta.url, {
      method: "repo-clone",
      host: "codex",
      package_root: path.dirname(import.meta.path),
      recorded_at: new Date().toISOString(),
    });

    expect(status.action).toBe("installed");
    const config = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("[features]\ncodex_hooks = true\n");
    expect(config).toContain("# Unbrowse update hints — managed by unbrowse setup\n[hooks]\n");
    expect(config).not.toContain("[[hooks]]");
  });

  it("reads the real version past a version-less runtime/package.json stub", () => {
    // Reproduce the shipped layout: <pkg>/package.json carries the version, but
    // the runtime bundle sits under <pkg>/runtime/ next to a stub package.json
    // ({"type":"module"}, no version). getInstalledVersion must walk past the stub
    // and return the real version — not "unknown" (which made the updater think it
    // was perpetually behind and reinstall every interval).
    const pkgRoot = mkdtempSync(path.join(os.tmpdir(), "unbrowse-ver-"));
    tmpDirs.push(pkgRoot);
    writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "unbrowse", version: "9.9.9" }));
    const runtimeDir = path.join(pkgRoot, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(path.join(runtimeDir, "package.json"), JSON.stringify({ type: "module" }));
    const runtimeEntry = path.join(runtimeDir, "cli.js");
    writeFileSync(runtimeEntry, "// bundle");

    const version = getInstalledVersion(pathToFileURL(runtimeEntry).href);
    expect(version).toBe("9.9.9");
  });
});
