import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const yamlSafeSkillDocs = [
  path.join(repoRoot, "SKILL.md"),
  path.join(repoRoot, "packages", "skill", "SKILL.md"),
  path.join(repoRoot, "skills", "worktree-issue-fix", "SKILL.md"),
];

describe("skill docs sync", () => {
  it("copies the root docs tree into the standalone skill repo during sync", () => {
    const script = readFileSync(path.join(repoRoot, "scripts", "sync-skill.sh"), "utf8");

    expect(script).toContain('DOCS_DIR="$MONO_ROOT/docs"');
    expect(script).toContain('"$DOCS_DIR/" "$TARGET_REPO/docs/"');
  });

  it("keeps the restored whitepaper docs in the monorepo docs tree", () => {
    expect(existsSync(path.join(repoRoot, "docs", "whitepaper", "README.md"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "docs", "whitepaper", "unbrowse-whitepaper.pdf"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "docs", "whitepaper", "for-technical-readers.md"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "docs", "whitepaper", "network-layer.md"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "docs", "whitepaper", "internal-cathedral.md"))).toBe(false);
  });

  it("keeps only public-safe whitepaper links surfaced in the public entrypoints", () => {
    const rootReadme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const skillReadme = readFileSync(path.join(repoRoot, "packages", "skill", "README.md"), "utf8");
    const skillDoc = readFileSync(path.join(repoRoot, "SKILL.md"), "utf8");
    const packageSkillDoc = readFileSync(path.join(repoRoot, "packages", "skill", "SKILL.md"), "utf8");
    const networkLayer = readFileSync(path.join(repoRoot, "docs", "whitepaper", "network-layer.md"), "utf8");

    expect(rootReadme).toContain("./docs/whitepaper/README.md");
    expect(rootReadme).toContain("./docs/whitepaper/for-investors.md");
    expect(rootReadme).toContain("30x faster");
    expect(rootReadme).toContain("90% cheaper");
    expect(rootReadme).not.toContain("internal-cathedral");
    expect(skillReadme).toContain("./docs/whitepaper/for-technical-readers.md");
    expect(skillReadme).toContain("30x faster");
    expect(skillReadme).toContain("90% cheaper");
    expect(skillReadme).not.toContain("internal-cathedral");
    expect(skillDoc).toContain("./docs/whitepaper/for-investors.md");
    expect(skillDoc).toContain("OpenClaw / `agent-browser`");
    expect(skillDoc).toContain("30x faster");
    expect(skillDoc).toContain("90% cheaper");
    expect(skillDoc).not.toContain("internal-cathedral");
    expect(packageSkillDoc).toContain("OpenClaw / `agent-browser`");
    expect(packageSkillDoc).toContain("30x faster");
    expect(packageSkillDoc).toContain("90% cheaper");
    expect(packageSkillDoc).not.toContain("internal-cathedral");
    expect(networkLayer.toLowerCase()).not.toContain("cathedral");
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

  it("keeps skill frontmatter YAML-safe for skills.sh discovery", () => {
    for (const skillPath of yamlSafeSkillDocs) {
      const skill = readFileSync(skillPath, "utf8");
      const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/m)?.[1] ?? "";

      expect(frontmatter).toMatch(/(?:^|\n)name:\s+.+/);
      expect(frontmatter).toMatch(/(?:^|\n)description:\s*[>|'"]/);
    }
  });
});
