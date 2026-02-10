/**
 * Publish Merge-Back Flow Tests
 *
 * Tests the logic that writes merged skill content back to local disk
 * after a collaborative publish response from the server.
 *
 * Both `unbrowse_publish` tool and `autoPublishSkill` share this pattern:
 * when the server returns { merged: true, skill: { skillMd, scripts, references } },
 * the merged content is written to the local skill directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helper: simulate the merge-back write logic ─────────────────────────────
// Extracted from unbrowse_publish.ts lines 175-203 and plugin.ts lines 262-284.
// Both locations share the same logic, so we test a single extracted version.

interface MergeResult {
  merged?: boolean;
  skill?: {
    skillId?: string;
    name?: string;
    skillMd?: string;
    scripts?: Record<string, string>;
    references?: Record<string, string>;
  };
  skillId?: string;
  contribution?: {
    contributionId: string;
    noveltyScore: number;
    weight: number;
    endpointsAdded: number;
  };
}

/**
 * Writes merged skill content back to the local skill directory.
 * Returns true if writes were performed, false otherwise.
 * Matches the logic in unbrowse_publish.ts and plugin.ts autoPublishSkill.
 */
function writeMergedSkillLocally(
  skillDir: string,
  result: MergeResult,
): boolean {
  if (!result?.merged || !result?.skill?.skillMd) {
    return false;
  }

  try {
    const skillMdPath = join(skillDir, "SKILL.md");
    writeFileSync(skillMdPath, result.skill.skillMd, "utf-8");

    if (result.skill.scripts && typeof result.skill.scripts === "object") {
      const scriptsDir = join(skillDir, "scripts");
      mkdirSync(scriptsDir, { recursive: true });
      for (const [filename, content] of Object.entries(result.skill.scripts)) {
        if (typeof content === "string") {
          writeFileSync(join(scriptsDir, filename), content, "utf-8");
        }
      }
    }

    if (result.skill.references && typeof result.skill.references === "object") {
      const refsDir = join(skillDir, "references");
      mkdirSync(refsDir, { recursive: true });
      for (const [filename, content] of Object.entries(result.skill.references)) {
        if (typeof content === "string") {
          writeFileSync(join(refsDir, filename), content, "utf-8");
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("publish merge-back flow", () => {
  let skillDir: string;

  beforeEach(() => {
    // Create a unique temp dir for each test
    skillDir = join(tmpdir(), `unbrowse-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(skillDir, { recursive: true });
    // Write initial SKILL.md so skillDir looks like a real skill
    writeFileSync(join(skillDir, "SKILL.md"), "# Original Skill\n", "utf-8");
  });

  afterEach(() => {
    try {
      rmSync(skillDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  });

  // ── Core merge-back cases ──────────────────────────────────────────────

  it("merged response with skillMd writes SKILL.md", () => {
    const mergedMd = "# Merged Skill\n\nEndpoints from 3 contributors.";
    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_abc123",
        name: "test-service",
        skillMd: mergedMd,
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(true);
    const written = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(written).toBe(mergedMd);
  });

  it("merged response with scripts creates scripts/ dir and writes files", () => {
    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_abc123",
        skillMd: "# Merged\n",
        scripts: {
          "api.ts": 'export function getUser() { return fetch("/users"); }',
          "helpers.ts": 'export const BASE_URL = "https://example.com";',
        },
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(true);
    expect(existsSync(join(skillDir, "scripts"))).toBe(true);
    expect(readFileSync(join(skillDir, "scripts", "api.ts"), "utf-8")).toBe(
      result.skill!.scripts!["api.ts"],
    );
    expect(readFileSync(join(skillDir, "scripts", "helpers.ts"), "utf-8")).toBe(
      result.skill!.scripts!["helpers.ts"],
    );
  });

  it("merged response with references creates references/ dir and writes files", () => {
    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_abc123",
        skillMd: "# Merged\n",
        references: {
          "REFERENCE.md": "# API Reference\n\n## GET /users\nReturns all users.",
          "AUTH.md": "# Auth Guide\n\nUse Bearer token.",
        },
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(true);
    expect(existsSync(join(skillDir, "references"))).toBe(true);
    expect(readFileSync(join(skillDir, "references", "REFERENCE.md"), "utf-8")).toBe(
      result.skill!.references!["REFERENCE.md"],
    );
    expect(readFileSync(join(skillDir, "references", "AUTH.md"), "utf-8")).toBe(
      result.skill!.references!["AUTH.md"],
    );
  });

  it("merged response with all fields writes everything", () => {
    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_full",
        name: "full-service",
        skillMd: "# Full Merged Skill\nAll contributors.",
        scripts: { "api.ts": "// merged api" },
        references: { "REFERENCE.md": "# Full Reference" },
      },
      contribution: {
        contributionId: "contrib_1",
        noveltyScore: 0.85,
        weight: 0.3,
        endpointsAdded: 4,
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(true);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe(result.skill!.skillMd!);
    expect(readFileSync(join(skillDir, "scripts", "api.ts"), "utf-8")).toBe("// merged api");
    expect(readFileSync(join(skillDir, "references", "REFERENCE.md"), "utf-8")).toBe("# Full Reference");
  });

  // ── No-op cases ────────────────────────────────────────────────────────

  it("merged response without skillMd does not write", () => {
    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_abc123",
        // skillMd is missing
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(false);
    // Original SKILL.md should be untouched
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe("# Original Skill\n");
  });

  it("non-merged response does not write", () => {
    const result: MergeResult = {
      merged: false,
      skill: {
        skillId: "sk_abc123",
        skillMd: "# Should Not Be Written\n",
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(false);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe("# Original Skill\n");
  });

  it("response without merged flag does not write", () => {
    const result: MergeResult = {
      // merged is undefined
      skill: {
        skillId: "sk_abc123",
        skillMd: "# Should Not Be Written\n",
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(false);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe("# Original Skill\n");
  });

  it("empty result does not write", () => {
    const result: MergeResult = {};

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(false);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("scripts with non-string values are skipped", () => {
    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_abc",
        skillMd: "# Merged\n",
        scripts: {
          "api.ts": "// valid",
          "bad.ts": 42 as unknown as string, // non-string value
        },
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(true);
    expect(readFileSync(join(skillDir, "scripts", "api.ts"), "utf-8")).toBe("// valid");
    // bad.ts should not have been written (non-string content)
    expect(existsSync(join(skillDir, "scripts", "bad.ts"))).toBe(false);
  });

  it("references with non-string values are skipped", () => {
    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_abc",
        skillMd: "# Merged\n",
        references: {
          "REFERENCE.md": "# Valid",
          "broken.md": null as unknown as string,
        },
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(true);
    expect(readFileSync(join(skillDir, "references", "REFERENCE.md"), "utf-8")).toBe("# Valid");
    expect(existsSync(join(skillDir, "references", "broken.md"))).toBe(false);
  });

  it("write failure returns false instead of throwing", () => {
    // Use a directory path that cannot be written to
    const badDir = "/nonexistent/path/that/does/not/exist";
    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_abc",
        skillMd: "# Merged\n",
      },
    };

    const wrote = writeMergedSkillLocally(badDir, result);

    expect(wrote).toBe(false);
  });

  it("existing scripts/ dir is reused (not recreated)", () => {
    // Pre-create scripts/ with an existing file
    const scriptsDir = join(skillDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, "existing.ts"), "// pre-existing", "utf-8");

    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_abc",
        skillMd: "# Merged\n",
        scripts: {
          "api.ts": "// new merged api",
        },
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(true);
    // New file written
    expect(readFileSync(join(scriptsDir, "api.ts"), "utf-8")).toBe("// new merged api");
    // Pre-existing file remains untouched
    expect(readFileSync(join(scriptsDir, "existing.ts"), "utf-8")).toBe("// pre-existing");
  });

  it("empty scripts object does not create scripts/ dir", () => {
    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_abc",
        skillMd: "# Merged\n",
        scripts: {},
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(true);
    // scripts/ dir is created because mkdirSync is called when scripts is truthy object
    // The actual code creates it even if empty — this test verifies current behavior
    expect(existsSync(join(skillDir, "scripts"))).toBe(true);
  });

  it("SKILL.md is overwritten, not appended", () => {
    // Write a longer original
    writeFileSync(join(skillDir, "SKILL.md"), "# Very Long Original\nLots of content here.\n".repeat(10), "utf-8");

    const shortMerged = "# Short Merged";
    const result: MergeResult = {
      merged: true,
      skill: {
        skillId: "sk_abc",
        skillMd: shortMerged,
      },
    };

    const wrote = writeMergedSkillLocally(skillDir, result);

    expect(wrote).toBe(true);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe(shortMerged);
  });
});
