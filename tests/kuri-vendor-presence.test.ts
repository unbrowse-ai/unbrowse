import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Falsifiable signal that the Kuri browser-broker vendor payload is coherent.
// The Windows target is load-bearing for browse/capture on installed Windows
// CLIs, so win-x64 must not regress to a missing or shell-stubbed kuri.exe.
// Other cross-target entries may be tiny placeholders in local dev as long as
// the manifest hash integrity holds; the release guard is stricter.
//
// This complements packages/skill/scripts/assert-kuri-vendor.mjs (which runs
// in `prepack` and verifies hashes against manifest). Running it as part of
// `bun test` means the signal fires during normal dev/CI loops without
// needing the pack flow.
//
// Ground truth for the published target set lives in
// packages/skill/scripts/lib/kuri-vendor.mjs (`supportedTargets`).

const repoRoot = path.resolve(import.meta.dir, "..");
const packageRoot = path.join(repoRoot, "packages", "skill");
const vendorRoot = path.join(packageRoot, "vendor", "kuri");

const EXPECTED_TARGETS = [
  { id: "darwin-arm64", bin: "kuri", posix: true },
  { id: "darwin-x64", bin: "kuri", posix: true },
  { id: "linux-arm64", bin: "kuri", posix: true },
  { id: "linux-x64", bin: "kuri", posix: true },
  { id: "win-x64", bin: "kuri.exe", posix: false },
] as const;
const CURRENT_TARGET =
  process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64"
    : process.platform === "darwin" && process.arch === "x64" ? "darwin-x64"
      : process.platform === "linux" && process.arch === "arm64" ? "linux-arm64"
        : process.platform === "linux" && process.arch === "x64" ? "linux-x64"
          : "";

// 100KB threshold. Real kuri release binaries are ~700KB on macOS and ~5MB
// on linux. 100KB catches truncation, zero-byte writes, and placeholder
// commits without being brittle if the binary shrinks.
const MIN_SIZE_BYTES = 100 * 1024;

describe("kuri vendor presence", () => {
  it("vendor root exists", () => {
    expect(existsSync(vendorRoot)).toBe(true);
  });

  it("manifest.json exists and parses", () => {
    const manifestPath = path.join(vendorRoot, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(typeof manifest.source_sha).toBe("string");
    expect(manifest.source_sha.length).toBeGreaterThan(0);
    console.log(
      `[kuri vendor presence] manifest source_sha=${manifest.source_sha} branch=${manifest.branch} built_at=${manifest.built_at}`,
    );
  });

  for (const target of EXPECTED_TARGETS) {
    describe(`target ${target.id}`, () => {
      const binPath = path.join(vendorRoot, target.id, target.bin);

      it("binary exists", () => {
        expect(existsSync(binPath)).toBe(true);
      });

      it(`current-platform/win-x64 binary size > ${MIN_SIZE_BYTES} bytes or cross-target placeholder is explicit`, () => {
        const stat = statSync(binPath);
        console.log(`[kuri vendor presence] ${target.id} size=${stat.size}`);
        if (target.id === CURRENT_TARGET || target.id === "win-x64") {
          expect(stat.size).toBeGreaterThan(MIN_SIZE_BYTES);
        } else {
          expect(stat.size).toBeGreaterThan(0);
        }
      });

      if (target.posix) {
        it("binary has executable bit (POSIX)", () => {
          const stat = statSync(binPath);
          expect(stat.mode & 0o111).not.toBe(0);
        });
      }

      it("binary listed in manifest.binaries with sha256", () => {
        const manifest = JSON.parse(
          readFileSync(path.join(vendorRoot, "manifest.json"), "utf8"),
        );
        expect(manifest.binaries?.[target.id]).toBeDefined();
        expect(typeof manifest.binaries[target.id].sha256).toBe("string");
        expect(manifest.binaries[target.id].sha256.length).toBe(64);
      });
    });
  }

  it("assert-kuri-vendor.mjs script passes (hash + manifest integrity)", () => {
    const scriptPath = path.join(
      packageRoot,
      "scripts",
      "assert-kuri-vendor.mjs",
    );
    const result = spawnSync("node", [scriptPath], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    if (result.status !== 0) {
      console.error(`stdout: ${result.stdout}`);
      console.error(`stderr: ${result.stderr}`);
    }
    expect(result.status).toBe(0);
  });
});
