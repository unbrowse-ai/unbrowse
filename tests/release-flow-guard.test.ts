import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.join(import.meta.dir, "..");
const SCRIPT = path.join(ROOT, "packages", "skill", "scripts", "assert-release-flow.mjs");

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixture(versions: {
  root: string;
  skill: string;
  repo: string;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "unbrowse-release-guard-"));
  tempRoots.push(root);

  const skillDir = path.join(root, "packages", "skill");
  const scriptDir = path.join(skillDir, "scripts");
  mkdirSync(scriptDir, { recursive: true });

  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: versions.root }));
  writeFileSync(path.join(root, "version.json"), JSON.stringify({ version: versions.repo }));
  writeFileSync(path.join(skillDir, "package.json"), JSON.stringify({
    name: "unbrowse",
    version: versions.skill,
  }));
  copyFileSync(SCRIPT, path.join(scriptDir, "assert-release-flow.mjs"));

  return {
    root,
    script: path.join(scriptDir, "assert-release-flow.mjs"),
  };
}

function runGuard(
  versions: { root: string; skill: string; repo: string },
  env: Record<string, string> = {},
) {
  const fixture = makeFixture(versions);
  return spawnSync("node", [fixture.script], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "",
      UNBROWSE_ALLOW_SKILL_PUBLISH: "",
      npm_config_unbrowse_allow_skill_publish: "",
      ...env,
    },
  });
}

describe("skill release flow guard", () => {
  test("blocks unsynced versions even when explicit publish is allowed", () => {
    const result = runGuard(
      { root: "2.6.0", skill: "2.0.2", repo: "2.0.2" },
      { UNBROWSE_ALLOW_SKILL_PUBLISH: "1" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("version mismatch");
  });

  test("blocks direct package-folder publish by default when versions are synced", () => {
    const result = runGuard({ root: "2.6.0", skill: "2.6.0", repo: "2.6.0" });

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("bun run release");
  });

  test("allows explicit root-controlled publish path when versions are synced", () => {
    const result = runGuard(
      { root: "2.6.0", skill: "2.6.0", repo: "2.6.0" },
      { UNBROWSE_ALLOW_SKILL_PUBLISH: "1" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[skill publish guard] ok");
  });
});
