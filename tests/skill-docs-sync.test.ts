import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

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
    const networkLayer = readFileSync(path.join(repoRoot, "docs", "whitepaper", "network-layer.md"), "utf8");

    expect(rootReadme).toContain("./docs/whitepaper/README.md");
    expect(rootReadme).toContain("./docs/whitepaper/for-investors.md");
    expect(rootReadme).not.toContain("internal-cathedral");
    expect(skillReadme).toContain("./docs/whitepaper/for-technical-readers.md");
    expect(skillReadme).not.toContain("internal-cathedral");
    expect(skillDoc).toContain("./docs/whitepaper/for-investors.md");
    expect(skillDoc).not.toContain("internal-cathedral");
    expect(networkLayer.toLowerCase()).not.toContain("cathedral");
  });
});
