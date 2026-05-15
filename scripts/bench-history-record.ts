#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

type Verdict = {
  probe_id: string;
  index_verdict: string;
  retrieve_verdict: string;
  suspicious?: boolean;
};

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
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function git(cmd: string, cwd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function laneFromProbeId(probeId: string): string {
  const segments = probeId.split("_");
  return segments.length > 1 ? segments[1]! : "unknown";
}

function isPass(verdict: string): boolean {
  return verdict === "INDEX_PASS" || verdict === "RETRIEVE_PASS";
}

function isExcluded(verdict: string): boolean {
  return verdict.startsWith("INDEX_EXCLUDED_") || verdict.startsWith("RETRIEVE_EXCLUDED_");
}

const flags = parseFlags(process.argv.slice(2));
const artifacts = String(flags.artifacts || "");
const comment = String(flags.comment || "");
const force = !!flags.force;
const ledgerFlag = String(flags.ledger || ".bench-history/bench-gate-runs.jsonl");
const ledgerPath = path.resolve(ledgerFlag);
const repoRoot = path.resolve(".");

if (!artifacts) fail("usage: bun scripts/bench-history-record.ts --artifacts .bench-gate/<run-id> --comment \"<text>\" [--force] [--ledger PATH]");
if (!comment) fail("--comment is required");
if (comment.length < 1 || comment.length > 280) fail("comment must be 1-280 chars");
if (/\b\d+%/.test(comment) || /\b\d+\/\d+/.test(comment) || /\bcoverage\b/i.test(comment)) {
  fail("comment must not contain coverage numerals (\\d+%, \\d+/\\d+) or the word coverage; those come from gate.json");
}

const verdictPath = path.join(artifacts, "verdict.json");
const gatePath = path.join(artifacts, "gate.json");
const manifestPath = path.join(artifacts, "manifest.json");
for (const f of [verdictPath, gatePath, manifestPath]) {
  if (!fs.existsSync(f)) fail(`required file missing: ${f}`);
}

const verdictFile = readJson<{ run_id: string; verdicts: Verdict[] }>(verdictPath);
const gate = readJson<Record<string, unknown>>(gatePath);
const manifest = readJson<{ run_id: string; cli_version?: string; probes: Array<{ probe_id: string }> }>(manifestPath);

if (verdictFile.verdicts.length < manifest.probes.length) {
  fail(`verdict.json has ${verdictFile.verdicts.length} verdicts but manifest has ${manifest.probes.length} probes`);
}

const runId = verdictFile.run_id;
const probeIds = new Set(manifest.probes.map((p) => p.probe_id));
for (const v of verdictFile.verdicts) {
  if (!probeIds.has(v.probe_id)) fail(`verdict references unknown probe ${v.probe_id}`);
}

const cov = (gate.coverage ?? {}) as Record<string, unknown>;
const indexPass = Number(cov.index_pass ?? 0);
const indexTotal = Number(cov.index_total_indexable ?? cov.index_total ?? 0);
const retrievePass = Number(cov.retrieve_pass ?? 0);
const retrieveTotal = Number(cov.retrieve_total_retrievable ?? cov.retrieve_total ?? 0);
if (indexTotal === 0) fail("gate.json missing coverage.index_total_indexable");

const indexCoverage = indexTotal > 0 ? indexPass / indexTotal : 0;
const retrieveCoverage = retrieveTotal > 0 ? retrievePass / retrieveTotal : 0;

const byLane: Record<string, LaneCounts> = {};
const gateLanes = (cov.by_lane ?? {}) as Record<string, Record<string, number>>;
for (const [lane, lc] of Object.entries(gateLanes)) {
  byLane[lane] = {
    index_pass: Number(lc.index_pass ?? 0),
    index_total: Number(lc.indexable ?? lc.index_total ?? 0),
    retrieve_pass: Number(lc.retrieve_pass ?? 0),
    retrieve_total: Number(lc.retrievable ?? lc.retrieve_total ?? 0),
  };
}

let anchorPass = 0;
let anchorTotal = 0;
const passSet = new Set<string>();
const failSet = new Set<string>();
const excludedSet = new Set<string>();
const suspicious: string[] = [];

for (const v of verdictFile.verdicts) {
  const lane = laneFromProbeId(v.probe_id);
  if (!isExcluded(v.retrieve_verdict)) {
    if (isPass(v.retrieve_verdict)) passSet.add(v.probe_id);
    else failSet.add(v.probe_id);
  } else {
    excludedSet.add(v.probe_id);
  }
  if (lane === "anchor") {
    anchorTotal++;
    if (isPass(v.retrieve_verdict)) anchorPass++;
  }
  if (v.suspicious) suspicious.push(v.probe_id);
}

let priorRow: Row | null = null;
if (fs.existsSync(ledgerPath)) {
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: Row;
    try {
      parsed = JSON.parse(lines[i]!) as Row;
    } catch {
      continue;
    }
    if (parsed.run_id === runId) {
      if (!force) fail(`run_id ${runId} already recorded; pass --force to replace`);
      continue;
    }
    if (priorRow === null) {
      priorRow = parsed;
      break;
    }
  }
}

const newPasses: string[] = [];
const newFails: string[] = [];
const newExcluded: string[] = [];

if (priorRow) {
  const priorVerdictPath = path.join(`.bench-gate/${priorRow.run_id}`, "verdict.json");
  if (fs.existsSync(priorVerdictPath)) {
    const priorVerdict = readJson<{ verdicts: Verdict[] }>(priorVerdictPath);
    const priorPass = new Set<string>();
    const priorFail = new Set<string>();
    const priorExcluded = new Set<string>();
    for (const v of priorVerdict.verdicts) {
      if (isExcluded(v.retrieve_verdict)) priorExcluded.add(v.probe_id);
      else if (isPass(v.retrieve_verdict)) priorPass.add(v.probe_id);
      else priorFail.add(v.probe_id);
    }
    for (const id of passSet) if (!priorPass.has(id)) newPasses.push(id);
    for (const id of failSet) if (!priorFail.has(id) && priorPass.has(id)) newFails.push(id);
    for (const id of excludedSet) if (!priorExcluded.has(id)) newExcluded.push(id);
  }
}

const row: Row = {
  run_id: runId,
  ts: new Date().toISOString(),
  git_sha: git("rev-parse --short HEAD", repoRoot) || "unknown",
  cli_version: String(gate.cli_version ?? manifest.cli_version ?? "unknown"),
  index_pass: indexPass,
  index_total: indexTotal,
  index_coverage: Number(indexCoverage.toFixed(4)),
  retrieve_pass: retrievePass,
  retrieve_total: retrieveTotal,
  retrieve_coverage: Number(retrieveCoverage.toFixed(4)),
  anchor_pass: anchorPass,
  anchor_total: anchorTotal,
  by_lane: byLane,
  hostile_suspicious_probes: suspicious,
  new_passes: newPasses.sort(),
  new_fails: newFails.sort(),
  new_excluded: newExcluded.sort(),
  comment,
  commit_subject: git("log -1 --pretty=%s", repoRoot) || "",
  corpus_size: manifest.probes.length,
  gate_passed: !!gate.passed,
};

if (force && fs.existsSync(ledgerPath)) {
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const filtered = lines.filter((l) => {
    try { return (JSON.parse(l) as Row).run_id !== runId; } catch { return true; }
  });
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, filtered.length > 0 ? `${filtered.join("\n")}\n` : "");
}

fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);

console.log(JSON.stringify({
  ok: true,
  ledger: ledgerPath,
  run_id: row.run_id,
  index_coverage: row.index_coverage,
  retrieve_coverage: row.retrieve_coverage,
  anchor: `${row.anchor_pass}/${row.anchor_total}`,
  new_passes: row.new_passes,
  new_fails: row.new_fails,
  comment: row.comment,
}, null, 2));
