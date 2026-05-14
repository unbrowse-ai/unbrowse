#!/usr/bin/env bun
// bench-gate-judge.ts — release-gate judge PREP helper.
//
// The judge is NOT this script. The judge is the agent that ran the harness
// (Claude Code in-thread). This script's job is to make the artifacts visible
// to that agent and validate what the agent writes back.
//
// Per CLAUDE.md "harness makes visible, agent judges" / memory
// `feedback_harness_makes_visible_agent_judges.md`: the harness never
// auto-classifies via heuristics OR LLMs. It collects evidence and
// presents it. The agent-in-thread renders the verdict.
//
// Modes:
//   default     → write `.bench-gate/<run>/judge.bundle.md` consolidating
//                 every probe's artifacts + the GATE_JUDGE.md rubric + the
//                 verdict JSON schema. Also write `verdict.template.json`
//                 with an empty entry per probe. Print agent instructions
//                 on stderr.
//   --dry-run   → write stub verdicts to verdict.json (lane-shaped only;
//                 NOT a real judgment). Used by harness↔compare contract
//                 tests so they don't depend on an agent being present.
//   --validate <path> → validate that a verdict.json file conforms to the
//                 schema + covers every probe in the manifest. Exit 2 on
//                 violation. The agent calls this after writing verdict.json.

import fs from "node:fs";
import path from "node:path";

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
  // --dry-run only. Lane-shaped stub, NOT a real verdict.
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

function renderProbeMarkdown(probe: ProbeRef, bundle: ReturnType<typeof loadProbeBundle>): string {
  return [
    `## ${probe.probe_id}`,
    "",
    `- **lane**: \`${probe.lane}\``,
    `- **intent**: ${probe.intent}`,
    `- **contextUrl**: ${probe.url}`,
    "",
    "### capture.meta.json", "```json", bundle.capture_meta || "(empty)", "```",
    "### capture.html.excerpt", "```html", bundle.capture_html_excerpt || "(empty)", "```",
    "### resolve.shortlist.json", "```json", bundle.resolve_shortlist || "(empty)", "```",
    "### resolve.pick.json", "```json", bundle.resolve_pick || "(empty)", "```",
    "### execute.response.raw", "```", bundle.execute_response_raw || "(empty)", "```",
    "### execute.meta.json", "```json", bundle.execute_meta || "(empty)", "```",
    "### timings.json", "```json", bundle.timings || "(empty)", "```",
    "",
    "---",
    "",
  ].join("\n");
}

function writeJudgeBundle(runDir: string, manifest: Manifest, rubric: string): { bundlePath: string; templatePath: string } {
  const bundlePath = path.join(runDir, "judge.bundle.md");
  const templatePath = path.join(runDir, "verdict.template.json");

  const sections: string[] = [];
  sections.push(`# Bench-Gate Judge Bundle — ${manifest.run_id}`);
  sections.push("");
  sections.push(`Agent: this is the consolidated artifact set for run \`${manifest.run_id}\`.`);
  sections.push(`Read the rubric below, then render one verdict per probe and write the`);
  sections.push(`array as JSON to \`${path.join(runDir, "verdict.json")}\`.`);
  sections.push("");
  sections.push("## Verdict JSON shape");
  sections.push("```json");
  sections.push(JSON.stringify({ run_id: manifest.run_id, verdicts: [VERDICT_SCHEMA] }, null, 2));
  sections.push("```");
  sections.push("");
  sections.push("## Rubric (verbatim from harness/probes/GATE_JUDGE.md)");
  sections.push(rubric);
  sections.push("");
  sections.push(`## Probes (${manifest.probes.length})`);
  sections.push("");
  for (const probe of manifest.probes) {
    const bundle = loadProbeBundle(runDir, probe);
    sections.push(renderProbeMarkdown(probe, bundle));
  }
  fs.writeFileSync(bundlePath, sections.join("\n"));

  const template = {
    run_id: manifest.run_id,
    _instructions: `Agent: replace each verdict entry below with a real judgment from judge.bundle.md, then write this file to ${path.join(runDir, "verdict.json")} (drop the _instructions key).`,
    verdicts: manifest.probes.map(p => ({
      probe_id: p.probe_id,
      index_verdict: "<INDEX_PASS|INDEX_FAIL_NO_ENDPOINTS|INDEX_FAIL_WRONG_SHAPE|INDEX_EXCLUDED_BLOCKED|INDEX_EXCLUDED_AUTH>",
      index_reasoning: "<3-5 sentences quoting capture evidence>",
      retrieve_verdict: "<RETRIEVE_PASS|RETRIEVE_FAIL_WRONG_ENTITY|RETRIEVE_FAIL_EMPTY|RETRIEVE_FAIL_WRONG_SHAPE|RETRIEVE_FAIL_ERROR_BODY|RETRIEVE_EXCLUDED_BLOCKED|RETRIEVE_EXCLUDED_AUTH>",
      retrieve_reasoning: "<3-5 sentences quoting execute.response.raw>",
      evidence_quote: "<single most informative line>",
      suspicious: false,
    })),
  };
  fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
  return { bundlePath, templatePath };
}

function validateVerdictFile(verdictPath: string, manifestPath: string): { errors: string[] } {
  const errors: string[] = [];
  if (!fs.existsSync(verdictPath)) { errors.push(`verdict file not found: ${verdictPath}`); return { errors }; }
  if (!fs.existsSync(manifestPath)) { errors.push(`manifest not found: ${manifestPath}`); return { errors }; }
  let verdict: any, manifest: Manifest;
  try { verdict = JSON.parse(readFile(verdictPath)); } catch (e) { errors.push(`verdict.json is not valid JSON: ${e}`); return { errors }; }
  try { manifest = JSON.parse(readFile(manifestPath)); } catch (e) { errors.push(`manifest.json is not valid JSON: ${e}`); return { errors }; }

  if (!Array.isArray(verdict.verdicts)) { errors.push(`verdict.verdicts must be an array`); return { errors }; }

  const manifestIds = new Set(manifest.probes.map(p => p.probe_id));
  const verdictIds = new Set<string>();
  for (const [i, v] of verdict.verdicts.entries()) {
    if (typeof v !== "object" || v == null) { errors.push(`verdicts[${i}] is not an object`); continue; }
    for (const f of VERDICT_SCHEMA.required) {
      if (!(f in v)) errors.push(`verdicts[${i}] missing required field "${f}"`);
    }
    if (v.index_verdict && !(INDEX_VERDICTS as readonly string[]).includes(v.index_verdict)) {
      errors.push(`verdicts[${i}].index_verdict "${v.index_verdict}" not in enum`);
    }
    if (v.retrieve_verdict && !(RETRIEVE_VERDICTS as readonly string[]).includes(v.retrieve_verdict)) {
      errors.push(`verdicts[${i}].retrieve_verdict "${v.retrieve_verdict}" not in enum`);
    }
    if (typeof v.suspicious !== "boolean") errors.push(`verdicts[${i}].suspicious must be boolean`);
    if (typeof v.probe_id === "string") {
      if (verdictIds.has(v.probe_id)) errors.push(`verdicts[${i}].probe_id "${v.probe_id}" appears twice`);
      verdictIds.add(v.probe_id);
      if (!manifestIds.has(v.probe_id)) errors.push(`verdicts[${i}].probe_id "${v.probe_id}" is not in the manifest`);
    }
  }
  for (const id of manifestIds) {
    if (!verdictIds.has(id)) errors.push(`manifest probe "${id}" has no verdict entry`);
  }
  return { errors };
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const artifacts = flags.artifacts;
  if (!artifacts) {
    console.error("usage:");
    console.error("  bun scripts/bench-gate-judge.ts --artifacts .bench-gate/<run-id>             # prep judge.bundle.md + verdict.template.json for agent");
    console.error("  bun scripts/bench-gate-judge.ts --artifacts .bench-gate/<run-id> --dry-run   # stub verdicts (tests only, NOT a real judgment)");
    console.error("  bun scripts/bench-gate-judge.ts --artifacts .bench-gate/<run-id> --validate  # validate agent-written verdict.json against schema");
    process.exit(1);
  }
  const manifestPath = path.join(artifacts, "manifest.json");
  if (!fs.existsSync(manifestPath)) { console.error(`manifest not found: ${manifestPath}`); process.exit(2); }
  let manifest: Manifest;
  try { manifest = JSON.parse(readFile(manifestPath)); }
  catch (e) { console.error(`manifest is not valid JSON: ${manifestPath}\n${e}`); process.exit(2); }

  if (flags.validate) {
    const verdictPath = path.join(artifacts, "verdict.json");
    const { errors } = validateVerdictFile(verdictPath, manifestPath);
    if (errors.length > 0) {
      console.error(`[validate] FAIL — ${errors.length} schema violation(s) in ${verdictPath}:`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(2);
    }
    console.error(`[validate] OK — ${verdictPath} conforms to schema and covers all ${manifest.probes.length} probes`);
    return;
  }

  if (flags["dry-run"]) {
    const verdicts = manifest.probes.map(stubVerdict);
    fs.writeFileSync(path.join(artifacts, "verdict.json"), JSON.stringify({ run_id: manifest.run_id, verdicts }, null, 2));
    console.error(`[dry-run] wrote ${verdicts.length} stub verdicts → ${path.join(artifacts, "verdict.json")} (NOT a real judgment — for tests only)`);
    return;
  }

  // Default mode: prep the bundle for the agent.
  const judgePromptPath = flags["judge-prompt"] ?? "harness/probes/GATE_JUDGE.md";
  const rubric = readFile(judgePromptPath);
  if (!rubric) { console.error(`judge prompt missing: ${judgePromptPath}`); process.exit(2); }

  const { bundlePath, templatePath } = writeJudgeBundle(artifacts, manifest, rubric);
  console.error("");
  console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.error("AGENT JUDGE STEP — manual, by the agent running this harness");
  console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.error(`Bundle:    ${bundlePath}`);
  console.error(`Template:  ${templatePath}`);
  console.error(`Probes:    ${manifest.probes.length}`);
  console.error("");
  console.error("Steps for the agent:");
  console.error(`  1. Read ${bundlePath} (Read tool)`);
  console.error(`  2. For each probe, judge per the rubric and the artifacts in the bundle`);
  console.error(`  3. Write ${path.join(artifacts, "verdict.json")} with shape:`);
  console.error(`        { "run_id": "${manifest.run_id}", "verdicts": [ ... per-probe verdicts ... ] }`);
  console.error(`  4. Run: bun scripts/bench-gate-judge.ts --artifacts ${artifacts} --validate`);
  console.error(`  5. Run: bun scripts/bench-gate-compare.ts --artifacts ${artifacts}`);
  console.error("");
}

main();
