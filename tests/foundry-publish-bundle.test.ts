import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishFoundryBundle } from "../src/foundry/publish-bundle.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("publishFoundryBundle", () => {
  it("writes bundle, share, host, and public manifest artifacts from one preset", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "unbrowse-foundry-bundle-"));
    tempDirs.push(repoRoot);

    const presetPath = join(repoRoot, "skills", "x-account-operator", "foundry-preset.json");
    mkdirSync(join(repoRoot, "skills", "x-account-operator"), { recursive: true });
    writeFileSync(presetPath, JSON.stringify({
      bundle_id: "x-account-operator",
      title: "X Account Operator Bundle",
      fabric: {
        repo: "https://github.com/unbrowse-ai/foundry",
        skill: "foundry",
      },
      repo: "https://github.com/unbrowse-ai/unbrowse",
      bootstrap_skill: "find-skills",
      skills: [
        "x-account-operator",
        "typefully",
        "x-virality",
      ],
      skill_sources: {
        "x-account-operator": {
          repo: "https://github.com/unbrowse-ai/unbrowse",
          source_path: "skills/x-account-operator",
        },
        "typefully": {
          repo: "https://github.com/typefully/agent-skills",
          install: "npx skills add typefully/agent-skills@typefully -g -y",
          source_path: "/Users/lekt9/.agents/skills/typefully",
        },
        "x-virality": {
          repo: "local",
          source_path: "/Users/lekt9/.hermes/skills/social-media/x-virality",
        },
      },
      dependency_graph: {
        nodes: [
          { skill: "foundry", provides: ["bundle-fabrication"], requires: ["x-account-ops"], alternatives: [] },
        ],
      },
      routes: [
        {
          when: "the request is about revamping the X queue",
          call: "x-account-operator",
        },
      ],
      share: {
        transport: "files",
        manifest_path: "/.well-known/skill-bundles/x-account-operator/share.json",
      },
      index: {
        slug: "x-account-operator",
        summary: "Run the X account loop.",
        tags: ["x", "foundry"],
      },
    }, null, 2));

    const result = publishFoundryBundle({
      repoRoot,
      presetPath,
    });

    expect(result.ok).toBe(true);
    expect(result.public_url).toBe("https://www.unbrowse.ai/.well-known/skill-bundles/x-account-operator/share.json");
    expect(existsSync(result.files.bundle)).toBe(true);
    expect(existsSync(result.files.share)).toBe(true);
    expect(existsSync(result.files.host_snippets.codex)).toBe(true);
    expect(existsSync(result.public_manifest_path)).toBe(true);

    const bundle = JSON.parse(readFileSync(result.files.bundle, "utf-8")) as Record<string, unknown>;
    const share = JSON.parse(readFileSync(result.files.share, "utf-8")) as Record<string, unknown>;
    const publicShare = JSON.parse(readFileSync(result.public_manifest_path, "utf-8")) as Record<string, unknown>;
    const snippet = readFileSync(result.files.host_snippets.codex, "utf-8");

    expect((bundle.install_commands as Record<string, unknown>).bundle_skills).toEqual([
      "npx skills add https://github.com/unbrowse-ai/unbrowse --skill x-account-operator --yes",
      "npx skills add typefully/agent-skills@typefully -g -y",
    ]);
    expect((share.host_targets as Array<Record<string, unknown>>).map((entry) => entry.host)).toEqual([
      "codex",
      "claude",
      "openclaw",
    ]);
    expect(publicShare).toEqual(share);
    expect(snippet).toContain("## X Account Operator Bundle (codex)");
    expect(snippet).toContain("call `x-account-operator`");
    expect(snippet).toContain("Use `find-skills` first");
  });
});
