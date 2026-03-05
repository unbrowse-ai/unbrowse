#!/usr/bin/env bun
/**
 * Collect commits and diff since the last tag into a structured summary.
 * Used as a fallback when Claude Code hasn't pre-written .release-notes.md.
 *
 * The intended flow:
 *   1. Claude Code reads commits/diff, writes polished .release-notes.md
 *   2. `bun run release` picks up the pre-written notes
 *
 * If .release-notes.md already exists (written by the agent), this script
 * is a no-op. Otherwise it writes a raw commit summary as fallback.
 */

import { existsSync } from "fs";

const root = import.meta.dir + "/..";
const notesPath = root + "/.release-notes.md";

// If the agent already wrote release notes, skip
if (existsSync(notesPath)) {
	console.error(".release-notes.md already exists — using agent-written notes");
	process.exit(0);
}

console.error("No .release-notes.md found — generating fallback from commits");

// Find the last tag
const lastTag = Bun.spawnSync(["git", "describe", "--tags", "--match=v*", "--abbrev=0"], {
	cwd: root,
});
const tag = lastTag.stdout.toString().trim();
const range = tag ? `${tag}..HEAD` : "HEAD~30..HEAD";

// Get commit messages grouped by type
const logProc = Bun.spawnSync(
	["git", "log", range, "--format=%s"],
	{ cwd: root },
);
const lines = logProc.stdout.toString().trim().split("\n").filter(Boolean);

const features: string[] = [];
const fixes: string[] = [];
const other: string[] = [];

for (const line of lines) {
	if (line.startsWith("feat")) features.push(line.replace(/^feat(\(.*?\))?:\s*/, ""));
	else if (line.startsWith("fix")) fixes.push(line.replace(/^fix(\(.*?\))?:\s*/, ""));
	else if (!line.startsWith("chore") && !line.startsWith("docs") && !line.startsWith("test"))
		other.push(line);
}

let md = "";
if (features.length) md += "## What's New\n\n" + features.map((f) => `- ${f}`).join("\n") + "\n\n";
if (fixes.length) md += "## Fixes\n\n" + fixes.map((f) => `- ${f}`).join("\n") + "\n\n";
if (other.length) md += "## Other\n\n" + other.map((o) => `- ${o}`).join("\n") + "\n\n";

if (!md) md = "Maintenance release.\n";

await Bun.write(notesPath, md.trim() + "\n");
console.error("Fallback release notes written to .release-notes.md");
