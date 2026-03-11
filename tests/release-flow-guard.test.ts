import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const script = path.join(ROOT, "packages", "skill", "scripts", "assert-release-flow.mjs");

describe("skill release flow guard", () => {
  test("blocks direct package-folder publish by default", () => {
    const result = spawnSync("node", [script], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, UNBROWSE_ALLOW_SKILL_PUBLISH: "", CI: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("bun run release");
  });

  test("allows explicit root-controlled publish path", () => {
    const result = spawnSync("node", [script], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, UNBROWSE_ALLOW_SKILL_PUBLISH: "1", CI: "" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[skill publish guard] ok");
  });
});
