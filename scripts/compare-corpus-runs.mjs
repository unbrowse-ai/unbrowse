#!/usr/bin/env node
/**
 * compare-corpus-runs.mjs — compare two corpus-run snapshots side by side.
 *
 * Usage:
 *   node scripts/compare-corpus-runs.mjs <baseline.json> <candidate.json>
 *
 * Snapshot format (produced by `unbrowse corpus-run`):
 * {
 *   git_sha: string,
 *   timestamp: string,
 *   total_runtime_ms: number,
 *   results: Array<{
 *     id: string,
 *     capture: "ok" | "error",
 *     endpoints: number,
 *     requests: number,
 *     resolve_endpoints: number,
 *     verdict: "pass" | "fail" | "skip",
 *     attempts: number,
 *     notes: string,
 *   }>
 * }
 *
 * Output:
 *   - Per-site delta table (endpoints, verdict changes)
 *   - Summary: regressions, improvements, stable
 *   - Exit code 1 if any regressions detected
 */

import { readFileSync } from "node:fs";

const [, , baselinePath, candidatePath] = process.argv;

if (!baselinePath || !candidatePath) {
  console.error("Usage: node scripts/compare-corpus-runs.mjs <baseline.json> <candidate.json>");
  process.exit(1);
}

function loadSnapshot(path) {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read ${path}: ${err.message}`);
    process.exit(1);
  }
}

function validateSnapshot(snap, path) {
  if (!snap || typeof snap !== "object") {
    console.error(`${path}: not a valid JSON object`);
    process.exit(1);
  }
  if (!Array.isArray(snap.results)) {
    console.error(`${path}: missing 'results' array. Got keys: ${Object.keys(snap).join(", ")}`);
    console.error("Make sure the snapshot was produced by 'unbrowse corpus-run' (not an older format).");
    process.exit(1);
  }
  return snap;
}

const baseline = validateSnapshot(loadSnapshot(baselinePath), baselinePath);
const candidate = validateSnapshot(loadSnapshot(candidatePath), candidatePath);

// Index by id
const baseMap = Object.fromEntries(baseline.results.map(r => [r.id, r]));
const candMap = Object.fromEntries(candidate.results.map(r => [r.id, r]));

// All site ids across both runs
const allIds = new Set([...baseline.results.map(r => r.id), ...candidate.results.map(r => r.id)]);

const regressions = [];
const improvements = [];
const stable = [];
const newSites = [];
const dropped = [];

for (const id of allIds) {
  const b = baseMap[id];
  const c = candMap[id];

  if (!b) {
    newSites.push({ id, candidate: c });
    continue;
  }
  if (!c) {
    dropped.push({ id, baseline: b });
    continue;
  }

  const epDelta = c.endpoints - b.endpoints;
  const verdictChanged = b.verdict !== c.verdict;

  const entry = { id, baseline: b, candidate: c, epDelta, verdictChanged };

  if (verdictChanged && b.verdict === "pass" && c.verdict !== "pass") {
    regressions.push(entry);
  } else if (verdictChanged && b.verdict !== "pass" && c.verdict === "pass") {
    improvements.push(entry);
  } else if (epDelta < 0 && c.verdict !== "pass") {
    regressions.push(entry);
  } else if (epDelta > 0) {
    improvements.push(entry);
  } else {
    stable.push(entry);
  }
}

// --- Render ---

const PAD = 30;

function row(id, bEp, cEp, bVerdict, cVerdict, attempts, notes) {
  const delta = cEp - bEp;
  const deltaStr = delta > 0 ? `+${delta}` : String(delta);
  const verdictChange = bVerdict !== cVerdict ? `${bVerdict}→${cVerdict}` : bVerdict;
  const flag = delta > 0 ? "↑" : delta < 0 ? "↓" : " ";
  return `  ${id.padEnd(PAD)}  ep: ${String(bEp).padStart(3)} → ${String(cEp).padStart(3)} (${deltaStr.padStart(4)}) ${flag}  verdict: ${verdictChange.padEnd(14)}  attempts: ${attempts}  ${notes ?? ""}`;
}

console.log(`\nCorpus run comparison`);
console.log(`  Baseline:  ${baseline.git_sha ?? "?"}  ${baseline.timestamp ?? ""}  (${baseline.results.length} sites)`);
console.log(`  Candidate: ${candidate.git_sha ?? "?"}  ${candidate.timestamp ?? ""}  (${candidate.results.length} sites)`);
console.log("");

if (regressions.length > 0) {
  console.log(`REGRESSIONS (${regressions.length}):`);
  for (const e of regressions) {
    console.log(row(e.id, e.baseline.endpoints, e.candidate.endpoints, e.baseline.verdict, e.candidate.verdict, e.candidate.attempts, e.candidate.notes));
  }
  console.log("");
}

if (improvements.length > 0) {
  console.log(`Improvements (${improvements.length}):`);
  for (const e of improvements) {
    console.log(row(e.id, e.baseline.endpoints, e.candidate.endpoints, e.baseline.verdict, e.candidate.verdict, e.candidate.attempts, e.candidate.notes));
  }
  console.log("");
}

if (stable.length > 0) {
  console.log(`Stable (${stable.length}):`);
  for (const e of stable) {
    console.log(row(e.id, e.baseline.endpoints, e.candidate.endpoints, e.baseline.verdict, e.candidate.verdict, e.candidate.attempts, e.candidate.notes));
  }
  console.log("");
}

if (newSites.length > 0) {
  console.log(`New sites in candidate (${newSites.length}):`);
  for (const e of newSites) {
    console.log(`  ${e.id.padEnd(PAD)}  ep: ${String(e.candidate.endpoints).padStart(3)}  verdict: ${e.candidate.verdict}`);
  }
  console.log("");
}

if (dropped.length > 0) {
  console.log(`Sites only in baseline (${dropped.length}):`);
  for (const e of dropped) {
    console.log(`  ${e.id.padEnd(PAD)}  ep: ${String(e.baseline.endpoints).padStart(3)}  verdict: ${e.baseline.verdict}`);
  }
  console.log("");
}

console.log(`Summary: ${regressions.length} regressions | ${improvements.length} improvements | ${stable.length} stable | ${newSites.length} new | ${dropped.length} dropped`);

if (regressions.length > 0) {
  console.error("\nFAIL: regressions detected");
  process.exit(1);
} else {
  console.log("\nOK: no regressions");
  process.exit(0);
}
