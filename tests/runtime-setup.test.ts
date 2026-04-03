import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findKuriBinary } from "../src/kuri/client.js";
import { runSetup } from "../src/runtime/setup.js";

const tmpDirs: string[] = [];
const originalPackageRoot = process.env.UNBROWSE_PACKAGE_ROOT;
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalSkipWalletSetup = process.env.UNBROWSE_SKIP_WALLET_SETUP;
const originalCodexHome = process.env.CODEX_HOME;

function isolateSetupEnv(homeDir: string): void {
  process.env.HOME = homeDir;
  process.env.CODEX_HOME = path.join(homeDir, ".codex");
  process.env.PATH = "/usr/bin:/bin";
  process.env.UNBROWSE_SKIP_WALLET_SETUP = "1";
}

afterEach(() => {
  if (originalPackageRoot === undefined) delete process.env.UNBROWSE_PACKAGE_ROOT;
  else process.env.UNBROWSE_PACKAGE_ROOT = originalPackageRoot;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalSkipWalletSetup === undefined) delete process.env.UNBROWSE_SKIP_WALLET_SETUP;
  else process.env.UNBROWSE_SKIP_WALLET_SETUP = originalSkipWalletSetup;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime setup", () => {
  it("installs an Open Code project command file with strict Unbrowse-only guidance", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "unbrowse-setup-"));
    tmpDirs.push(cwd);
    isolateSetupEnv(cwd);
    mkdirSync(path.join(cwd, ".codex"), { recursive: true });
    mkdirSync(path.join(cwd, ".claude"), { recursive: true });

    const report = await runSetup({
      cwd,
      opencode: "project",
      installBrowser: false,
    });

    const commandPath = path.join(cwd, ".opencode", "commands", "unbrowse.md");
    expect(report.browser_engine.action).toBe("skipped");
    expect(report.opencode.action).toBe("installed");
    expect(report.opencode.command_file).toBe(commandPath);
    expect(readFileSync(commandPath, "utf8")).toContain("Do not use Brave Search");
    expect(readFileSync(commandPath, "utf8")).toContain("only allowed tool for website access");
    const codexConfig = path.join(cwd, ".codex", "config.toml");
    const claudeSettings = path.join(cwd, ".claude", "settings.json");
    expect(readFileSync(codexConfig, "utf8")).toContain('event = "SessionStart"');
    expect(readFileSync(codexConfig, "utf8")).toContain("unbrowse-update-hint.mjs");
    expect(readFileSync(codexConfig, "utf8")).toContain("codex_hooks = true");
    expect(readFileSync(claudeSettings, "utf8")).toContain("unbrowse-update-hint.mjs");
    expect(report.update_hints.some((hook) => hook.host === "codex" && hook.action === "installed")).toBe(true);
    expect(report.update_hints.some((hook) => hook.host === "claude" && hook.action === "installed")).toBe(true);
  });

  it("treats a packaged Kuri binary as already installed", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "unbrowse-setup-bin-"));
    tmpDirs.push(cwd);
    isolateSetupEnv(cwd);
    process.env.UNBROWSE_PACKAGE_ROOT = cwd;

    const target = process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : process.platform === "darwin" && process.arch === "x64"
        ? "darwin-x64"
        : process.platform === "linux" && process.arch === "arm64"
          ? "linux-arm64"
          : process.platform === "linux" && process.arch === "x64"
            ? "linux-x64"
            : null;

    if (!target) return;

    const binaryPath = path.join(cwd, "vendor", "kuri", target, process.platform === "win32" ? "kuri.exe" : "kuri");
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);

    const report = await runSetup({
      cwd,
      opencode: "off",
    });

    expect(report.browser_engine.action).toBe("already-installed");
    expect(report.browser_engine.installed).toBe(true);
  });

  it("finds the vendored package binary from a monorepo checkout", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "unbrowse-setup-monorepo-bin-"));
    tmpDirs.push(cwd);
    isolateSetupEnv(cwd);
    process.env.UNBROWSE_PACKAGE_ROOT = cwd;

    const target = process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : process.platform === "darwin" && process.arch === "x64"
        ? "darwin-x64"
        : process.platform === "linux" && process.arch === "arm64"
          ? "linux-arm64"
          : process.platform === "linux" && process.arch === "x64"
            ? "linux-x64"
            : null;

    if (!target) return;

    const binaryPath = path.join(cwd, "packages", "skill", "vendor", "kuri", target, process.platform === "win32" ? "kuri.exe" : "kuri");
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);

    expect(findKuriBinary()).toBe(binaryPath);

    const report = await runSetup({
      cwd,
      opencode: "off",
    });

    expect(report.browser_engine.action).toBe("already-installed");
    expect(report.browser_engine.installed).toBe(true);
  });

  it("encourages Crossmint lobster.cash when no wallet is configured", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "unbrowse-setup-wallet-"));
    tmpDirs.push(cwd);
    isolateSetupEnv(cwd);

    const report = await runSetup({
      cwd,
      opencode: "off",
      installBrowser: false,
    });

    expect(report.wallet.configured).toBe(false);
    expect(report.wallet.message).toContain("Crossmint lobster.cash");
    expect(report.wallet.install_hint).toBe("npx @crossmint/lobster-cli setup");
  });
});
