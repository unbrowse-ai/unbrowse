import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const tmpDirs: string[] = [];

function makeHomeFixture() {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-setup-shim-"));
  tmpDirs.push(homeDir);

  const stableBin = path.join(homeDir, ".local", "bin");
  const tempBin = path.join(homeDir, ".codex", "tmp", "arg0", "codex-arg0ABCD");

  mkdirSync(stableBin, { recursive: true });
  mkdirSync(tempBin, { recursive: true });

  return { homeDir, stableBin, tempBin };
}

function dryRunSetup(scriptPath: string, homeDir: string, stableBin: string, tempBin: string): string {
  return execFileSync(scriptPath, ["--host", "off", "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${tempBin}:${stableBin}:${process.env.PATH ?? ""}`,
    },
  });
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("setup shim path selection", () => {
  it("prefers a stable user bin over Codex temp bins in the repo bootstrap", () => {
    const { homeDir, stableBin, tempBin } = makeHomeFixture();
    const output = dryRunSetup(path.join(ROOT, "setup"), homeDir, stableBin, tempBin);

    expect(output).toContain(`shim path: ${path.join(stableBin, "unbrowse")}`);
  });

  it("prefers a stable user bin over Codex temp bins in the packaged bootstrap", () => {
    const { homeDir, stableBin, tempBin } = makeHomeFixture();
    const output = dryRunSetup(path.join(ROOT, "packages", "skill", "setup"), homeDir, stableBin, tempBin);

    expect(output).toContain(`shim path: ${path.join(stableBin, "unbrowse")}`);
  });
});
