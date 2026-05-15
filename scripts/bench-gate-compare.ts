#!/usr/bin/env bun
// bench-gate-compare.ts — release-gate threshold + regression check.
//
// Reads `verdict.json` from a bench-gate run (produced by bench-gate-judge.ts)
// and `harness/probes/bench-gate-baseline.json`. Renders a deterministic
// pass/fail over agent-judged verdicts.
//
// Invariants (CLAUDE.md "harness collects, agent judges"):
//   - never opens an LLM or shells out to unbrowse
//   - never assigns a verdict to a probe; only diffs PASS-shape across runs
//   - reads only from disk; writes only `gate.{json,md}` next to verdict.json
//
// Exit codes:
//   0 — PASS (all thresholds met, no per-probe regressions, no new hostile-lane suspicious)
//   2 — FAIL (one or more checks failed; gate.md lists which)
//   1 — usage / IO error
//
// Modes:
//   --strict             default; FAIL on any threshold breach
//   --soft               render the report but always exit 0 (PR comment mode)
//   --freeze             update baseline file with current verdicts (no compare)

import fs from "node:fs";
import path from "node:path";

interface Verdict {
  probe_id: string;
  index_verdict: string;
  index_reasoning: string;
  retrieve_verdict: string;
  retrieve_reasoning: string;
  evidence_quote: string;
  suspicious: boolean;
}

interface VerdictFile {
  run_id: string;
  verdicts: Verdict[];
}

interface ManifestProbe { probe_id: string; lane: string; intent: string; url: string }
interface Manifest { run_id: string; corpus: string; cli_version: string; probes: ManifestProbe[] }

interface Baseline {
  schema_version: number;
  thresholds: {
    index_coverage_min: number;
    retrieve_coverage_min: number;
    anchor_must_pass: boolean;
    max_new_suspicious_hostile: number;
  };
  baseline_run: string | null;
  baseline_cli_version: string | null;
  baseline_frozen_at: string | null;
  per_probe_baseline: Record<string, { index: string; retrieve: string; suspicious: boolean }>;
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[key] = next; i++; } else { out[key] = "true"; }
  }
  return out;
}

function readJson<T>(p: string): T {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as T;
}

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }

interface ComputedCoverage {
  index_pass: number;
  index_total_indexable: number;
  index_coverage: number;
  retrieve_pass: number;
  retrieve_total_retrievable: number;
  retrieve_coverage: number;
  suspicious_count: number;
  by_lane: Record<string, { index_pass: number; indexable: number; retrieve_pass: number; retrievable: number }>;
}

function coverageFromVerdicts(verdicts: Verdict[], manifest: Manifest): ComputedCoverage {
  const laneByProbe = new Map(manifest.probes.map(p => [p.probe_id, p.lane]));
  let indexPass = 0, indexable = 0, retrievePass = 0, retrievable = 0, suspicious = 0;
  const byLane: ComputedCoverage["by_lane"] = {};
  for (const v of verdicts) {
    const lane = laneByProbe.get(v.probe_id) ?? "unknown";
    if (!byLane[lane]) byLane[lane] = { index_pass: 0, indexable: 0, retrieve_pass: 0, retrievable: 0 };
    if (!v.index_verdict.startsWith("INDEX_EXCLUDED")) {
      indexable++; byLane[lane].indexable++;
      if (v.index_verdict === "INDEX_PASS") { indexPass++; byLane[lane].index_pass++; }
    }
    if (!v.retrieve_verdict.startsWith("RETRIEVE_EXCLUDED")) {
      retrievable++; byLane[lane].retrievable++;
      if (v.retrieve_verdict === "RETRIEVE_PASS") { retrievePass++; byLane[lane].retrieve_pass++; }
    }
    if (v.suspicious) suspicious++;
  }
  return {
    index_pass: indexPass,
    index_total_indexable: indexable,
    index_coverage: indexable ? indexPass / indexable : 0,
    retrieve_pass: retrievePass,
    retrieve_total_retrievable: retrievable,
    retrieve_coverage: retrievable ? retrievePass / retrievable : 0,
    suspicious_count: suspicious,
    by_lane: byLane,
  };
}

interface GateResult {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
  coverage: ComputedCoverage;
  per_probe_regressions: { probe_id: string; was: string; now: string; field: "index" | "retrieve" }[];
  new_suspicious_hostile: string[];
}

function evaluate(verdicts: Verdict[], manifest: Manifest, baseline: Baseline): GateResult {
  const cov = coverageFromVerdicts(verdicts, manifest);
  const checks: GateResult["checks"] = [];

  checks.push({
    name: "index_coverage >= floor",
    passed: cov.index_coverage >= baseline.thresholds.index_coverage_min,
    detail: `${pct(cov.index_coverage)} vs floor ${pct(baseline.thresholds.index_coverage_min)} (${cov.index_pass}/${cov.index_total_indexable})`,
  });
  checks.push({
    name: "retrieve_coverage >= floor",
    passed: cov.retrieve_coverage >= baseline.thresholds.retrieve_coverage_min,
    detail: `${pct(cov.retrieve_coverage)} vs floor ${pct(baseline.thresholds.retrieve_coverage_min)} (${cov.retrieve_pass}/${cov.retrieve_total_retrievable})`,
  });

  const laneByProbe = new Map(manifest.probes.map(p => [p.probe_id, p.lane]));
  if (baseline.thresholds.anchor_must_pass) {
    const anchorVerdicts = verdicts.filter(v => laneByProbe.get(v.probe_id) === "anchor");
    const anchorFails = anchorVerdicts.filter(v =>
      (v.index_verdict !== "INDEX_PASS" && !v.index_verdict.startsWith("INDEX_EXCLUDED")) ||
      (v.retrieve_verdict !== "RETRIEVE_PASS" && !v.retrieve_verdict.startsWith("RETRIEVE_EXCLUDED")),
    );
    checks.push({
      name: "anchor lane must pass",
      passed: anchorFails.length === 0,
      detail: anchorFails.length === 0
        ? `all ${anchorVerdicts.length} anchor probes PASS`
        : `${anchorFails.length} anchor probe(s) failing: ${anchorFails.map(v => `${v.probe_id}[idx=${v.index_verdict},ret=${v.retrieve_verdict}]`).join(", ")}`,
    });
  }

  const perProbeRegressions: GateResult["per_probe_regressions"] = [];
  for (const v of verdicts) {
    const prior = baseline.per_probe_baseline[v.probe_id];
    if (!prior) continue;
    if (prior.index === "INDEX_PASS" && v.index_verdict !== "INDEX_PASS" && !v.index_verdict.startsWith("INDEX_EXCLUDED")) {
      perProbeRegressions.push({ probe_id: v.probe_id, was: prior.index, now: v.index_verdict, field: "index" });
    }
    if (prior.retrieve === "RETRIEVE_PASS" && v.retrieve_verdict !== "RETRIEVE_PASS" && !v.retrieve_verdict.startsWith("RETRIEVE_EXCLUDED")) {
      perProbeRegressions.push({ probe_id: v.probe_id, was: prior.retrieve, now: v.retrieve_verdict, field: "retrieve" });
    }
  }
  checks.push({
    name: "no per-probe PASS→FAIL regression",
    passed: perProbeRegressions.length === 0,
    detail: perProbeRegressions.length === 0
      ? Object.keys(baseline.per_probe_baseline).length === 0
        ? "no per-probe baseline frozen yet (informational)"
        : `${Object.keys(baseline.per_probe_baseline).length} baselined probes all preserved`
      : perProbeRegressions.map(r => `${r.probe_id}.${r.field}: ${r.was} → ${r.now}`).join("; "),
  });

  const newSuspicious: string[] = [];
  for (const v of verdicts) {
    if (!v.suspicious) continue;
    const prior = baseline.per_probe_baseline[v.probe_id];
    if (!prior || prior.suspicious !== true) newSuspicious.push(v.probe_id);
  }
  checks.push({
    name: "no new hostile-lane suspicious",
    passed: newSuspicious.length <= baseline.thresholds.max_new_suspicious_hostile,
    detail: newSuspicious.length === 0
      ? "none"
      : `${newSuspicious.length} new (max ${baseline.thresholds.max_new_suspicious_hostile}): ${newSuspicious.join(", ")}`,
  });

  return {
    passed: checks.every(c => c.passed),
    checks,
    coverage: cov,
    per_probe_regressions: perProbeRegressions,
    new_suspicious_hostile: newSuspicious,
  };
}

function renderMarkdown(result: GateResult, manifest: Manifest, baseline: Baseline): string {
  const lines: string[] = [];
  lines.push(`# Bench-Gate Verdict vs Baseline — ${manifest.run_id}`);
  lines.push("");
  lines.push(`- **gate**: ${result.passed ? "PASS" : "**FAIL**"}`);
  lines.push(`- cli_version: ${manifest.cli_version}`);
  lines.push(`- baseline_run: ${baseline.baseline_run ?? "_(unset — freeze with `bun run bench:gate:freeze` after a canonical run)_"}`);
  lines.push(`- baseline_cli_version: ${baseline.baseline_cli_version ?? "n/a"}`);
  lines.push(`- index_coverage: **${pct(result.coverage.index_coverage)}** (${result.coverage.index_pass}/${result.coverage.index_total_indexable} indexable)`);
  lines.push(`- retrieve_coverage: **${pct(result.coverage.retrieve_coverage)}** (${result.coverage.retrieve_pass}/${result.coverage.retrieve_total_retrievable} retrievable)`);
  lines.push(`- hostile-lane suspicious: ${result.coverage.suspicious_count} (new vs baseline: ${result.new_suspicious_hostile.length})`);
  lines.push("");
  lines.push("## Checks");
  for (const c of result.checks) {
    lines.push(`- ${c.passed ? "✅" : "❌"} **${c.name}** — ${c.detail}`);
  }
  lines.push("");
  lines.push("## By-lane breakdown");
  lines.push("| Lane | index PASS / indexable | retrieve PASS / retrievable |");
  lines.push("|------|------------------------|------------------------------|");
  for (const lane of ["anchor", "semantic-rank", "graphql", "ssr-list", "auth-gated", "hostile"]) {
    const b = result.coverage.by_lane[lane];
    if (!b) { lines.push(`| ${lane} | _no probes_ | _no probes_ |`); continue; }
    lines.push(`| ${lane} | ${b.index_pass} / ${b.indexable} | ${b.retrieve_pass} / ${b.retrievable} |`);
  }
  if (result.per_probe_regressions.length > 0) {
    lines.push("");
    lines.push("## Per-probe regressions");
    for (const r of result.per_probe_regressions) {
      lines.push(`- \`${r.probe_id}.${r.field}\`: \`${r.was}\` → \`${r.now}\``);
    }
  }
  if (result.new_suspicious_hostile.length > 0) {
    lines.push("");
    lines.push("## New hostile-lane PASS (suspicious)");
    lines.push("These probes are on hostile sites we expect to BROWSER_BLOCK. A new PASS here may be an anti-bot honey-trap. Review.");
    for (const id of result.new_suspicious_hostile) lines.push(`- \`${id}\``);
  }
  return lines.join("\n");
}

function freeze(verdicts: Verdict[], manifest: Manifest, baseline: Baseline, baselinePath: string): void {
  const next: Baseline = {
    schema_version: baseline.schema_version,
    thresholds: baseline.thresholds,
    baseline_run: manifest.run_id,
    baseline_cli_version: manifest.cli_version,
    baseline_frozen_at: new Date().toISOString(),
    per_probe_baseline: Object.fromEntries(verdicts.map(v => [
      v.probe_id,
      { index: v.index_verdict, retrieve: v.retrieve_verdict, suspicious: v.suspicious },
    ])),
  };
  const body = JSON.stringify(next, null, 2) + "\n";
  fs.writeFileSync(baselinePath, body);
  console.error(`[freeze] wrote baseline with ${verdicts.length} probes -> ${baselinePath}`);
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const artifacts = flags.artifacts;
  if (!artifacts) {
    console.error("usage: bun scripts/bench-gate-compare.ts --artifacts .bench-gate/<run-id> [--baseline path] [--strict|--soft|--freeze]");
    process.exit(1);
  }
  const baselinePath = flags.baseline ?? path.join(process.cwd(), "harness/probes/bench-gate-baseline.json");
  const verdictPath = path.join(artifacts, "verdict.json");
  const manifestPath = path.join(artifacts, "manifest.json");
  if (!fs.existsSync(verdictPath)) {
    console.error(`verdict.json not found at ${verdictPath} — run bench-gate-judge first`);
    process.exit(1);
  }
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest.json not found at ${manifestPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(baselinePath)) {
    console.error(`baseline not found at ${baselinePath}`);
    process.exit(1);
  }
  const verdictFile = readJson<VerdictFile>(verdictPath);
  const manifest = readJson<Manifest>(manifestPath);
  const baseline = readJson<Baseline>(baselinePath);

  if (flags.freeze) {
    freeze(verdictFile.verdicts, manifest, baseline, baselinePath);
    return;
  }
  const result = evaluate(verdictFile.verdicts, manifest, baseline);
  const md = renderMarkdown(result, manifest, baseline);
  fs.writeFileSync(path.join(artifacts, "gate.md"), md);
  fs.writeFileSync(path.join(artifacts, "gate.json"), JSON.stringify({
    run_id: manifest.run_id,
    cli_version: manifest.cli_version,
    baseline_run: baseline.baseline_run,
    passed: result.passed,
    coverage: result.coverage,
    checks: result.checks,
    per_probe_regressions: result.per_probe_regressions,
    new_suspicious_hostile: result.new_suspicious_hostile,
  }, null, 2));
  console.error(md);

  // --stamp: on PASS, write a release-it prerelease stamp pinning this run
  // to the current git HEAD. The bench-gate-prerelease.sh hook checks for
  // this stamp before allowing a release. Stamp is NEVER written on FAIL.
  if (flags.stamp && result.passed) {
    const stampPath = path.join(process.cwd(), ".bench-gate", "stamp.json");
    const stampDir = path.dirname(stampPath);
    if (!fs.existsSync(stampDir)) fs.mkdirSync(stampDir, { recursive: true });
    let commitSha = "";
    try {
      const { execSync } = require("node:child_process");
      commitSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch (e) {
      console.error(`[stamp] warning: git rev-parse failed — stamp will lack commit_sha (${e})`);
    }
    const stamp = {
      schema_version: 1,
      commit_sha: commitSha,
      run_id: manifest.run_id,
      cli_version: manifest.cli_version,
      baseline_run: baseline.baseline_run,
      gate_passed: true,
      stamped_at: new Date().toISOString(),
      index_coverage: result.coverage.index_coverage,
      retrieve_coverage: result.coverage.retrieve_coverage,
      artifact_dir: path.relative(process.cwd(), artifacts),
    };
    fs.writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + "\n");
    console.error(`[stamp] wrote release-it prerelease stamp → ${stampPath}`);
    console.error(`[stamp] commit this stamp file (\`git add ${stampPath}\`) to unblock release-it`);
  }

  if (flags.soft) { process.exit(0); }
  process.exit(result.passed ? 0 : 2);
}

main();
