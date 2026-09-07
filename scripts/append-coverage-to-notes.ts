#!/usr/bin/env bun
/**
 * Append the coverage delta to .release-notes.md for every release.
 *
 * Reads ~/.unbrowse/benchmark-history.jsonl, takes the latest run (this
 * release) and the previous run (last release), and writes a "## Coverage"
 * section showing the product-success-rate delta.
 *
 * Wired into .release-it.json `after:bump` hook so every release notes file
 * ships with the honest coverage number. Per Lewis: "each release should be
 * marked with the coverage improvements."
 *
 * Rules:
 *  - Only appends if the file doesn't already contain a "## Coverage" section
 *  - Silent no-op if the history file has <1 run
 *  - Delta is computed against the latest run with corpus_size > 0 before the
 *    current one
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const root = import.meta.dir + "/..";
const notesPath = join(root, ".release-notes.md");
const historyPath = join(homedir(), ".unbrowse", "benchmark-history.jsonl");

if (!existsSync(historyPath)) {
	console.error("[append-coverage] no benchmark history found — skipping");
	process.exit(0);
}

type Row = {
	version?: string;
	timestamp?: string;
	corpus_size?: number;
	pass?: number;
	product_fail?: number;
	browser_block?: number;
	product_success_rate?: number;
	host?: string;
};

const rows: Row[] = readFileSync(historyPath, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => {
		try {
			return JSON.parse(l) as Row;
		} catch {
			return null;
		}
	})
	.filter((r): r is Row => r !== null && (r.corpus_size ?? 0) > 0);

if (rows.length === 0) {
	console.error("[append-coverage] history has no scored runs — skipping");
	process.exit(0);
}

const latest = rows[rows.length - 1];
const prev = rows.length > 1 ? rows[rows.length - 2] : null;

let section = "## Coverage\n\n";
section += `**${latest.product_success_rate ?? 0}% product success rate** on a ${latest.corpus_size}-URL real-world corpus `;
section += `(${latest.pass ?? 0} pass, ${latest.product_fail ?? 0} product-fail, ${latest.browser_block ?? 0} browser-block).\n\n`;

if (prev && prev.product_success_rate !== undefined && latest.product_success_rate !== undefined) {
	const delta = latest.product_success_rate - prev.product_success_rate;
	const direction = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
	const deltaStr = delta === 0 ? "no change" : `${direction} ${Math.abs(delta).toFixed(1)}pp`;
	section += `Delta vs previous run (${prev.product_success_rate}% on ${prev.corpus_size} URLs): ${deltaStr}.\n\n`;
}

section += `Browser-level blocks are excluded from the denominator (site actively defeated the headless browser via anti-bot, auth wall, or empty capture). See \`~/.unbrowse/benchmark-history.jsonl\` for the full history.\n`;

// Read existing notes, skip if Coverage already present
let existing = "";
if (existsSync(notesPath)) {
	existing = readFileSync(notesPath, "utf8");
	if (existing.includes("## Coverage")) {
		console.error("[append-coverage] .release-notes.md already has a Coverage section — skipping");
		process.exit(0);
	}
}

const combined = existing.trimEnd() + "\n\n" + section;
writeFileSync(notesPath, combined);
console.error(`[append-coverage] wrote coverage section to ${notesPath}`);
