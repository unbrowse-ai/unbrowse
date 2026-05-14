#!/usr/bin/env bun
// bench-gate-judge.ts — release-gate judge. Reads harness artifacts. Renders verdicts.
// See docs/release-gate-bench-plan.md + harness/probes/GATE_JUDGE.md
//
// Judge model: the Claude Code agent itself, invoked headlessly as
//   `claude -p --bare --system-prompt <rubric> --json-schema <schema>
//          --output-format json --model sonnet`
//
// Why subprocess instead of Anthropic SDK directly:
//   - reuses the agent's existing auth (no ANTHROPIC_API_KEY ceremony)
//   - "harness collects, agent judges" — the agent is literally the judge
//   - no SDK dependency to track in package.json
//
// Invariants (CLAUDE.md):
//   - never shells out to `unbrowse`
//   - reads only from .bench-gate/<run-id>/
//   - writes only verdict.{json,md}
//
// Dry-run mode emits stub verdicts without calling claude (for harness↔judge
// contract testing in CI without burning agent credits).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface ProbeRef { probe_id: string; lane: string; intent: string; url: string; }
interface Manifest { run_id: string; corpus: string; cli_version: string; node_version: string; started_at: string; probes: ProbeRef[]; }

const INDEX_VERDICTS = ["INDEX_PASS","INDEX_FAIL_NO_ENDPOINTS","INDEX_FAIL_WRONG_SHAPE","INDEX_EXCLUDED_BLOCKED","INDEX_EXCLUDED_AUTH"] as const;
const RETRIEVE_VERDICTS = ["RETRIEVE_PASS","RETRIEVE_FAIL_WRONG_ENTITY","RETRIEVE_FAIL_EMPTY","RETRIEVE_FAIL_WRONG_SHAPE","RETRIEVE_FAIL_ERROR_BODY","RETRIEVE_EXCLUDED_BLOCKED","RETRIEVE_EXCLUDED_AUTH"] as const;

interface Verdict {
  probe_id: string;
  index_verdict: typeof INDEX_VERDICTS[number];
  index_reasoning: string;
  retrieve_verdict: typeof RETRIEVE_VERDICTS[number];
  retrieve_reasoning: string;
  evidence_quote: string;
  suspicious: boolean;
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    probe_id: { type: "string" },
    index_verdict: { type: "string", enum: [...INDEX_VERDICTS] },
    index_reasoning: { type: "string" },
    retrieve_verdict: { type: "string", enum: [...RETRIEVE_VERDICTS] },
    retrieve_reasoning: { type: "string" },
    evidence_quote: { type: "string" },
    suspicious: { type: "boolean" },
  },
  required: ["probe_id","index_verdict","index_reasoning","retrieve_verdict","retrieve_reasoning","evidence_quote","suspicious"],
  additionalProperties: false,
} as const;

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

function readFile(p: string, max?: number): string {
  if (!fs.existsSync(p)) return "";
  const buf = fs.readFileSync(p);
  return max ? buf.subarray(0, max).toString("utf8") : buf.toString("utf8");
}

function loadProbeBundle(runDir: string, probe: ProbeRef) {
  const d = path.join(runDir, probe.probe_id);
  return {
    capture_meta: readFile(path.join(d, "capture.meta.json"), 16_000),
    capture_html_excerpt: readFile(path.join(d, "capture.html.excerpt"), 8192),
    resolve_shortlist: readFile(path.join(d, "resolve.shortlist.json"), 64_000),
    resolve_pick: readFile(path.join(d, "resolve.pick.json"), 4_000),
    execute_response_raw: readFile(path.join(d, "execute.response.raw"), 64_000),
    execute_meta: readFile(path.join(d, "execute.meta.json"), 8_000),
    timings: readFile(path.join(d, "timings.json"), 2_000),
  };
}

function stubVerdict(probe: ProbeRef): Verdict {
  // Used by --dry-run. Drawn from the artifact only via lane shape; this is
  // NOT a real verdict. Real verdicts come from the agent judge.
  const blocked = probe.lane === "hostile";
  const auth = probe.lane === "auth-gated";
  return {
    probe_id: probe.probe_id,
    index_verdict: blocked ? "INDEX_EXCLUDED_BLOCKED" : auth ? "INDEX_EXCLUDED_AUTH" : "INDEX_FAIL_NO_ENDPOINTS",
    index_reasoning: "[dry-run stub] no agent call made; verdict assigned by lane shape only.",
    retrieve_verdict: blocked ? "RETRIEVE_EXCLUDED_BLOCKED" : auth ? "RETRIEVE_EXCLUDED_AUTH" : "RETRIEVE_FAIL_ERROR_BODY",
    retrieve_reasoning: "[dry-run stub] no agent call made; verdict assigned by lane shape only.",
    evidence_quote: "[dry-run]",
    suspicious: false,
  };
}

function buildUserMessage(probe: ProbeRef, bundle: ReturnType<typeof loadProbeBundle>): string {
  return [
    `Probe: ${probe.probe_id}`,
    `Lane: ${probe.lane}`,
    `Intent: ${probe.intent}`,
    `ContextURL: ${probe.url}`,
    "",
    "Emit a single JSON object that conforms to the schema. No prose around it.",
    "",
    "=== capture.meta.json ===", bundle.capture_meta || "(empty)",
    "=== capture.html.excerpt ===", bundle.capture_html_excerpt || "(empty)",
    "=== resolve.shortlist.json ===", bundle.resolve_shortlist || "(empty)",
    "=== resolve.pick.json ===", bundle.resolve_pick || "(empty)",
    "=== execute.response.raw ===", bundle.execute_response_raw || "(empty)",
    "=== execute.meta.json ===", bundle.execute_meta || "(empty)",
    "=== timings.json ===", bundle.timings || "(empty)",
  ].join("\n");
}

function extractJson(text: string): unknown {
  // `claude -p --output-format json` returns an envelope like
  //   { "type":"result", "subtype":"success", "result":"<assistant text>", ... }
  // We try the envelope's `result` first, then fall back to greedy JSON parse
  // over the full stdout (some harness builds bypass the envelope).
  try {
    const env = JSON.parse(text);
    if (env && typeof env === "object" && "result" in env) {
      const inner = (env as { result: unknown }).result;
      if (typeof inner === "string") {
        const trimmed = inner.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
        return JSON.parse(trimmed);
      }
      return inner;
    }
    return env;
  } catch {
    // greedy: find first { ... } that parses
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "{") continue;
      for (let j = text.length; j > i; j--) {
        try { return JSON.parse(text.slice(i, j)); } catch { /* keep narrowing */ }
      }
    }
    throw new Error(`could not extract JSON from claude output (first 200 chars): ${text.slice(0, 200)}`);
  }
}

interface ClaudeJudgeOptions {
  rubric: string;
  model: string;
  bin: string;
  timeoutSec: number;
}

function judgeWithClaude(probe: ProbeRef, bundle: ReturnType<typeof loadProbeBundle>, opts: ClaudeJudgeOptions): Verdict {
  const user = buildUserMessage(probe, bundle);
  const args = [
    "-p",
    "--bare",
    "--system-prompt", opts.rubric,
    "--json-schema", JSON.stringify(VERDICT_SCHEMA),
    "--output-format", "json",
    "--model", opts.model,
  ];
  const r = spawnSync(opts.bin, args, {
    input: user,
    encoding: "utf8",
    timeout: opts.timeoutSec * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`probe ${probe.probe_id}: claude exited ${r.status}\nstderr: ${r.stderr?.slice(0, 1000)}`);
  }
  const parsed = extractJson(r.stdout ?? "");
  const v = parsed as Verdict;
  if (!v || typeof v !== "object" || !v.probe_id) {
    throw new Error(`probe ${probe.probe_id}: agent response did not match verdict schema; got ${JSON.stringify(parsed).slice(0, 400)}`);
  }
  // Force the probe_id to match what we asked about — the agent occasionally
  // mirrors back a different id from the bundle text.
  v.probe_id = probe.probe_id;
  return v;
}

function summarize(verdicts: Verdict[], manifest: Manifest): string {
  const tally: Record<string, number> = {};
  for (const v of verdicts) {
    tally[v.index_verdict] = (tally[v.index_verdict] ?? 0) + 1;
    tally[v.retrieve_verdict] = (tally[v.retrieve_verdict] ?? 0) + 1;
  }
  const indexable = verdicts.filter(v => !v.index_verdict.startsWith("INDEX_EXCLUDED")).length;
  const retrievable = verdicts.filter(v => !v.retrieve_verdict.startsWith("RETRIEVE_EXCLUDED")).length;
  const indexPass = tally.INDEX_PASS ?? 0;
  const retrievePass = tally.RETRIEVE_PASS ?? 0;
  const idxRate = indexable ? indexPass / indexable : 0;
  const retRate = retrievable ? retrievePass / retrievable : 0;
  const suspiciousCount = verdicts.filter(v => v.suspicious).length;
  const lines: string[] = [];
  lines.push(`# Bench-Gate Verdict — ${manifest.run_id}`);
  lines.push("");
  lines.push(`- corpus: \`${manifest.corpus}\``);
  lines.push(`- cli_version: ${manifest.cli_version}`);
  lines.push(`- probes: ${verdicts.length}`);
  lines.push(`- index_coverage: **${(idxRate * 100).toFixed(1)}%** (${indexPass}/${indexable} indexable)`);
  lines.push(`- retrieve_coverage: **${(retRate * 100).toFixed(1)}%** (${retrievePass}/${retrievable} retrievable)`);
  lines.push(`- suspicious (hostile-lane PASS): ${suspiciousCount}`);
  lines.push("");
  lines.push("## Tally");
  for (const [k, v] of Object.entries(tally).sort()) lines.push(`- ${k}: ${v}`);
  return lines.join("\n");
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const artifacts = flags.artifacts;
  if (!artifacts) {
    console.error("usage: bun scripts/bench-gate-judge.ts --artifacts .bench-gate/<run-id> [--dry-run] [--judge-prompt path] [--limit N] [--model sonnet] [--claude-bin path]");
    process.exit(1);
  }
  const manifestPath = path.join(artifacts, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest not found: ${manifestPath}`);
    console.error(`hint: pass --artifacts pointing to a bench-gate run directory`);
    process.exit(2);
  }
  let manifest: Manifest;
  try { manifest = JSON.parse(readFile(manifestPath)); }
  catch (e) { console.error(`manifest is not valid JSON: ${manifestPath}\n${e}`); process.exit(2); }
  const judgePromptPath = flags["judge-prompt"] ?? "harness/probes/GATE_JUDGE.md";
  const rubric = readFile(judgePromptPath);
  if (!flags["dry-run"] && !rubric) {
    console.error(`judge prompt missing: ${judgePromptPath}`);
    process.exit(2);
  }
  const limit = flags.limit ? parseInt(flags.limit, 10) : manifest.probes.length;
  const model = flags.model ?? "sonnet";
  const bin = flags["claude-bin"] ?? "claude";
  const timeoutSec = flags.timeout ? parseInt(flags.timeout, 10) : 180;

  const verdicts: Verdict[] = [];
  for (const probe of manifest.probes.slice(0, limit)) {
    const bundle = loadProbeBundle(artifacts, probe);
    let v: Verdict;
    if (flags["dry-run"]) {
      v = stubVerdict(probe);
    } else {
      v = judgeWithClaude(probe, bundle, { rubric, model, bin, timeoutSec });
    }
    if (probe.lane === "hostile" && (v.index_verdict === "INDEX_PASS" || v.retrieve_verdict === "RETRIEVE_PASS")) {
      v.suspicious = true;
    }
    verdicts.push(v);
    console.error(`[judge] ${probe.probe_id} index=${v.index_verdict} retrieve=${v.retrieve_verdict}${v.suspicious ? " ⚠ suspicious" : ""}`);
  }
  fs.writeFileSync(path.join(artifacts, "verdict.json"), JSON.stringify({ run_id: manifest.run_id, verdicts }, null, 2));
  fs.writeFileSync(path.join(artifacts, "verdict.md"), summarize(verdicts, manifest));
  console.error(`[judge] wrote ${path.join(artifacts, "verdict.json")} + verdict.md`);
}

main();
