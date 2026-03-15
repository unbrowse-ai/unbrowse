import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../src/runtime/setup.js";

const tmpDirs: string[] = [];
const originalPackageRoot = process.env.UNBROWSE_PACKAGE_ROOT;

afterEach(() => {
  if (originalPackageRoot === undefined) delete process.env.UNBROWSE_PACKAGE_ROOT;
  else process.env.UNBROWSE_PACKAGE_ROOT = originalPackageRoot;
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime setup", () => {
  it("installs an Open Code project command file with strict Unbrowse-only guidance", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "unbrowse-setup-"));
    tmpDirs.push(cwd);

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
  });

  it("treats a packaged Kuri binary as already installed", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "unbrowse-setup-bin-"));
    tmpDirs.push(cwd);
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
});
