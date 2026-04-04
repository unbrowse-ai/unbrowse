import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageRoot, isBundledVirtualEntrypoint, isMainModule, runtimeArgsForEntrypoint } from "../src/runtime/paths.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime paths", () => {
  it("treats a symlinked npm bin path as the main module", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-runtime-paths-"));
    tmpDirs.push(tmpDir);

    const realEntrypoint = path.join(tmpDir, "cli.js");
    const linkedEntrypoint = path.join(tmpDir, "unbrowse");
    writeFileSync(realEntrypoint, "console.log('ok');\n");
    symlinkSync(realEntrypoint, linkedEntrypoint);

    const originalArgv1 = process.argv[1];
    process.argv[1] = linkedEntrypoint;

    try {
      expect(isMainModule(pathToFileURL(realEntrypoint).href)).toBe(true);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it("returns a file:// URL for the --import arg when tsx is available", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-runtime-paths-tsx-"));
    tmpDirs.push(tmpDir);

    // Create a fake tsx package with dist/loader.mjs
    const tsxPkgDir = path.join(tmpDir, "node_modules", "tsx");
    mkdirSync(path.join(tsxPkgDir, "dist"), { recursive: true });
    writeFileSync(path.join(tsxPkgDir, "package.json"), JSON.stringify({ name: "tsx", main: "dist/index.js" }));
    writeFileSync(path.join(tsxPkgDir, "dist", "loader.mjs"), "// fake loader\n");

    // Create a fake skill entrypoint
    const skillTs = path.join(tmpDir, "skill.ts");
    writeFileSync(skillTs, "// skill\n");

    // metaUrl must be a file inside tmpDir so createRequire resolves tsx from tmpDir/node_modules
    const metaUrl = pathToFileURL(path.join(tmpDir, "entrypoint.js")).href;

    // Temporarily remove process.versions.bun so the function doesn't short-circuit
    const origBun = process.versions.bun;
    (process.versions as Record<string, string | undefined>).bun = undefined;
    let args: string[];
    try {
      args = runtimeArgsForEntrypoint(metaUrl, skillTs);
    } finally {
      (process.versions as Record<string, string | undefined>).bun = origBun;
    }

    const importIdx = args.indexOf("--import");
    expect(importIdx).toBeGreaterThanOrEqual(0);
    expect(args[importIdx + 1]).toMatch(/^file:\/\//);
  });

  it("finds the package root for nested source modules", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-runtime-root-"));
    tmpDirs.push(tmpDir);

    writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "unbrowse-test" }));
    const nestedModule = path.join(tmpDir, "src", "kuri", "client.ts");
    mkdirSync(path.dirname(nestedModule), { recursive: true });
    writeFileSync(nestedModule, "// nested module\n");

    expect(getPackageRoot(pathToFileURL(nestedModule).href)).toBe(tmpDir);
  });

  it("detects bundled bun virtual entrypoints", () => {
    expect(isBundledVirtualEntrypoint("/$bunfs/root/mcp.js")).toBe(true);
    expect(isBundledVirtualEntrypoint("/tmp/unbrowse/dist/mcp.js")).toBe(false);
  });
});
