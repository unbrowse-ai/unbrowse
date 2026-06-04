import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// Guard: @unbrowse/sdk is positioned as THE integration surface (CLAUDE.md:
// "Skill path retired in v6.15.0 — SDK is the integration surface"), so the
// release pipeline MUST publish it. It never had a publish path until this
// commit; this test fails loudly if the wiring is removed again.
//
// No mocks, and deliberately NO YAML parser dependency — these are raw-text
// structural assertions on the real release.yml + prepare-release.sh +
// packages/sdk/package.json, exactly the files CI consumes.

const repoRoot = path.resolve(import.meta.dir, "..");

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("@unbrowse/sdk release wiring", () => {
  it("release.yml defines a publish-sdk job gated behind publish-cli", () => {
    const yml = readRepo(".github/workflows/release.yml");

    // Job key present at jobs-level indentation (two spaces).
    const jobIdx = yml.indexOf("\n  publish-sdk:\n");
    expect(jobIdx, "publish-sdk job must exist in release.yml").toBeGreaterThan(-1);

    // Isolate the job block: from its key to the next jobs-level key (or EOF).
    const after = yml.slice(jobIdx + 1);
    const nextJob = after.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
    const block = nextJob === -1 ? after : after.slice(0, nextJob + 1);

    expect(block).toContain("needs: publish-cli");
    expect(block).toContain("packages/sdk/package.json");
    // Must actually publish the scoped package (scoped first publish needs
    // --access public).
    expect(block).toContain("npm publish");
    expect(block).toContain("--access public");
  });

  it("prepare-release.sh bumps and stages packages/sdk/package.json", () => {
    const sh = readRepo("scripts/prepare-release.sh");

    const bumpLoop = sh
      .split("\n")
      .find((l) => l.includes("for PKG in") && l.includes("package.json"));
    expect(bumpLoop, "version bump loop not found").toBeTruthy();
    expect(bumpLoop).toContain("packages/sdk/package.json");

    const gitAdd = sh.split("\n").find((l) => l.trim().startsWith("git add "));
    expect(gitAdd, "git add line not found").toBeTruthy();
    expect(gitAdd).toContain("packages/sdk/package.json");
  });

  it("the SDK package is publishable as @unbrowse/sdk", () => {
    const pkg = JSON.parse(readRepo("packages/sdk/package.json")) as {
      name: string;
      private?: boolean;
    };
    expect(pkg.name).toBe("@unbrowse/sdk");
    expect(pkg.private).not.toBe(true);
  });
});
