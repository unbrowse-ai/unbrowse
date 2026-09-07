/**
 * setup-skill-install.test — `setup` installs the Agent Skill (the primary
 * surface), idempotently, into the host's skills dir. MCP is the legacy opt-in.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findShippedSkillMd,
  installUnbrowseSkill,
} from "../src/setup/skill-install.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "unbrowse-skill-")); });
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("the shipped SKILL.md is locatable", () => {
  it("findShippedSkillMd resolves a real file", () => {
    const src = findShippedSkillMd(import.meta.url);
    expect(src).not.toBeNull();
    expect(existsSync(src!)).toBe(true);
    expect(readFileSync(src!, "utf8").length).toBeGreaterThan(100);
  });
});

describe("installUnbrowseSkill", () => {
  it("installs SKILL.md into <home>/.claude/skills/unbrowse and is idempotent", () => {
    const first = installUnbrowseSkill(import.meta.url, { home: tmp });
    expect(first.action).toBe("installed");
    expect(first.path).toBe(join(tmp, ".claude", "skills", "unbrowse", "SKILL.md"));
    expect(existsSync(first.path)).toBe(true);
    expect(readFileSync(first.path, "utf8")).toBe(readFileSync(first.source!, "utf8"));
    expect(installUnbrowseSkill(import.meta.url, { home: tmp }).action).toBe("already_current");
  });

  it("refreshes a stale installed skill", () => {
    const target = join(tmp, ".claude", "skills", "unbrowse", "SKILL.md");
    mkdirSync(join(tmp, ".claude", "skills", "unbrowse"), { recursive: true });
    writeFileSync(target, "OLD STALE SKILL");
    expect(installUnbrowseSkill(import.meta.url, { home: tmp }).action).toBe("updated");
    expect(readFileSync(target, "utf8")).not.toBe("OLD STALE SKILL");
  });

  it("never touches the real home (explicit home is honored)", () => {
    const r = installUnbrowseSkill(import.meta.url, { home: tmp });
    expect(r.path.startsWith(tmp)).toBe(true);
  });
});
