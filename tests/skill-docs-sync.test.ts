import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("skill docs sync", () => {
  it("copies the root docs tree into the standalone skill repo during sync", () => {
    const script = readFileSync(path.join(repoRoot, "scripts", "sync-skill.sh"), "utf8");

    expect(script).toContain('DOCS_DIR="$MONO_ROOT/docs"');
    expect(script).toContain('"$DOCS_DIR/" "$TARGET_REPO/docs/"');
  });

  it("surfaces the synced docs from the standalone skill README", () => {
    const readme = readFileSync(path.join(repoRoot, "packages", "skill", "README.md"), "utf8");

    expect(readme).toContain("## Docs");
    expect(readme).toContain("./docs/guides/quickstart.md");
    expect(readme).toContain("./docs/api.md");
    expect(readme).toContain("./docs/RELEASING.md");
  });

  it("surfaces the synced docs from the standalone skill instructions", () => {
    const skill = readFileSync(path.join(repoRoot, "packages", "skill", "SKILL.md"), "utf8");

    expect(skill).toContain("## Docs");
    expect(skill).toContain("./docs/guides/quickstart.md");
    expect(skill).toContain("./docs/codex-eval-harness.md");
    expect(skill).toContain("./docs/RELEASING.md");
  });
});
