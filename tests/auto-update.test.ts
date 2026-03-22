import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareSemver, maybeAutoUpdate } from "../src/runtime/auto-update.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makePackagedCli(rootDir: string, packageName = "unbrowse", version = "2.0.6"): string {
  const distDir = path.join(rootDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: packageName, version }, null, 2));
  writeFileSync(path.join(distDir, "cli.js"), "console.log('ok');\n");
  return pathToFileURL(path.join(distDir, "cli.js")).href;
}

describe("auto update", () => {
  it("compares semver triplets numerically", () => {
    expect(compareSemver("2.0.6", "2.0.6")).toBe(0);
    expect(compareSemver("2.1.0", "2.0.9")).toBe(1);
    expect(compareSemver("2.0.6", "2.0.7")).toBe(-1);
  });

  it("skips repo/dev runtimes that are not the packaged CLI", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "unbrowse-auto-update-repo-"));
    tmpDirs.push(root);
    const metaUrl = makePackagedCli(root, "unbrowse-monorepo", "2.0.6");

    const result = await maybeAutoUpdate(metaUrl, {
      fetchLatestVersion: async () => "2.0.7",
    });

    expect(result.action).toBe("not-packaged-cli");
  });

  it("honors the disable env escape hatch", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "unbrowse-auto-update-disabled-"));
    tmpDirs.push(root);
    const metaUrl = makePackagedCli(root);

    const result = await maybeAutoUpdate(metaUrl, {
      env: { ...process.env, UNBROWSE_DISABLE_AUTO_UPDATE: "1" },
      fetchLatestVersion: async () => "2.0.7",
    });

    expect(result.action).toBe("disabled");
  });

  it("upgrades global npm installs in place, then re-runs the command", async () => {
    const globalRoot = mkdtempSync(path.join(os.tmpdir(), "unbrowse-auto-update-global-root-"));
    tmpDirs.push(globalRoot);
    const packageRoot = path.join(globalRoot, "unbrowse");
    const metaUrl = makePackagedCli(packageRoot, "unbrowse", "2.0.6");
    const calls: Array<{ command: string; args: string[]; envValue?: string }> = [];

    const result = await maybeAutoUpdate(metaUrl, {
      argv: ["/usr/local/bin/node", path.join(packageRoot, "dist", "cli.js"), "health"],
      execPath: "/usr/local/bin/node",
      cwd: packageRoot,
      fetchLatestVersion: async () => "2.0.7",
      readGlobalNodeModules: () => globalRoot,
      spawn: (command, args, options) => {
        calls.push({
          command,
          args,
          envValue: options.env ? String((options.env as NodeJS.ProcessEnv).UNBROWSE_AUTO_UPDATE_APPLIED ?? "") : "",
        });
        return { status: 0, error: undefined };
      },
    });

    expect(result.action).toBe("install-global+reexec");
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      {
        command: "npm",
        args: ["install", "-g", "unbrowse@2.0.7"],
        envValue: "1",
      },
      {
        command: "/usr/local/bin/node",
        args: [path.join(packageRoot, "dist", "cli.js"), "health"],
        envValue: "1",
      },
    ]);
  });

  it("falls back to npm exec latest for non-global packaged installs", async () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), "unbrowse-auto-update-project-"));
    tmpDirs.push(projectRoot);
    const packageRoot = path.join(projectRoot, "node_modules", "unbrowse");
    const metaUrl = makePackagedCli(packageRoot, "unbrowse", "2.0.6");
    const calls: Array<{ command: string; args: string[] }> = [];

    const result = await maybeAutoUpdate(metaUrl, {
      argv: ["/usr/local/bin/node", path.join(packageRoot, "dist", "cli.js"), "resolve", "--intent", "get posts"],
      cwd: projectRoot,
      fetchLatestVersion: async () => "2.0.7",
      readGlobalNodeModules: () => null,
      spawn: (command, args) => {
        calls.push({ command, args });
        return { status: 0, error: undefined };
      },
    });

    expect(result.action).toBe("npm-exec-latest");
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      {
        command: "npm",
        args: ["exec", "--yes", "--prefer-online", "--package", "unbrowse@2.0.7", "--", "unbrowse", "resolve", "--intent", "get posts"],
      },
    ]);
  });
});
