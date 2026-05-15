#!/usr/bin/env bun
// Record the v6.16.0 baseline's unbrowse_resolve response for every corpus
// probe ONCE into a golden manifest. The workbench proxy in
// WORKBENCH_BASELINE_MODE=recorded then diffs candidate against this file
// instead of spawning a live baseline daemon and fanning every call to it.
//
// Why resolve-only: resolve is called twice per probe and carries the
// richest delta (shortlist shape, ranked endpoints, action_kind). Its key
// is purely (intent,url) so the recording stays valid across runs. execute
// deltas are site/run dependent (need a live skill_id) — out of scope v1.
//
// Sequential by design: this runs ONCE and sequential avoids the tab
// contention that the whole recorded-mode change exists to escape.
//
// Usage:
//   bun scripts/workbench-record-baseline.ts \
//     [--corpus harness/probes/corpus-gate.txt] \
//     [--baseline .workbench-baseline/v6.16.0/unbrowse] \
//     [--out .workbench-baseline/golden/manifest.jsonl] \
//     [--port 6972]

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { recordedKey } from "../.claude/mcps/unbrowse-workbench/src/recorded-baseline.ts";

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const REPO = resolve(import.meta.dir, "..");
const corpusPath = resolve(REPO, arg("--corpus", "harness/probes/corpus-gate.txt"));
const baselineBin = resolve(REPO, arg("--baseline", ".workbench-baseline/v6.16.0/unbrowse"));
const outPath = resolve(REPO, arg("--out", ".workbench-baseline/golden/manifest.jsonl"));
const port = arg("--port", "6972");
const baselineUrl = `http://127.0.0.1:${port}`;

if (!existsSync(corpusPath)) {
  console.error(`[record] corpus not found: ${corpusPath}`);
  process.exit(2);
}
if (!existsSync(baselineBin)) {
  console.error(`[record] baseline binary not found: ${baselineBin}`);
  console.error(`[record] run: bash .claude/mcps/unbrowse-workbench/scripts/workbench-fetch-baseline.sh`);
  process.exit(2);
}

// Parse corpus: "lane | auth | difficulty | strategy | intent | contextUrl".
// Skip comments and blank lines.
interface Probe { lane: string; intent: string; url: string; }
const probes: Probe[] = [];
for (const raw of readFileSync(corpusPath, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const parts = line.split("|").map((s) => s.trim());
  if (parts.length < 6) continue;
  probes.push({ lane: parts[0]!, intent: parts[4]!, url: parts[5]! });
}
console.error(`[record] ${probes.length} probes from ${corpusPath}`);

mkdirSync(dirname(outPath), { recursive: true });
// Truncate; this is a full re-record, not an append across runs.
writeFileSync(outPath, "");

// Spawn the baseline MCP. It auto-spawns its own Fastify daemon at
// UNBROWSE_URL; the dedicated port keeps it off the live wave's daemons.
const child = spawn(baselineBin, ["mcp"], {
  env: {
    ...process.env,
    UNBROWSE_URL: baselineUrl,
    UNBROWSE_NON_INTERACTIVE: "1",
    UNBROWSE_TOS_ACCEPTED: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c: string) => {
  // surface daemon boot/errors but keep them off stdout
  if (/error|fail|listen/i.test(c)) process.stderr.write(`[baseline] ${c}`);
});

let buf = "";
const pending = new Map<number, (msg: Record<string, unknown>) => void>();
child.stdout.on("data", (chunk: string) => {
  buf += chunk;
  let idx = buf.indexOf("\n");
  while (idx !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const mid = msg["id"];
        if (typeof mid === "number" && pending.has(mid)) {
          pending.get(mid)!(msg);
          pending.delete(mid);
        }
      } catch {
        // non-JSON banner line; ignore
      }
    }
    idx = buf.indexOf("\n");
  }
});

let nextId = 1;
function rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectP(new Error(`rpc timeout: ${method} after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolveP(msg);
    });
    child.stdin.write(payload);
  });
}

function notify(method: string, params: Record<string, unknown>): void {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function main(): Promise<void> {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "workbench-recorder", version: "1" },
  }, 30_000);
  notify("notifications/initialized", {});
  // Give the baseline daemon a moment to bind its Fastify port.
  await new Promise((r) => setTimeout(r, 2_000));

  let recorded = 0;
  let failed = 0;
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i]!;
    const args = { intent: p.intent, url: p.url };
    process.stderr.write(`[record] ${i + 1}/${probes.length} ${p.lane} :: ${p.intent}\n`);
    try {
      const msg = await rpc("tools/call", { name: "unbrowse_resolve", arguments: args }, 120_000);
      const response = (msg["result"] ?? msg["error"] ?? msg) as Record<string, unknown>;
      const entry = {
        key: recordedKey("unbrowse_resolve", args),
        tool: "unbrowse_resolve",
        lane: p.lane,
        intent: p.intent,
        url: p.url,
        response,
        baseline_version: "6.16.0",
        recorded_at: new Date().toISOString(),
      };
      appendFileSync(outPath, JSON.stringify(entry) + "\n");
      recorded++;
    } catch (err) {
      failed++;
      process.stderr.write(`[record] FAIL ${p.intent}: ${(err as Error).message}\n`);
    }
  }

  process.stderr.write(`[record] done: ${recorded} recorded, ${failed} failed -> ${outPath}\n`);
  child.stdin.end();
  setTimeout(() => process.exit(failed > 0 && recorded === 0 ? 1 : 0), 500);
}

main().catch((err) => {
  process.stderr.write(`[record] fatal: ${(err as Error).stack ?? err}\n`);
  try { child.kill("SIGTERM"); } catch { /* best-effort */ }
  process.exit(1);
});
