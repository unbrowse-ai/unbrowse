import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncSkillLinks } from "../scripts/sync-skill-links.ts";

function makeSkill(skillDir: string): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), "# skill\n");
}

describe("syncSkillLinks", () => {
  it("creates the unbrowse chain and mirrors Claude skills into Codex", () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-skill-links-home-"));
    const monoRoot = mkdtempSync(path.join(os.tmpdir(), "unbrowse-skill-links-repo-"));
    makeSkill(monoRoot);

    const agentsSkillsDir = path.join(homeDir, ".agents", "skills");
    const claudeSkillsDir = path.join(homeDir, ".claude", "skills");
    mkdirSync(agentsSkillsDir, { recursive: true });
    mkdirSync(claudeSkillsDir, { recursive: true });

    const browseSkill = path.join(agentsSkillsDir, "browser-automation");
    makeSkill(browseSkill);
    symlinkSync(path.relative(claudeSkillsDir, browseSkill), path.join(claudeSkillsDir, "browser-automation"));

    syncSkillLinks({ homeDir, monoRoot, log: () => {} });

    expect(readlinkSync(path.join(agentsSkillsDir, "unbrowse"))).toBe(path.relative(agentsSkillsDir, monoRoot));
    expect(readlinkSync(path.join(claudeSkillsDir, "unbrowse"))).toBe(path.relative(claudeSkillsDir, monoRoot));
    expect(readlinkSync(path.join(homeDir, ".codex", "skills", "unbrowse"))).toBe("../../.claude/skills/unbrowse");
    expect(readlinkSync(path.join(homeDir, ".codex", "skills", "browser-automation"))).toBe("../../.claude/skills/browser-automation");
  });

  it("repairs a stale Claude unbrowse symlink but leaves existing Codex-specific entries alone", () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-skill-links-home-"));
    const monoRoot = mkdtempSync(path.join(os.tmpdir(), "unbrowse-skill-links-repo-"));
    makeSkill(monoRoot);

    const claudeSkillsDir = path.join(homeDir, ".claude", "skills");
    const codexSkillsDir = path.join(homeDir, ".codex", "skills");
    mkdirSync(claudeSkillsDir, { recursive: true });
    mkdirSync(codexSkillsDir, { recursive: true });

    symlinkSync("/tmp/stale-unbrowse", path.join(claudeSkillsDir, "unbrowse"));

    const codexSpecial = path.join(codexSkillsDir, "find-skills");
    makeSkill(codexSpecial);

    syncSkillLinks({ homeDir, monoRoot, log: () => {} });

    expect(readlinkSync(path.join(claudeSkillsDir, "unbrowse"))).toBe(path.relative(claudeSkillsDir, monoRoot));
    expect(existsSync(path.join(codexSkillsDir, "find-skills", "SKILL.md"))).toBe(true);
  });
});
