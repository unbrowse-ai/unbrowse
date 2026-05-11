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

  it("keeps only public-safe whitepaper links surfaced in the README entrypoints", () => {
    const rootReadme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const skillReadme = readFileSync(path.join(repoRoot, "packages", "skill", "README.md"), "utf8");
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
    expect(networkLayer.toLowerCase()).not.toContain("cathedral");
    // SKILL.md content assertions removed when SKILL was tightened per writing-skills
    // canon (cut marketing prose, whitepaper links, OpenClaw branding, perf numbers).
    // The skill body is now triggering-conditions + workflow only; README files
    // still carry the marketing/whitepaper surface.
  });

  it("surfaces the synced docs from the standalone skill README", () => {
    const readme = readFileSync(path.join(repoRoot, "packages", "skill", "README.md"), "utf8");

    expect(readme).toContain("## Docs");
    expect(readme).toContain("./docs/guides/quickstart.md");
    expect(readme).toContain("./docs/api.md");
    expect(readme).toContain("./docs/RELEASING.md");
  });

  // (Removed: SKILL.md `## Docs` link surface — skills are agent-readable
  //  workflow guides per writing-skills canon, not link directories. The
  //  README surfaces the docs index.)

  it("keeps skill frontmatter YAML-safe for skills.sh discovery", () => {
    for (const skillPath of yamlSafeSkillDocs) {
      const skill = readFileSync(skillPath, "utf8");
      const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/m)?.[1] ?? "";

      expect(frontmatter).toMatch(/(?:^|\n)name:\s+.+/);
      expect(frontmatter).toMatch(/(?:^|\n)description:\s*[>|'"]/);
    }
  });
});
