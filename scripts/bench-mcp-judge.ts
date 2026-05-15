#!/usr/bin/env bun
// bench-mcp-judge.ts — distill an MCP-agentic bench run into a judge bundle.
// Reads events.jsonl per probe, extracts tool-call summary + final agent message,
// emits a markdown bundle for an agent-in-thread to read and write verdict.json.
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

type Event = {
  type?: string;
  item?: {
    id?: string;
    type?: string;
    server?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    result?: { content?: Array<{ text?: string }>; structured_content?: unknown };
    text?: string;
    status?: string;
    error?: unknown;
  };
  usage?: Record<string, unknown>;
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

function trunc(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function readJsonl(file: string): Event[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l) as Event; } catch { return null; }
    })
    .filter((e): e is Event => e !== null);
}

function distillProbe(probeDir: string, probe: Probe): { md: string; summary: Record<string, unknown> } {
  const events = readJsonl(path.join(probeDir, "events.jsonl"));
  const toolCalls: Array<{ tool: string; arguments: Record<string, unknown>; result_excerpt: string; error: unknown; status: string | undefined }> = [];
  let finalMessage = "";
  let usage: Record<string, unknown> | undefined;

  for (const event of events) {
    if (event.type === "item.completed" && event.item?.type === "mcp_tool_call") {
      const item = event.item;
      const text = item.result?.content?.[0]?.text ?? "";
      toolCalls.push({
        tool: item.tool ?? "unknown",
        arguments: item.arguments ?? {},
        result_excerpt: trunc(text, 4_000),
        error: item.error ?? null,
        status: item.status,
      });
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      finalMessage = event.item.text ?? "";
    }
    if (event.type === "turn.completed" && event.usage) {
      usage = event.usage;
    }
  }

  const lastMessageFile = path.join(probeDir, "last-message.txt");
  if (!finalMessage && fs.existsSync(lastMessageFile)) {
    finalMessage = fs.readFileSync(lastMessageFile, "utf8");
  }

  const timing = (() => {
    const f = path.join(probeDir, "timing.json");
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
  })();

  const md: string[] = [];
  md.push(`## ${probe.probe_id}`);
  md.push("");
  md.push(`- lane: \`${probe.lane}\``);
  if (probe.auth) md.push(`- auth: \`${probe.auth}\``);
  if (probe.difficulty) md.push(`- difficulty: \`${probe.difficulty}\``);
  if (probe.strategy) md.push(`- strategy: \`${probe.strategy}\``);
  md.push(`- intent: ${probe.intent}`);
  md.push(`- url: ${probe.url}`);
  if (timing?.elapsed_s) md.push(`- elapsed: ${timing.elapsed_s}s`);
  if (usage?.input_tokens || usage?.output_tokens) {
    md.push(`- usage: ${JSON.stringify(usage)}`);
  }
  md.push("");
  md.push("### Tool calls");
  md.push("");
  if (toolCalls.length === 0) {
    md.push("_no MCP tool calls_");
  } else {
    for (let i = 0; i < toolCalls.length; i++) {
      const c = toolCalls[i]!;
      md.push(`#### ${i + 1}. ${c.tool} (${c.status ?? "?"})`);
      md.push("");
      md.push("Arguments:");
      md.push("```json");
      md.push(JSON.stringify(c.arguments, null, 2));
      md.push("```");
      md.push("");
      md.push("Result excerpt:");
      md.push("```");
      md.push(c.result_excerpt || "(empty)");
      md.push("```");
      if (c.error) {
        md.push("");
        md.push("Error:");
        md.push("```json");
        md.push(JSON.stringify(c.error, null, 2));
        md.push("```");
      }
      md.push("");
    }
  }
  md.push("### Final agent message");
  md.push("");
  md.push("```");
  md.push(finalMessage || "(empty)");
  md.push("```");
  md.push("");

  const summary = {
    probe_id: probe.probe_id,
    tool_call_count: toolCalls.length,
    tools_used: [...new Set(toolCalls.map((c) => c.tool))],
    final_message_excerpt: finalMessage.slice(0, 300),
    elapsed_s: timing?.elapsed_s ?? null,
    usage,
  };

  return { md: md.join("\n"), summary };
}

const flags = parseFlags(process.argv.slice(2));
const artifacts = String(flags.artifacts || "");
if (!artifacts) fail("usage: bun scripts/bench-mcp-judge.ts --artifacts .bench-mcp/<run-id>");

const manifestPath = path.join(artifacts, "manifest.json");
if (!fs.existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { run_id: string; probes: Probe[] };

const bundleParts: string[] = [];
const summaries: Array<Record<string, unknown>> = [];

bundleParts.push(`# Bench-MCP judge bundle: ${manifest.run_id}`);
bundleParts.push("");
bundleParts.push("This bundle distills an agentic bench run where each probe invokes a fresh codex session with the LOCAL unbrowse MCP server. Each probe is one full agent trajectory.");
bundleParts.push("");
bundleParts.push("## How to judge");
bundleParts.push("");
bundleParts.push("For each probe section:");
bundleParts.push("");
bundleParts.push("1. Read the tool calls to see which endpoints the agent picked and what each returned.");
bundleParts.push("2. Read the final agent message and compare it to the intent.");
bundleParts.push("3. Render a verdict (per the schema in `harness/probes/MCP_JUDGE.md`) covering:");
bundleParts.push("   - did the agent call resolve and execute via MCP?");
bundleParts.push("   - did the picked endpoint match the intent and contextUrl entity?");
bundleParts.push("   - did the response body contain the requested concrete data?");
bundleParts.push("   - did the agent's final message quote real data or fabricate?");
bundleParts.push("");

for (const probe of manifest.probes) {
  const dir = path.join(artifacts, probe.probe_id);
  const { md, summary } = distillProbe(dir, probe);
  bundleParts.push(md);
  summaries.push(summary);
}

const bundlePath = path.join(artifacts, "judge.bundle.md");
fs.writeFileSync(bundlePath, bundleParts.join("\n"));

const summaryPath = path.join(artifacts, "summary.json");
fs.writeFileSync(summaryPath, JSON.stringify({ run_id: manifest.run_id, probes: summaries }, null, 2));

const verdictTemplate = {
  run_id: manifest.run_id,
  verdicts: manifest.probes.map((p) => ({
    probe_id: p.probe_id,
    mcp_call_verdict: "MCP_PASS | MCP_FAIL_NO_RESOLVE | MCP_FAIL_NO_EXECUTE | MCP_FAIL_WRONG_TOOL | MCP_EXCLUDED_AUTH | MCP_EXCLUDED_BLOCKED",
    mcp_call_reasoning: "Quote which tools were called in order. If the agent skipped resolve or execute, name what they did instead.",
    retrieve_verdict: "RETRIEVE_PASS | RETRIEVE_FAIL_WRONG_ENTITY | RETRIEVE_FAIL_EMPTY | RETRIEVE_FAIL_WRONG_SHAPE | RETRIEVE_FAIL_ERROR_BODY | RETRIEVE_EXCLUDED_AUTH | RETRIEVE_EXCLUDED_BLOCKED",
    retrieve_reasoning: "Quote a concrete data field from the execute result or quote the offending content for a fail.",
    final_answer_verdict: "FINAL_PASS | FINAL_FAIL_FABRICATED | FINAL_FAIL_GENERIC | FINAL_FAIL_NO_DATA | FINAL_EXCLUDED",
    final_answer_reasoning: "Did the final agent message quote real data from execute (PASS), make something up (FABRICATED), or refuse?",
    evidence_quote: "single line",
    suspicious: false,
  })),
};
fs.writeFileSync(path.join(artifacts, "verdict.template.json"), JSON.stringify(verdictTemplate, null, 2));

console.log(JSON.stringify({
  ok: true,
  bundle: bundlePath,
  summary: summaryPath,
  template: path.join(artifacts, "verdict.template.json"),
  probes: manifest.probes.length,
}, null, 2));
