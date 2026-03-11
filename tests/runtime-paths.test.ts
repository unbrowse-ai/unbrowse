import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../src/runtime/paths.js";

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
});
