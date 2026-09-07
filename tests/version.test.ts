import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeCodeHashForDir, getEmbeddedReleaseVersion, getPackageVersionForModuleDir, resolveCodeHashSourceDir } from "../src/version.js";

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

  it("walks upward to find package.json for packaged dist/runtime layouts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "unbrowse-version-"));

    try {
      const distDir = path.join(root, "dist");
      mkdirSync(path.join(distDir, "nested"), { recursive: true });
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));

      expect(getPackageVersionForModuleDir(path.join(distDir, "nested"))).toBe("9.9.9");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks past a version-less runtime package stub", () => {
    const root = mkdtempSync(path.join(tmpdir(), "unbrowse-version-"));

    try {
      const runtimeDir = path.join(root, "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
      writeFileSync(path.join(runtimeDir, "package.json"), JSON.stringify({ type: "module" }));

      expect(getPackageVersionForModuleDir(runtimeDir)).toBe("9.9.9");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a source checkout does not impersonate the previous signed release", () => {
    expect(getEmbeddedReleaseVersion()).toBeNull();
  });

  it("reports the checkout package version from the shared version source", () => {
    const versionJson = JSON.parse(
      require("node:fs").readFileSync(path.join(__dirname, "..", "version.json"), "utf8"),
    ) as { version: string };
    expect(getPackageVersionForModuleDir(path.join(__dirname, "..", "src"))).toBe(versionJson.version);
  });
});
