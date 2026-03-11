import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../src/runtime/setup.js";

const tmpDirs: string[] = [];

afterEach(() => {
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
});
