#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

const docs = ["AGENTS.md", "AIKO.md", "CLAUDE.md"];
const errors: string[] = [];

function skillExists(slug: string): boolean {
  return [
    path.join(".agents/skills", slug, "SKILL.md"),
    path.join("skills", slug, "SKILL.md"),
  ].some((file) => fs.existsSync(file));
}

for (const doc of docs) {
  if (!fs.existsSync(doc)) continue;
  const text = fs.readFileSync(doc, "utf8");
  const pinned = text.match(/<!-- skills:pinned -->([\s\S]*?)<!-- \/skills:pinned -->/);
  if (!pinned) continue;
  const rows = pinned[1]!.matchAll(/\|\s*`\/([^`]+)`\s*\|/g);
  for (const row of rows) {
    const slug = row[1]!;
    if (!skillExists(slug)) errors.push(`${doc}: pinned skill /${slug} has no repo SKILL.md`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log("skill-docs ok");
