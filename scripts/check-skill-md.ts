#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

type SkillFile = {
  file: string;
  text: string;
};

const roots = [".agents/skills", "skills"];
// User-facing / published SKILL.md files installed via `npx skills add unbrowse-ai/unbrowse`.
// These MUST parse as real YAML — a naive line parser silently tolerated an unquoted
// `description:` containing a colon-space ("for AI agents: it learns"), which a real YAML
// parser (and the skills CLI) rejects with "mapping values are not allowed here" → the public
// install reported "No skills found". Validate them with the same parser the installer uses.
const rootSkills = ["SKILL.md", "packages/skill/SKILL.md"];
const errors: string[] = [];

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
  }
}

function readSkillFiles(): SkillFile[] {
  const files: string[] = [];
  for (const root of roots) walk(root, files);
  for (const f of rootSkills) if (fs.existsSync(f)) files.push(f);
  return [...new Set(files)].sort().map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
}

// Real-YAML frontmatter parse — mirrors what `npx skills` does. Returns null when there is no
// frontmatter block; throws (caught by caller) when the frontmatter is present but YAML-invalid.
function frontmatter(text: string): Record<string, unknown> | null {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const parsed = parseYaml(match[1]!) as Record<string, unknown> | null;
  return parsed ?? {};
}

for (const skill of readSkillFiles()) {
  const strict = skill.file.startsWith(".agents/skills/unbrowse-bench-");
  const published = rootSkills.includes(skill.file);
  let fields: Record<string, unknown> | null;
  try {
    fields = frontmatter(skill.text);
  } catch (err) {
    // YAML-invalid frontmatter is a hard failure for any published skill (the installer rejects
    // it); for internal skills it is still surfaced so it can't silently ship.
    errors.push(`${skill.file}: invalid YAML frontmatter — ${(err as Error).message.split("\n")[0]}`);
    continue;
  }
  if (!fields && (strict || published)) {
    errors.push(`${skill.file}: missing YAML frontmatter`);
    continue;
  }
  if (fields && !fields.name) errors.push(`${skill.file}: missing frontmatter name`);
  if (fields && !fields.description) errors.push(`${skill.file}: missing frontmatter description`);
  if (strict && skill.text.split("\n").length > 500) errors.push(`${skill.file}: exceeds 500 lines`);
  if (/\r/.test(skill.text)) errors.push(`${skill.file}: contains CRLF line endings`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(`skill-md ok (${readSkillFiles().length} files)`);
