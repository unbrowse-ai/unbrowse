// Install the unbrowse Agent Skill — the PRIMARY surface (the CLI's map for any
// skill-aware agent). `setup` installs this by default; MCP registration is the
// legacy opt-in. The package ships SKILL.md at its root (see
// packages/skill/package.json "files"); this locates that shipped file and
// copies it into the host's skills directory, idempotently.
//
// Canonical host: Claude Code reads ~/.claude/skills/<name>/SKILL.md. We mirror
// into the cross-agent ~/.agents/skills/<name>/ when that tree already exists
// (the same convention the lobster skill uses), but never bootstrap a tree the
// user doesn't have.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillInstallResult {
  action: "installed" | "updated" | "already_current" | "source_not_found" | "failed";
  /** Where the skill was written (or would be). */
  path: string;
  /** The shipped SKILL.md we copied from, if found. */
  source?: string;
  detail?: string;
}

/** Locate the shipped SKILL.md across dev + published package layouts. */
export function findShippedSkillMd(metaUrl: string): string | null {
  const dir = dirname(fileURLToPath(metaUrl));
  const candidates = [
    join(dir, "SKILL.md"), // published: SKILL.md beside the bundled cli at package root
    join(dir, "..", "SKILL.md"), // bundle in dist/, SKILL.md one up at root
    join(dir, "..", "packages", "skill", "SKILL.md"), // dev: src/ → ../packages/skill
    join(dir, "..", "..", "packages", "skill", "SKILL.md"),
    join(dir, "..", "..", "..", "packages", "skill", "SKILL.md"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export interface SkillInstallOpts {
  /** Override the home dir (tests). Defaults to os.homedir(). */
  home?: string;
}

/** The Claude Code skills directory. */
function claudeSkillsDir(home: string): string {
  return join(home, ".claude", "skills", "unbrowse");
}

/**
 * Install (or refresh) the unbrowse SKILL.md into the host's skills directory.
 * Idempotent: re-running overwrites with the shipped copy so the skill stays
 * current; "already_current" when the bytes already match.
 */
export function installUnbrowseSkill(metaUrl: string, opts: SkillInstallOpts = {}): SkillInstallResult {
  const home = opts.home ?? homedir();
  const source = findShippedSkillMd(metaUrl);
  const target = join(claudeSkillsDir(home), "SKILL.md");
  if (!source) {
    return { action: "source_not_found", path: target, detail: "shipped SKILL.md not found beside the CLI" };
  }
  try {
    const want = readFileSync(source, "utf8");
    const had = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (had === want) {
      mirrorToAgents(want, home);
      return { action: "already_current", path: target, source };
    }
    mkdirSync(claudeSkillsDir(home), { recursive: true });
    writeFileSync(target, want, { mode: 0o644 });
    mirrorToAgents(want, home);
    return { action: had === null ? "installed" : "updated", path: target, source };
  } catch (err) {
    return { action: "failed", path: target, source, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Mirror into ~/.agents/skills/unbrowse ONLY when that tree already exists. */
function mirrorToAgents(content: string, home: string): void {
  const agentsRoot = join(home, ".agents", "skills");
  if (!existsSync(agentsRoot)) return; // never bootstrap a tree the user doesn't have
  try {
    const dir = join(home, ".agents", "skills", "unbrowse");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, { mode: 0o644 });
  } catch {
    // best-effort mirror
  }
}
