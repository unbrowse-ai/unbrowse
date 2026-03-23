import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule, runtimeInvocationForEntrypoint } from "../src/runtime/paths.js";

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

  it("prefers bun for ts entrypoints when bun is installed outside bun runtime", () => {
    const originalBun = process.versions.bun;
    const hadEnv = Object.prototype.hasOwnProperty.call(process.env, "BUN_BIN");
    const originalEnv = process.env.BUN_BIN;
    const entrypoint = "/tmp/unbrowse-runtime-test.ts";

    try {
      Object.defineProperty(process.versions, "bun", { value: undefined, configurable: true });
      process.env.BUN_BIN = "/usr/local/bin/bun";
      const runtime = runtimeInvocationForEntrypoint(import.meta.url, entrypoint);
      expect(runtime.command).toBe("/usr/local/bin/bun");
      expect(runtime.args).toEqual([entrypoint]);
    } finally {
      Object.defineProperty(process.versions, "bun", { value: originalBun, configurable: true });
      if (hadEnv) process.env.BUN_BIN = originalEnv;
      else delete process.env.BUN_BIN;
    }
  });
});
