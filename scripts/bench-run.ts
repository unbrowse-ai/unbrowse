#!/usr/bin/env bun
// bench-run.ts — substrate-side bench-executor adapter.
//
// Replaces the working-tree-deleted bench-local.sh per CLAUDE.md
// ("benches should never be scripts" — 2026-05-26). Same contract as
// the deleted shell: read a corpus, drive `bun src/cli.ts resolve` per
// probe, write per-probe raw artifacts + a results.jsonl of evidence
// fields. ZERO heuristic verdicts emitted by this executor — the agent
// reads results.jsonl + .out files in-thread and judges per the
// rubric documented in docs/benchmarks.md.
//
// Usage:
//   bun scripts/bench-run.ts                                  # default corpus, parallel=3
//   bun scripts/bench-run.ts --corpus harness/probes/corpus.txt
//   bun scripts/bench-run.ts --parallel 4 --timeout 90
//   bun scripts/bench-run.ts --out .bench-local/run-$(date +%s)
//
// Output:
//   <out>/results.jsonl   evidence rows, one per probe (no verdict field)
//   <out>/<idx>_<slug>.out  raw CLI stdout/stderr per probe
//   <out>/index.txt       idx | intent | url | cli_exit
//   <out>/manifest.json   run metadata (cli, version, corpus, timing)

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";

interface ProbeRow {
  idx: number;
  intent: string;
  url: string;
  auth: string;
  lane: string;
}
interface Args {
  corpus: string;
  parallel: number;
  timeoutMs: number;
  outDir: string;
  cli: string;
  forceCapture: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    corpus: "harness/probes/corpus.txt",
    parallel: 3,
    timeoutMs: 90_000,
    outDir: `.bench-local/run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    cli: "bun src/cli.ts",
    forceCapture: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--corpus": a.corpus = v; i++; break;
      case "--parallel": a.parallel = parseInt(v, 10); i++; break;
      case "--timeout": a.timeoutMs = parseInt(v, 10) * 1000; i++; break;
      case "--out": a.outDir = v; i++; break;
      case "--cli": a.cli = v; i++; break;
      case "--no-force-capture": a.forceCapture = false; break;
    }
  }
  return a;
}

function readCorpus(path: string): ProbeRow[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const rows: ProbeRow[] = [];
  let pendingLane = "";
  let pendingAuth = "none";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("@class:")) {
      const cls = line.slice(7).trim();
      if (cls === "auth-gated") pendingAuth = "required";
      continue;
    }
    if (line.startsWith("#")) continue;
    const parts = line.split("|").map((s) => s.trim());
    let intent = "", url = "", auth = pendingAuth, lane = pendingLane;
    if (parts.length >= 6) {
      // 6-field: lane|auth|difficulty|strategy|intent|url
      [lane, auth] = [parts[0], parts[1]];
      intent = parts[4];
      url = parts[5];
    } else if (parts.length === 3) {
      // dimensional: lane|intent|url
      lane = parts[0];
      intent = parts[1];
      url = parts[2];
    } else if (parts.length === 2) {
      intent = parts[0];
      url = parts[1];
    } else {
      continue;
    }
    if (!intent || !url) continue;
    rows.push({ idx: rows.length + 1, intent, url, auth, lane });
    pendingAuth = "none"; // @class: only applies to next probe
  }
  return rows;
}

function slugify(s: string): string {
  return s.replace(/[\/:?&=.]/g, "_").slice(0, 60);
}

async function runProbe(probe: ProbeRow, args: Args): Promise<{ exit: number; outFile: string; record: any }> {
  const outFile = resolvePath(args.outDir, `${probe.idx}_${slugify(probe.url)}.out`);
  const cliArgs = ["src/cli.ts", "resolve", "--intent", probe.intent, "--url", probe.url];
  if (args.forceCapture) cliArgs.push("--force-capture");
  // Bun is the runtime; cli is "bun src/cli.ts"
  const [cmd, ...cmdArgs] = args.cli.split(" ");
  const exit = await new Promise<number>((resolve) => {
    const proc = spawn(cmd, [...cmdArgs, ...cliArgs.slice(1)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, UNBROWSE_API_TIMEOUT_MS: String(args.timeoutMs) },
    });
    const ws = require("node:fs").createWriteStream(outFile);
    proc.stdout.pipe(ws, { end: false });
    proc.stderr.pipe(ws, { end: false });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, args.timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      ws.end();
      resolve(code ?? 124);
    });
  });
  const raw = readFileSync(outFile, "utf8");
  const record = extractEvidence(raw, probe, exit);
  return { exit, outFile, record };
}

// Find the largest top-level JSON object the CLI emitted using a proper
// brace-counter (string-aware, escape-aware). Same intent as the deleted
// bench-local.sh's extract.py but without the O(N²) slice-decrement.
export function extractTopLevelJson(raw: string): Record<string, any> {
  const candidates: Array<{ size: number; obj: any }> = [];
  // Match plausible top-level keys. The CLI's resolve --json output starts
  // with `{"trace":...}` or `{"result":...}`.
  const startRe = /\{"(?:trace|result|error|skill_id|success|source|available_operations|available_endpoints)"/g;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(raw))) {
    const start = m.index;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { inStr = false; continue; }
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) continue;
    const slice = raw.slice(start, end);
    try {
      const obj = JSON.parse(slice);
      if (obj && typeof obj === "object") {
        candidates.push({ size: slice.length, obj });
      }
    } catch {}
    // Advance past this candidate to avoid re-matching nested keys
    startRe.lastIndex = end;
  }
  if (!candidates.length) return {};
  candidates.sort((a, b) => b.size - a.size);
  for (const { obj } of candidates) {
    if (obj.available_operations || obj.available_endpoints) return obj;
    const r = obj.result;
    if (r && typeof r === "object" && (r.available_operations || r.available_endpoints || r.error)) {
      return obj;
    }
  }
  return candidates[0].obj;
}

export function extractEvidence(raw: string, probe: ProbeRow, cliExit: number): Record<string, any> {
  const d = extractTopLevelJson(raw);
  const r = (d && typeof d.result === "object" && d.result) ? d.result : {};
  const trace = (d && typeof d.trace === "object" && d.trace) ? d.trace : {};
  const source = (d && typeof d.source === "string") ? d.source : "";
  const meta = (r && typeof r.captured_meta === "object" && r.captured_meta) ? r.captured_meta : {};
  const ops = (r.available_operations || r.available_endpoints || d.available_operations || d.available_endpoints || []) as any[];
  return {
    goal: probe.intent,
    url: probe.url,
    auth: probe.auth,
    lane: probe.lane,
    source,
    trace_success: typeof trace.success === "boolean" ? trace.success : null,
    trace_skill_id: trace.skill_id || "",
    has_available_operations: ops.length > 0,
    n_operations: ops.length,
    error_code: r.error || d.error || "",
    error_message: String(r.message || "").slice(0, 300),
    captured_html_bytes: meta.html_bytes ?? "",
    captured_text_bytes: meta.text_bytes ?? "",
    captured_title: String(meta.title || "").slice(0, 100),
    captured_api_calls: meta.observed_api_calls ?? "",
    captured_intent_verdict: meta.intent_verdict || "",
    captured_intent_reason: meta.intent_reason || "",
    filter_rejections: JSON.stringify(meta.filter_rejections || {}, Object.keys(meta.filter_rejections || {}).sort()),
    browser_block_signals: JSON.stringify(meta.browser_block_signals || []),
    capture_diagnostic: r.capture_diagnostic || "",
    total_endpoints_captured: r.total_endpoints_captured ?? "",
    auth_recommended: r.auth_recommended === true,
    cli_exit: cliExit,
    cli_timeout: cliExit === 124 || cliExit === 137,
    raw_bytes: raw.length,
    response_text_excerpt: String(r.text_excerpt || r.title || "").slice(0, 400),
    // NO verdict field — agent judges in-thread per docs/benchmarks.md rubric.
  };
}

// Only run main() when invoked directly (not when imported).
const isMain = import.meta.url === `file://${process.argv[1]}`;

async function main() {
  const args = parseArgs(process.argv);
  mkdirSync(args.outDir, { recursive: true });
  const probes = readCorpus(args.corpus);
  console.error(`[bench-run] corpus=${args.corpus} probes=${probes.length} parallel=${args.parallel} timeout=${args.timeoutMs}ms out=${args.outDir}`);
  writeFileSync(resolvePath(args.outDir, "manifest.json"), JSON.stringify({
    started_at: new Date().toISOString(),
    corpus: args.corpus,
    parallel: args.parallel,
    timeout_ms: args.timeoutMs,
    cli: args.cli,
    force_capture: args.forceCapture,
    probe_count: probes.length,
  }, null, 2));
  const resultsPath = resolvePath(args.outDir, "results.jsonl");
  const indexPath = resolvePath(args.outDir, "index.txt");
  writeFileSync(resultsPath, "");
  writeFileSync(indexPath, "");

  let done = 0;
  const queue = [...probes];
  async function worker(workerId: number) {
    while (queue.length) {
      const probe = queue.shift();
      if (!probe) return;
      const t0 = Date.now();
      try {
        const { exit, record } = await runProbe(probe, args);
        appendFileSync(resultsPath, JSON.stringify(record) + "\n");
        appendFileSync(indexPath, `${probe.idx}|${probe.intent}|${probe.url}|exit=${exit}|ms=${Date.now() - t0}\n`);
        done++;
        const tag = record.has_available_operations ? `ops=${record.n_operations}` :
                    record.cli_timeout ? "TIMEOUT" :
                    record.error_code ? `err=${record.error_code}` : "no-ops";
        console.error(`[bench-run] ${done}/${probes.length} w${workerId} (${Date.now() - t0}ms) ${tag} :: ${probe.url}`);
      } catch (e: any) {
        appendFileSync(resultsPath, JSON.stringify({ goal: probe.intent, url: probe.url, exception: String(e), cli_exit: -1 }) + "\n");
        appendFileSync(indexPath, `${probe.idx}|${probe.intent}|${probe.url}|exception\n`);
        done++;
        console.error(`[bench-run] ${done}/${probes.length} w${workerId} EXC :: ${e?.message || e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: args.parallel }, (_, i) => worker(i + 1)));
  const finishedAt = new Date().toISOString();
  const manifest = JSON.parse(readFileSync(resolvePath(args.outDir, "manifest.json"), "utf8"));
  manifest.finished_at = finishedAt;
  writeFileSync(resolvePath(args.outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.error(`[bench-run] DONE — ${done} probes, evidence at ${resultsPath}`);
}

if (isMain) {
  main().catch((e) => { console.error("[bench-run] FATAL", e); process.exit(1); });
}
