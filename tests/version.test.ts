import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeCodeHashForDir, resolveCodeHashSourceDir } from "../src/version.js";

describe("version code hash resolution", () => {
  it("falls back from dist to sibling runtime-src for packaged installs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "unbrowse-version-"));

    try {
      const distDir = path.join(root, "dist");
      const runtimeSrcDir = path.join(root, "runtime-src");
      mkdirSync(distDir, { recursive: true });
      mkdirSync(path.join(runtimeSrcDir, "nested"), { recursive: true });
      writeFileSync(path.join(runtimeSrcDir, "index.ts"), "export const a = 1;\n");
      writeFileSync(path.join(runtimeSrcDir, "nested", "thing.ts"), "export const b = 2;\n");

      expect(resolveCodeHashSourceDir(distDir)).toBe(runtimeSrcDir);
      expect(computeCodeHashForDir(resolveCodeHashSourceDir(distDir)!)).toBe(computeCodeHashForDir(runtimeSrcDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
