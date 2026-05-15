#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

type LaneCounts = { index_pass: number; index_total: number; retrieve_pass: number; retrieve_total: number };
type Row = {
  run_id: string;
  ts: string;
  git_sha: string;
  cli_version: string;
  index_pass: number;
  index_total: number;
  index_coverage: number;
  retrieve_pass: number;
  retrieve_total: number;
  retrieve_coverage: number;
  anchor_pass: number;
  anchor_total: number;
  by_lane: Record<string, LaneCounts>;
  hostile_suspicious_probes: string[];
  new_passes: string[];
  new_fails: string[];
  new_excluded: string[];
  comment: string;
  commit_subject: string;
  corpus_size: number;
  gate_passed: boolean;
};

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[key] = next; i++; } else { out[key] = true; }
  }
  return out;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function loadRows(ledgerPath: string): Row[] {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l) as Row; } catch { return null; }
    })
    .filter((r): r is Row => r !== null);
}

const flags = parseFlags(process.argv.slice(2));
const ledgerPath = path.resolve(String(flags.ledger || ".bench-history/bench-gate-runs.jsonl"));
const since = String(flags.since || "");

const rows = loadRows(ledgerPath);
if (rows.length === 0) fail(`no recorded runs found in ${ledgerPath}`);

let startIdx = 0;
if (since) {
  const idx = rows.findIndex((r) => r.run_id === since || r.git_sha === since || r.git_sha.startsWith(since));
  if (idx >= 0) startIdx = idx + 1;
  else fail(`no row matches --since ${since}; pass a run_id or git_sha from the ledger`);
}

const slice = rows.slice(startIdx);
if (slice.length === 0) fail(`no rows since ${since}`);

const latest = slice[slice.length - 1]!;
const prior = startIdx > 0 ? rows[startIdx - 1]! : rows[0]!;

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function dirArrow(delta: number): string {
  if (delta > 0.001) return "up";
  if (delta < -0.001) return "down";
  return "flat";
}

const indexDelta = latest.index_coverage - prior.index_coverage;
const retrieveDelta = latest.retrieve_coverage - prior.retrieve_coverage;

const lines: string[] = [];
lines.push("### Bench coverage");
lines.push("");
lines.push(`- index ${pct(latest.index_coverage)} (${latest.index_pass}/${latest.index_total}), ${dirArrow(indexDelta)} from ${pct(prior.index_coverage)} (${prior.index_pass}/${prior.index_total})`);
lines.push(`- retrieve ${pct(latest.retrieve_coverage)} (${latest.retrieve_pass}/${latest.retrieve_total}), ${dirArrow(retrieveDelta)} from ${pct(prior.retrieve_coverage)} (${prior.retrieve_pass}/${prior.retrieve_total})`);
lines.push(`- anchor lane ${latest.anchor_pass}/${latest.anchor_total}${latest.anchor_pass === latest.anchor_total ? " (regression-free)" : " (anchor regression — release blocker)"}`);

const aggregateNewPasses = new Set<string>();
const aggregateNewFails = new Set<string>();
const aggregateNewExcluded = new Set<string>();
for (const row of slice) {
  for (const id of row.new_passes ?? []) aggregateNewPasses.add(id);
  for (const id of row.new_fails ?? []) aggregateNewFails.add(id);
  for (const id of row.new_excluded ?? []) aggregateNewExcluded.add(id);
}
// A probe that flipped pass -> fail -> pass within the window only counts as pass
for (const id of aggregateNewPasses) aggregateNewFails.delete(id);

if (aggregateNewPasses.size > 0) {
  lines.push("");
  lines.push("### Newly passing probes");
  lines.push("");
  for (const id of [...aggregateNewPasses].sort()) {
    const suspicious = latest.hostile_suspicious_probes.includes(id);
    lines.push(`- ${id}${suspicious ? " (suspicious - hostile lane PASS)" : ""}`);
  }
}

if (aggregateNewFails.size > 0) {
  lines.push("");
  lines.push("### Newly failing probes (regressions)");
  lines.push("");
  for (const id of [...aggregateNewFails].sort()) lines.push(`- ${id}`);
}

const comments = slice.map((r) => r.comment).filter((c) => c.trim().length > 0);
if (comments.length > 0) {
  lines.push("");
  lines.push("### Notes");
  lines.push("");
  for (const c of comments) lines.push(`- ${c}`);
}

console.log(lines.join("\n"));
