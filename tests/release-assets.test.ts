import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const GITMODULES = path.join(ROOT, ".gitmodules");
const RELEASE_WORKFLOW = path.join(ROOT, ".github", "workflows", "release.yml");

describe("release asset wiring", () => {
  it("tracks the Kuri submodule against the adding-extensions branch", () => {
    const gitmodules = readFileSync(GITMODULES, "utf8");

    expect(gitmodules).toContain('[submodule "submodules/kuri"]');
    expect(gitmodules).toContain("branch = adding-extensions");
  });

  it("uploads compiled CLI binaries to the GitHub release", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf8");

    expect(workflow).toContain("name: Upload CLI Release Assets");
    expect(workflow).toContain("bash scripts/build-binaries.sh --all");
    expect(workflow).toContain("gh release upload \"$TAG\" dist/unbrowse-* --clobber");
    expect(workflow).toContain("bash scripts/ensure-submodules.sh submodules/kuri");
  });
});
