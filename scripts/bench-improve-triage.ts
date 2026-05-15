#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

type Probe = {
  probe_id: string;
  lane: string;
  auth?: string;
  difficulty?: string;
  strategy?: string;
  intent: string;
  url: string;
};

type Verdict = {
  probe_id: string;
  index_verdict: string;
  index_reasoning: string;
  retrieve_verdict: string;
  retrieve_reasoning: string;
  evidence_quote: string;
  suspicious: boolean;
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

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function quote(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

const flags = parseFlags(process.argv.slice(2));
const artifacts = String(flags.artifacts || "");
if (!artifacts) {
  console.error("usage: bun scripts/bench-improve-triage.ts --artifacts .bench-gate/<run-id>");
  process.exit(1);
}

const manifestPath = path.join(artifacts, "manifest.json");
const verdictPath = path.join(artifacts, "verdict.json");
const gatePath = path.join(artifacts, "gate.json");
for (const file of [manifestPath, verdictPath]) {
  if (!fs.existsSync(file)) {
    console.error(`missing required file: ${file}`);
    process.exit(1);
  }
}

const manifest = readJson<{ run_id: string; probes: Probe[] }>(manifestPath);
const verdictFile = readJson<{ run_id: string; verdicts: Verdict[] }>(verdictPath);
const gate = fs.existsSync(gatePath) ? readJson<{ passed?: boolean; coverage?: unknown; checks?: Array<{ name: string; passed: boolean; detail: string }> }>(gatePath) : null;
const byProbe = new Map(manifest.probes.map((probe) => [probe.probe_id, probe]));
const failures = verdictFile.verdicts.filter((verdict) =>
  (!verdict.index_verdict.startsWith("INDEX_EXCLUDED") && verdict.index_verdict !== "INDEX_PASS") ||
  (!verdict.retrieve_verdict.startsWith("RETRIEVE_EXCLUDED") && verdict.retrieve_verdict !== "RETRIEVE_PASS") ||
  verdict.suspicious,
);

const lines: string[] = [];
lines.push(`# Bench Improvement Plan - ${manifest.run_id}`);
lines.push("");
lines.push("This file is a triage artifact. It is not a verdict source. Codex must inspect the referenced artifacts before editing code.");
lines.push("");
if (gate) {
  lines.push(`- gate: ${gate.passed ? "PASS" : "FAIL"}`);
  for (const check of gate.checks ?? []) {
    lines.push(`- ${check.passed ? "ok" : "block"}: ${check.name} - ${check.detail}`);
  }
  lines.push("");
}
lines.push(`- failing_or_suspicious_probes: ${failures.length}`);
lines.push("");

for (const verdict of failures) {
  const probe = byProbe.get(verdict.probe_id);
  const dir = path.join(artifacts, verdict.probe_id);
  lines.push(`## ${verdict.probe_id}`);
  if (probe) {
    lines.push(`- lane: ${probe.lane}`);
    if (probe.auth) lines.push(`- auth: ${probe.auth}`);
    if (probe.difficulty) lines.push(`- difficulty: ${probe.difficulty}`);
    if (probe.strategy) lines.push(`- strategy: ${probe.strategy}`);
    lines.push(`- intent: ${probe.intent}`);
    lines.push(`- url: ${probe.url}`);
  }
  lines.push(`- index_verdict: ${verdict.index_verdict}`);
  lines.push(`- retrieve_verdict: ${verdict.retrieve_verdict}`);
  lines.push(`- suspicious: ${verdict.suspicious}`);
  lines.push(`- index_reasoning: ${quote(verdict.index_reasoning)}`);
  lines.push(`- retrieve_reasoning: ${quote(verdict.retrieve_reasoning)}`);
  lines.push(`- evidence_quote: ${quote(verdict.evidence_quote)}`);
  lines.push("");
  lines.push("Artifacts to inspect before patching:");
  for (const name of [
    "capture.meta.json",
    "index.store.json",
    "resolve.shortlist.json",
    "resolve.pick.json",
    "execute.input.json",
    "execute.response.raw",
    "execute.meta.json",
  ]) {
    lines.push(`- ${path.join(dir, name)}`);
  }
  lines.push("");
  lines.push("Patch rule: fix the root cause, add a focused regression guardrail, rerun this probe or a small lane slice, then rejudge from artifacts.");
  lines.push("");
}

if (failures.length === 0) {
  lines.push("No failing or suspicious probes. If `gate.json` passed, run compare with `--stamp` and commit `.bench-gate/stamp.json`.");
}

const outPath = path.join(artifacts, "improvement-plan.md");
fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
console.log(outPath);
