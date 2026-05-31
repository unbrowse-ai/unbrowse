/**
 * Windows install + startup regression suite.
 *
 * Encodes the QuoteCommander Windows report (unbrowse@7.1.0):
 *   1. postinstall must install the win-x64 binary as `unbrowse.exe`, not fail
 *      with "Archive ... did not contain ./unbrowse".
 *   2. the wrapper must resolve `unbrowse.exe` on Windows.
 *   3. a missing kuri must NOT hard-kill the process — HTTP-only commands
 *      (setup/serve/health/resolve/execute) run without a browser; only the
 *      browse paths need kuri, and they fail honestly on their own.
 *
 * These are pure-logic + source-structure checks so they run on any host; the
 * full browse E2E lives in .github/workflows/test-windows.yml and is gated on
 * the (separately-tracked) native kuri.exe build.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUPPORTED_TARGETS,
  isWindowsPlatform,
  unbrowseBinaryName,
  buildBinaryArchiveName,
} from "../packages/skill/scripts/release-assets.mjs";
import {
  kuriBinaryName,
  kuriTargetKey,
  kuriVendorCandidatePaths,
  firstExisting,
} from "../src/kuri/resolve-paths.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("unbrowse binary naming (win .exe)", () => {
  test("win target / platform → unbrowse.exe", () => {
    expect(unbrowseBinaryName("win-x64")).toBe("unbrowse.exe");
    expect(unbrowseBinaryName("win32")).toBe("unbrowse.exe");
    expect(isWindowsPlatform("win-x64")).toBe(true);
    expect(isWindowsPlatform("win32")).toBe(true);
  });

  test("darwin/linux → unbrowse (no extension)", () => {
    for (const p of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "darwin", "linux"]) {
      expect(unbrowseBinaryName(p)).toBe("unbrowse");
      expect(isWindowsPlatform(p)).toBe(false);
    }
  });

  test("win-x64 is a published release target with a .tar.gz asset", () => {
    expect(SUPPORTED_TARGETS).toContain("win-x64");
    expect(buildBinaryArchiveName("7.1.0", "win-x64")).toBe("unbrowse-v7.1.0-win-x64.tar.gz");
  });
});

describe("kuri binary naming (win .exe)", () => {
  test("kuriBinaryName is .exe on win32 only", () => {
    expect(kuriBinaryName("win32")).toBe("kuri.exe");
    expect(kuriBinaryName("darwin")).toBe("kuri");
    expect(kuriBinaryName("linux")).toBe("kuri");
  });

  test("win32-x64 maps to the win-x64 vendored target id", () => {
    expect(kuriTargetKey("win32", "x64")).toBe("win-x64");
    expect(kuriTargetKey("darwin", "arm64")).toBe("darwin-arm64");
  });

  test("vendored candidates on Windows look for kuri.exe under win-x64", () => {
    const candidates = kuriVendorCandidatePaths({
      execDir: "C:/bin",
      moduleDir: "C:/app/src/kuri",
      platform: "win32",
      arch: "x64",
    });
    expect(candidates.some((p) => p.includes("win-x64") && p.endsWith("kuri.exe"))).toBe(true);
    // never a plain `kuri` (no extension) on Windows
    expect(candidates.every((p) => p.endsWith("kuri.exe"))).toBe(true);
  });

  test("firstExisting returns the first existing path, else null", () => {
    const exists = (p: string) => p === "/b";
    expect(firstExisting(["/a", "/b", "/c"], exists)).toBe("/b");
    expect(firstExisting(["/x", "/y"], exists)).toBeNull();
    expect(firstExisting([undefined, null, "/b"], exists)).toBe("/b");
  });
});

describe("source-structure regressions", () => {
  test("postinstall extracts the target-appropriate member, not a hardcoded ./unbrowse", () => {
    const src = readFileSync(join(repoRoot, "packages/skill/scripts/postinstall.mjs"), "utf8");
    expect(src).toContain("unbrowseBinaryName(target)");
    // the old failure string keyed on a hardcoded ./unbrowse must be gone
    expect(src).not.toContain('did not contain ./unbrowse');
  });

  test("wrapper resolves the platform-appropriate binary name", () => {
    const src = readFileSync(join(repoRoot, "packages/skill/bin/unbrowse-wrapper.mjs"), "utf8");
    expect(src).toContain("unbrowseBinaryName(process.platform)");
    expect(src).not.toMatch(/join\(__dirname,\s*"unbrowse"\)/);
  });

  test("ensureKuri is non-fatal: missing kuri does not process.exit", () => {
    const src = readFileSync(join(repoRoot, "src/single-binary.ts"), "utf8");
    const fn = src.slice(src.indexOf("function ensureKuri"), src.indexOf("async function main"));
    expect(fn).toContain("string | null");
    expect(fn).not.toContain("process.exit");
  });
});
