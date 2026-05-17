#!/usr/bin/env bun
/**
 * bench-gate-mcp-collect.ts — sweep per-probe subagent.result.json files
 * into a single verdict.json compatible with bench-gate-compare.ts /
 * bench-gate-judge.ts --validate.
 *
 * The MCP-driven gate (scripts/bench-gate-mcp.sh) writes one
 * subagent.result.json per probe in {iterations[], stability, summary}
 * shape. bench-gate-compare expects the classic
 * { run_id, verdicts: [{ probe_id, index_verdict, retrieve_verdict, ... }] }
 * shape. This collector translates between the two without inventing
 * facts:
 *
 *   - The probe's index_verdict comes from iteration 1's publish +
 *     resolve_after_publish phases. That iteration is the only one where
 *     "publish writes to a previously-empty index" actually happens;
 *     subsequent iterations measure cache stability.
 *   - The probe's retrieve_verdict comes from the same iteration's
 *     execute phase (status_code + response_bytes + looks_relevant).
 *   - "suspicious" flips to true when stability != STABLE OR the
 *     verdict isn't a PASS / EXCLUDED — flaky or unstable runs are
 *     worth a second look even if iteration 1 passed.
 *   - "evidence_quote" is iteration 1's evidence_quote, truncated.
 *
 * Per CLAUDE.md "harness makes visible, agent judges": this script
 * does the *structural* translation only (which iteration carries the
 * load-bearing facts). The verdict labels themselves come from the
 * subagent in-thread, not from heuristics here.
 */

import fs from "node:fs";
import path from "node:path";

interface PhaseOutcome {
  outcome: string;
  pre_index_resolve?: string;
  phases?: {
    browse?: { status?: string; ms?: number; notes?: string };
    publish?: { status?: string; endpoints_published?: number };
    resolve_after_publish?: { available_endpoints?: number; skill_id?: string };
    execute?: { status_code?: number; response_bytes?: number; looks_relevant?: boolean };
  };
  evidence_quote?: string;
}

interface SubagentResult {
  probe_id: string;
  lane?: string;
  intent?: string;
  url?: string;
  iterations?: Array<PhaseOutcome & { iteration: number }>;
  stability?: "STABLE" | "FLAKY" | "UNSTABLE";
  summary?: string;
}

interface Manifest {
  run_id: string;
  probes: Array<{ probe_id: string; lane?: string }>;
}

interface CompareVerdict {
  probe_id: string;
  index_verdict: string;
  index_reasoning: string;
  retrieve_verdict: string;
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
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function deriveIndexVerdict(it: PhaseOutcome): { verdict: string; reasoning: string } {
  switch (it.outcome) {
    case "EXCLUDED_AUTH":
      return { verdict: "INDEX_EXCLUDED_AUTH", reasoning: it.evidence_quote ?? "subagent marked auth-gated" };
    case "EXCLUDED_BLOCKED":
      return { verdict: "INDEX_EXCLUDED_BLOCKED", reasoning: it.evidence_quote ?? "subagent marked anti-bot blocked" };
    case "FAIL_BROWSE":
    case "FAIL_INDEX_NO_ENDPOINTS":
      return {
        verdict: "INDEX_FAIL_NO_ENDPOINTS",
        reasoning: it.phases?.publish
          ? `publish.endpoints=${it.phases.publish.endpoints_published ?? 0}, browse.status=${it.phases.browse?.status ?? "?"}`
          : "no publish phase recorded",
      };
    case "FAIL_PUBLISH_NOT_VISIBLE":
    case "FAIL_RESOLVE_AFTER_PUBLISH":
      return {
        verdict: "INDEX_FAIL_WRONG_SHAPE",
        reasoning: `resolve_after_publish.available_endpoints=${it.phases?.resolve_after_publish?.available_endpoints ?? 0}`,
      };
    case "PASS":
      return {
        verdict: "INDEX_PASS",
        reasoning: `published ${it.phases?.publish?.endpoints_published ?? 0} endpoint(s); resolve_after_publish saw ${it.phases?.resolve_after_publish?.available_endpoints ?? 0}`,
      };
    case "FAIL_EXECUTE_ERROR":
    case "FAIL_EXECUTE_EMPTY":
      return {
        verdict: "INDEX_PASS",
        reasoning: `index/publish succeeded; failure was on execute (status=${it.phases?.execute?.status_code ?? "?"})`,
      };
    default:
      return { verdict: "INDEX_FAIL_NO_ENDPOINTS", reasoning: `unknown outcome: ${it.outcome}` };
  }
}

function deriveRetrieveVerdict(it: PhaseOutcome): { verdict: string; reasoning: string } {
  switch (it.outcome) {
    case "EXCLUDED_AUTH":
      return { verdict: "RETRIEVE_EXCLUDED_AUTH", reasoning: it.evidence_quote ?? "subagent marked auth-gated" };
    case "EXCLUDED_BLOCKED":
      return { verdict: "RETRIEVE_EXCLUDED_BLOCKED", reasoning: it.evidence_quote ?? "subagent marked anti-bot blocked" };
    case "FAIL_BROWSE":
    case "FAIL_INDEX_NO_ENDPOINTS":
    case "FAIL_PUBLISH_NOT_VISIBLE":
    case "FAIL_RESOLVE_AFTER_PUBLISH":
      return {
        verdict: "RETRIEVE_FAIL_EMPTY",
        reasoning: "execute could not run because no endpoint was published or resolvable",
      };
    case "FAIL_EXECUTE_ERROR":
      return {
        verdict: "RETRIEVE_FAIL_ERROR_BODY",
        reasoning: `status_code=${it.phases?.execute?.status_code ?? "?"} response_bytes=${it.phases?.execute?.response_bytes ?? 0}`,
      };
    case "FAIL_EXECUTE_EMPTY":
      return {
        verdict: "RETRIEVE_FAIL_EMPTY",
        reasoning: `status=${it.phases?.execute?.status_code ?? "?"} but response_bytes=${it.phases?.execute?.response_bytes ?? 0}, looks_relevant=${it.phases?.execute?.looks_relevant ?? false}`,
      };
    case "PASS":
      return {
        verdict: "RETRIEVE_PASS",
        reasoning: `status=${it.phases?.execute?.status_code ?? 200}, bytes=${it.phases?.execute?.response_bytes ?? 0}, looks_relevant=true`,
      };
    default:
      return { verdict: "RETRIEVE_FAIL_EMPTY", reasoning: `unknown outcome: ${it.outcome}` };
  }
}

function collectOne(probeDir: string): CompareVerdict | null {
  const resultPath = path.join(probeDir, "subagent.result.json");
  const result = readJson<SubagentResult>(resultPath);
  if (!result) return null;
  const iterations = result.iterations ?? [];
  if (iterations.length === 0) return null;

  const first = iterations[0]!;
  const idx = deriveIndexVerdict(first);
  const ret = deriveRetrieveVerdict(first);
  const stability = result.stability ?? "STABLE";

  const isCleanOutcome =
    (idx.verdict === "INDEX_PASS" || idx.verdict === "INDEX_EXCLUDED_BLOCKED" || idx.verdict === "INDEX_EXCLUDED_AUTH") &&
    (ret.verdict === "RETRIEVE_PASS" || ret.verdict === "RETRIEVE_EXCLUDED_BLOCKED" || ret.verdict === "RETRIEVE_EXCLUDED_AUTH");
  const suspicious = stability !== "STABLE" || !isCleanOutcome;

  return {
    probe_id: result.probe_id,
    index_verdict: idx.verdict,
    index_reasoning: `[iter-1] ${idx.reasoning}; stability=${stability}; ${result.summary ?? ""}`.slice(0, 600),
    retrieve_verdict: ret.verdict,
    retrieve_reasoning: `[iter-1] ${ret.reasoning}; stability=${stability}`.slice(0, 600),
    evidence_quote: (first.evidence_quote ?? "").slice(0, 200),
    suspicious,
  };
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const artifacts = flags.artifacts;
  if (!artifacts) {
    console.error("usage: bench-gate-mcp-collect.ts --artifacts <run-dir>");
    process.exit(2);
  }
  const runDir = path.resolve(artifacts);
  const manifestPath = path.join(runDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`[bench-gate-mcp-collect] no manifest at ${manifestPath}`);
    process.exit(2);
  }
  const manifest = readJson<Manifest>(manifestPath);
  if (!manifest) {
    console.error(`[bench-gate-mcp-collect] manifest unreadable`);
    process.exit(2);
  }

  const verdicts: CompareVerdict[] = [];
  const missing: string[] = [];
  for (const probe of manifest.probes) {
    const probeDir = path.join(runDir, probe.probe_id);
    const v = collectOne(probeDir);
    if (v) {
      verdicts.push(v);
    } else {
      missing.push(probe.probe_id);
    }
  }

  // bench-gate-judge.ts --validate expects { run_id, verdicts: [...] }, not
  // a bare array. Wrap the same way the dry-run / agent-rendered verdict
  // does so the existing validator + compare path is reused regardless of
  // whether the judgments came from an agent reading judge.bundle.md or
  // from this MCP-subagent collector.
  const verdictPath = path.join(runDir, "verdict.json");
  fs.writeFileSync(
    verdictPath,
    JSON.stringify({ run_id: manifest.run_id, verdicts }, null, 2),
  );

  console.error(`[bench-gate-mcp-collect] wrote ${verdicts.length} verdict(s) -> ${verdictPath}`);
  if (missing.length > 0) {
    console.error(`[bench-gate-mcp-collect] WARN: ${missing.length} probe(s) missing subagent.result.json:`);
    for (const m of missing) console.error(`  - ${m}`);
    console.error(`[bench-gate-mcp-collect] re-run the missing probes' subagents and re-collect`);
    process.exit(1);
  }
  console.log(verdictPath);
}

main();
