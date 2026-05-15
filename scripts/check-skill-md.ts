#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

type SkillFile = {
  file: string;
  text: string;
};

const roots = [".agents/skills", "skills"];
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
  return files.sort().map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
}

function frontmatter(text: string): Record<string, string> | null {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.+?)\s*$/);
    if (field) fields[field[1]!] = field[2]!.replace(/^["']|["']$/g, "");
  }
  return fields;
}

for (const skill of readSkillFiles()) {
  const strict = skill.file.startsWith(".agents/skills/unbrowse-bench-");
  const fields = frontmatter(skill.text);
  if (!fields && strict) {
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
