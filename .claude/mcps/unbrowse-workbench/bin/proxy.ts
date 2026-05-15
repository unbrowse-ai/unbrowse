#!/usr/bin/env bun
// unbrowse-workbench proxy MCP. Day-3 mustard-seed.
//
// Stdin: line-delimited JSON-RPC requests from Claude Code.
// Stdout: line-delimited JSON-RPC responses, with a _workbench_delta
//   field merged into the root of tools/call responses.
//
// For tools/call requests: fan out to BOTH candidate and baseline.
// For all other requests (initialize, tools/list, ping, etc.): forward
// to the LIVE side only.
//
// On SIGHUP: swap which side is live. Actual swap-test harness lands
// Day 4 (Luminaries). Stub here so the wiring is real on Day 3.

import { LineReader, encodeMessage } from "../src/framing.ts";
import { spawnChild, parseCommand } from "../src/spawn.ts";
import { Fanout } from "../src/fanout.ts";

const DEFAULT_CANDIDATE =
  "bun run /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/src/mcp.ts";

const candidateCmd = process.env.UNBROWSE_BIN_CANDIDATE || DEFAULT_CANDIDATE;
const baselineCmd = (process.env.UNBROWSE_BIN_BASELINE || "").trim();

function logErr(s: string): void {
  process.stderr.write(`[workbench] ${s}\n`);
}

logErr(`candidate=${candidateCmd}`);
logErr(`baseline=${baselineCmd || "(not set; baseline side disabled)"}`);

const candParsed = parseCommand(candidateCmd);
const candidate = spawnChild(candParsed.command, candParsed.args, {}, "candidate");

let baseline: ReturnType<typeof spawnChild> | null = null;
if (baselineCmd) {
  try {
    const baseParsed = parseCommand(baselineCmd);
    baseline = spawnChild(baseParsed.command, baseParsed.args, {}, "baseline");
  } catch (err) {
    logErr(`baseline spawn failed: ${(err as Error).message}`);
    baseline = null;
  }
}

const fan = new Fanout(candidate, baseline);

let liveSide: "candidate" | "baseline" = "candidate";

// SIGHUP hot-swap. Day-4 swap-test will drive this externally.
process.on("SIGHUP", () => {
  const next = liveSide === "candidate" ? "baseline" : "candidate";
  if (next === "baseline" && !baseline) {
    logErr("SIGHUP: cannot swap to baseline; baseline child is not running");
    return;
  }
  liveSide = next;
  logErr(`SIGHUP: liveSide=${liveSide}`);
});

function writeOut(obj: unknown): void {
  process.stdout.write(encodeMessage(obj));
}

async function handleRequest(request: Record<string, unknown>): Promise<void> {
  const method = String(request["method"] ?? "");
  const id = request["id"];
  const isCall = method === "tools/call";
  const hasId = id !== undefined && id !== null;

  if (!hasId) {
    // Notification: forward to live side only, no response expected.
    const target = liveSide === "candidate" ? candidate : baseline ?? candidate;
    target.send(encodeMessage(request));
    return;
  }

  if (!isCall) {
    // Initialize, tools/list, ping, etc. Forward to LIVE side only.
    // Day-4 may decide whether tools/list needs cross-side reconciliation.
    const target = liveSide === "candidate" ? candidate : baseline ?? candidate;
    // We still need a per-side awaiter; use fanout machinery on one side
    // only by sending the request and watching for the response in the
    // same Fanout awaiter map (which keys on id).
    try {
      const result = await fan.fanout(request, liveSide);
      writeOut(result.liveResponse);
    } catch (err) {
      writeOut({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: `workbench fanout error: ${(err as Error).message}`,
        },
      });
    }
    return;
  }

  // tools/call: fan out to both sides.
  let result;
  try {
    result = await fan.fanout(request, liveSide);
  } catch (err) {
    writeOut({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: `workbench fanout error: ${(err as Error).message}`,
      },
    });
    return;
  }

  const merged = { ...result.liveResponse };
  merged["_workbench_delta"] = {
    live: liveSide,
    candidate: result.candidate,
    baseline: result.baseline,
    diff: {
      bytes_diff: result.candidate.bytes - result.baseline.bytes,
      ms_diff: result.candidate.ms - result.baseline.ms,
      // Day-4 (Luminaries) replaces this with a real structural diff.
      structural_diff_summary: "TODO",
    },
  };
  writeOut(merged);
}

const reader = new LineReader((line) => {
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(line) as Record<string, unknown>;
  } catch (err) {
    logErr(`undecodable stdin line: ${line.slice(0, 200)}`);
    return;
  }
  // Fire-and-forget; ordering across requests is preserved by id-keyed
  // awaiters, not by sequencing on this side.
  void handleRequest(req).catch((err) => {
    logErr(`handler crash: ${(err as Error).stack ?? err}`);
  });
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => reader.push(chunk));
process.stdin.on("end", () => {
  reader.flush();
  logErr("stdin EOF; killing children");
  candidate.kill();
  if (baseline) baseline.kill();
  // Give children a moment to exit; then force exit.
  setTimeout(() => process.exit(0), 250);
});

process.on("SIGINT", () => {
  candidate.kill();
  if (baseline) baseline.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  candidate.kill();
  if (baseline) baseline.kill();
  process.exit(0);
});
