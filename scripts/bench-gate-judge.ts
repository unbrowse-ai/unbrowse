#!/usr/bin/env bun
// bench-gate-judge.ts — release-gate judge. Reads harness artifacts. Renders verdicts.
// See docs/release-gate-bench-plan.md + harness/probes/GATE_JUDGE.md
//
// Invariants (Step 2 firmament):
//   - never shells out to `unbrowse`
//   - reads only from .bench-gate/<run-id>/
//   - writes only verdict.{json,md}
//
// Mustard-seed scope: one probe at a time, no batching, no retry chain.
// Dry-run mode emits stub verdicts without calling Anthropic (for harness↔judge
// contract testing without burning credits).

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
  // NOT a real verdict. Real verdicts come from the LLM judge.
  const blocked = probe.lane === "hostile";
  const auth = probe.lane === "auth-gated";
  return {
    probe_id: probe.probe_id,
    index_verdict: blocked ? "INDEX_EXCLUDED_BLOCKED" : auth ? "INDEX_EXCLUDED_AUTH" : "INDEX_FAIL_NO_ENDPOINTS",
    index_reasoning: "[dry-run stub] no LLM call made; verdict assigned by lane shape only.",
    retrieve_verdict: blocked ? "RETRIEVE_EXCLUDED_BLOCKED" : auth ? "RETRIEVE_EXCLUDED_AUTH" : "RETRIEVE_FAIL_ERROR_BODY",
    retrieve_reasoning: "[dry-run stub] no LLM call made; verdict assigned by lane shape only.",
    evidence_quote: "[dry-run]",
    suspicious: false,
  };
}

async function judgeWithAnthropic(probe: ProbeRef, bundle: ReturnType<typeof loadProbeBundle>, judgePrompt: string): Promise<Verdict> {
  // Lazy-import so --dry-run works without the SDK installed.
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();
  const user = [
    `Probe: ${probe.probe_id}`,
    `Lane: ${probe.lane}`,
    `Intent: ${probe.intent}`,
    `ContextURL: ${probe.url}`,
    "",
    "=== capture.meta.json ===", bundle.capture_meta || "(empty)",
    "=== capture.html.excerpt ===", bundle.capture_html_excerpt || "(empty)",
    "=== resolve.shortlist.json ===", bundle.resolve_shortlist || "(empty)",
    "=== resolve.pick.json ===", bundle.resolve_pick || "(empty)",
    "=== execute.response.raw ===", bundle.execute_response_raw || "(empty)",
    "=== execute.meta.json ===", bundle.execute_meta || "(empty)",
    "=== timings.json ===", bundle.timings || "(empty)",
  ].join("\n");

  const tool = {
    name: "emit_verdict",
    description: "Emit the judge verdict for one probe.",
    input_schema: {
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
    },
  } as const;

  const resp = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 2048,
    temperature: 0,
    system: [{ type: "text", text: judgePrompt, cache_control: { type: "ephemeral" } }],
    tools: [tool as any],
    tool_choice: { type: "tool", name: "emit_verdict" },
    messages: [{ role: "user", content: user }],
  });

  const block = resp.content.find((b: any) => b.type === "tool_use");
  if (!block) throw new Error(`probe ${probe.probe_id}: no tool_use block in response`);
  return (block as any).input as Verdict;
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

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const artifacts = flags.artifacts;
  if (!artifacts) {
    console.error("usage: bun scripts/bench-gate-judge.ts --artifacts .bench-gate/<run-id> [--dry-run] [--judge-prompt path] [--limit N]");
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
  const judgePrompt = readFile(judgePromptPath);
  if (!flags["dry-run"] && !judgePrompt) {
    console.error(`judge prompt missing: ${judgePromptPath}`);
    process.exit(2);
  }
  const limit = flags.limit ? parseInt(flags.limit, 10) : manifest.probes.length;
  const verdicts: Verdict[] = [];
  for (const probe of manifest.probes.slice(0, limit)) {
    const bundle = loadProbeBundle(artifacts, probe);
    let v: Verdict;
    if (flags["dry-run"]) {
      v = stubVerdict(probe);
    } else {
      v = await judgeWithAnthropic(probe, bundle, judgePrompt);
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

main().catch(e => { console.error(e); process.exit(1); });
