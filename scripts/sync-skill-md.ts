#!/usr/bin/env bun
/**
 * Syncs the CLI_REFERENCE from src/cli.ts into the SKILL.md flags section.
 * Replaces content between <!-- CLI_REFERENCE_START --> and <!-- CLI_REFERENCE_END --> markers.
 */

import { CLI_REFERENCE } from "../src/cli.ts";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const SKILL_MD_PATH = resolve(import.meta.dir, "..", "SKILL.md");
const START_MARKER = "<!-- CLI_REFERENCE_START -->";
const END_MARKER = "<!-- CLI_REFERENCE_END -->";

function generateMarkdown(): string {
  const r = CLI_REFERENCE;
  const lines: string[] = [START_MARKER];

  lines.push("## CLI Flags");
  lines.push("");
  lines.push("**Auto-generated from `src/cli.ts CLI_REFERENCE` — do not edit manually. Run `bun scripts/sync-skill-md.ts` to sync.**");

  // Commands table
  lines.push("");
  lines.push("### Commands");
  lines.push("");
  lines.push("| Command | Usage | Description |");
  lines.push("|---------|-------|-------------|");
  for (const c of r.commands) {
    const usage = c.usage ? `\`${c.usage}\`` : "";
    lines.push(`| \`${c.name}\` | ${usage} | ${c.desc} |`);
  }

  // Global flags table
  lines.push("");
  lines.push("### Global flags");
  lines.push("");
  lines.push("| Flag | Description |");
  lines.push("|------|-------------|");
  for (const f of r.globalFlags) {
    lines.push(`| \`${f.flag}\` | ${f.desc} |`);
  }

  // resolve/execute flags table
  lines.push("");
  lines.push("### resolve/execute flags");
  lines.push("");
  lines.push("| Flag | Description |");
  lines.push("|------|-------------|");
  for (const f of r.resolveExecuteFlags) {
    lines.push(`| \`${f.flag}\` | ${f.desc} |`);
  }

  lines.push(END_MARKER);
  return lines.join("\n");
}

function main(): void {
  const content = readFileSync(SKILL_MD_PATH, "utf-8");

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    console.error(`Markers not found in ${SKILL_MD_PATH}. Add ${START_MARKER} and ${END_MARKER} markers.`);
    process.exit(1);
  }

  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + END_MARKER.length);
  const updated = before + generateMarkdown() + after;

  if (updated === content) {
    console.log("SKILL.md is already in sync.");
    return;
  }

  writeFileSync(SKILL_MD_PATH, updated);
  console.log("SKILL.md updated from CLI_REFERENCE.");
}

main();
