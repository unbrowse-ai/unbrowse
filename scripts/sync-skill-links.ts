import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";

export type SyncSkillLinksOptions = {
  homeDir?: string;
  monoRoot?: string;
  log?: (message: string) => void;
};

export type SyncSkillLinksResult = {
  created: string[];
  updated: string[];
  skipped: string[];
  unchanged: string[];
};

function existsAny(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(targetPath: string): boolean {
  try {
    return lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveLinkTarget(linkPath: string, targetPath: string): string {
  return path.relative(path.dirname(linkPath), targetPath) || ".";
}

function isSkillDir(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory() && existsSync(path.join(targetPath, "SKILL.md"));
  } catch {
    return false;
  }
}

function shouldMirrorClaudeSkill(entryPath: string): boolean {
  try {
    const stats = lstatSync(entryPath);
    if (stats.isDirectory()) return isSkillDir(entryPath);
    if (!stats.isSymbolicLink()) return false;
    const target = path.resolve(path.dirname(entryPath), readlinkSync(entryPath));
    return isSkillDir(target);
  } catch {
    return false;
  }
}

function ensureSymlink(
  linkPath: string,
  targetPath: string,
  result: SyncSkillLinksResult,
  log: (message: string) => void,
  updateExisting = true,
): void {
  const desired = resolveLinkTarget(linkPath, targetPath);
  if (isSymlink(linkPath)) {
    const current = readlinkSync(linkPath);
    if (current === desired) {
      result.unchanged.push(linkPath);
      log(`${linkPath} ok -> ${desired}`);
      return;
    }
    if (!updateExisting) {
      result.skipped.push(linkPath);
      log(`skip ${linkPath}; existing symlink -> ${current}`);
      return;
    }
    rmSync(linkPath);
    symlinkSync(desired, linkPath);
    result.updated.push(linkPath);
    log(`update ${linkPath} -> ${desired}`);
    return;
  }
  if (existsAny(linkPath)) {
    result.skipped.push(linkPath);
    log(`skip ${linkPath}; exists and not symlink`);
    return;
  }
  symlinkSync(desired, linkPath);
  result.created.push(linkPath);
  log(`create ${linkPath} -> ${desired}`);
}

export function syncSkillLinks(options: SyncSkillLinksOptions = {}): SyncSkillLinksResult {
  const homeDir = options.homeDir ?? process.env.HOME ?? path.resolve("~");
  const monoRoot = options.monoRoot ?? path.resolve(import.meta.dir, "..");
  const log = options.log ?? console.log;
  const result: SyncSkillLinksResult = { created: [], updated: [], skipped: [], unchanged: [] };

  const agentsSkillsDir = path.join(homeDir, ".agents", "skills");
  const claudeSkillsDir = path.join(homeDir, ".claude", "skills");
  const codexSkillsDir = path.join(homeDir, ".codex", "skills");

  mkdirSync(agentsSkillsDir, { recursive: true });
  mkdirSync(claudeSkillsDir, { recursive: true });
  mkdirSync(codexSkillsDir, { recursive: true });

  const agentUnbrowse = path.join(agentsSkillsDir, "unbrowse");
  const claudeUnbrowse = path.join(claudeSkillsDir, "unbrowse");

  ensureSymlink(agentUnbrowse, monoRoot, result, log);
  ensureSymlink(claudeUnbrowse, monoRoot, result, log);

  for (const name of readdirSync(claudeSkillsDir).sort()) {
    if (name.startsWith(".")) continue;
    const sourcePath = path.join(claudeSkillsDir, name);
    if (!shouldMirrorClaudeSkill(sourcePath)) continue;
    const codexPath = path.join(codexSkillsDir, name);
    ensureSymlink(codexPath, sourcePath, result, log, name === "unbrowse");
  }

  return result;
}

if (import.meta.main) {
  const result = syncSkillLinks();
  const summary = [
    `created=${result.created.length}`,
    `updated=${result.updated.length}`,
    `skipped=${result.skipped.length}`,
    `unchanged=${result.unchanged.length}`,
  ].join(" ");
  console.log(`[sync-skill-links] ${summary}`);
}
