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
import { computeStructuralDiff } from "../src/delta.ts";
import { RecordedBaseline, RECORDED_TOOLS } from "../src/recorded-baseline.ts";
import { resolve as resolvePath } from "node:path";

const DEFAULT_CANDIDATE =
  "bun run /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/src/mcp.ts";

// Per-side UNBROWSE_URL so each child spawns its own Fastify HTTP daemon on a
// distinct port. Without this, the second child finds the first child's daemon
// already listening on :6969 and silently re-uses it — both "candidate" and
// "baseline" calls end up routed through the same upstream binary, which makes
// _workbench_delta meaningless. Defaults pick non-conflicting high ports.
const DEFAULT_CANDIDATE_URL = "http://127.0.0.1:6970";
const DEFAULT_BASELINE_URL = "http://127.0.0.1:6971";

const candidateCmd = process.env.UNBROWSE_BIN_CANDIDATE || DEFAULT_CANDIDATE;
const baselineCmd = (process.env.UNBROWSE_BIN_BASELINE || "").trim();
const candidateUrl = process.env.UNBROWSE_URL_CANDIDATE || DEFAULT_CANDIDATE_URL;
const baselineUrl = process.env.UNBROWSE_URL_BASELINE || DEFAULT_BASELINE_URL;

// Mode switch is GOLDEN-PRESENCE by default, not an env var. Rationale:
// /mcp reconnect does NOT re-read ~/.claude.json env (Claude Code caches
// the MCP config at session start), so an env-var switch needs a full
// Claude Code restart to flip. The golden file's existence is the
// declaration "use recorded mode" and survives any number of /mcp.
//
//   golden present + non-empty  -> recorded (no baseline daemon, ~half cost)
//   golden absent/empty         -> live (spawn baseline daemon, fan both)
//
// WORKBENCH_BASELINE_MODE is an optional FORCE override only:
//   "live"     -> always live even if a golden exists
//   "recorded" -> always recorded even if golden missing (degraded: emits
//                 no-recorded-baseline until the golden is recorded; the
//                 mtime re-stat in RecordedBaseline then picks it up with
//                 no restart)
const forceMode = (process.env.WORKBENCH_BASELINE_MODE || "").trim();
const goldenPath =
  process.env.WORKBENCH_GOLDEN_PATH ||
  resolvePath(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    ".workbench-baseline",
    "golden",
    "manifest.jsonl",
  );

function logErr(s: string): void {
  process.stderr.write(`[workbench] ${s}\n`);
}

// Always construct it (cheap: one statSync). hasGolden() drives the
// default; the instance also self-reloads on mtime change so a golden
// recorded after this proxy spawned takes effect with no restart.
const recordedProbe = new RecordedBaseline(goldenPath);
const goldenPresent = recordedProbe.hasGolden();

let recordedMode: boolean;
if (forceMode === "live") recordedMode = false;
else if (forceMode === "recorded") recordedMode = true;
else recordedMode = goldenPresent;

logErr(`candidate=${candidateCmd} url=${candidateUrl}`);
logErr(
  `baseline_mode=${recordedMode ? "recorded" : "live"} ` +
    `(golden=${goldenPresent ? `${recordedProbe.entryCount} entries` : "absent"}` +
    `${forceMode ? `, forced=${forceMode}` : ", auto"}) path=${recordedProbe.loadedFrom}`,
);

const candParsed = parseCommand(candidateCmd);
const candidate = spawnChild(
  candParsed.command,
  candParsed.args,
  { UNBROWSE_URL: candidateUrl },
  "candidate",
);

let baseline: ReturnType<typeof spawnChild> | null = null;
let recorded: RecordedBaseline | null = null;

if (recordedMode) {
  recorded = recordedProbe;
  if (!goldenPresent) {
    logErr(
      "recorded-baseline: forced recorded but golden missing/empty; run scripts/workbench-record-baseline.sh. Deltas report no-recorded-baseline until the file appears (auto-picked up, no restart).",
    );
  }
} else {
  logErr(
    `baseline=${baselineCmd || "(not set; baseline side disabled)"}${baselineCmd ? ` url=${baselineUrl}` : ""}`,
  );
  if (baselineCmd) {
    try {
      const baseParsed = parseCommand(baselineCmd);
      baseline = spawnChild(
        baseParsed.command,
        baseParsed.args,
        { UNBROWSE_URL: baselineUrl },
        "baseline",
      );
    } catch (err) {
      logErr(`baseline spawn failed: ${(err as Error).message}`);
      baseline = null;
    }
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

  // tools/call. live mode: fan to candidate+baseline. recorded mode:
  // candidate only, diff against the golden manifest.
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

  if (recorded) {
    // recorded mode: substitute the golden response for the live baseline.
    const params = (request["params"] ?? {}) as Record<string, unknown>;
    const toolName = String(params["name"] ?? "");
    const toolArgs = params["arguments"] ?? {};
    if (RECORDED_TOOLS.has(toolName)) {
      const entry = recorded.lookup(toolName, toolArgs);
      if (entry) {
        const diff = computeStructuralDiff(
          result.candidateResponse,
          entry.response,
          result.candidate,
          { ms: 0, bytes: Buffer.byteLength(JSON.stringify(entry.response), "utf8") },
        );
        merged["_workbench_delta"] = {
          live: "candidate",
          mode: "recorded",
          candidate: result.candidate,
          baseline: {
            ms: 0,
            bytes: Buffer.byteLength(JSON.stringify(entry.response), "utf8"),
            recorded_at: entry.recorded_at ?? null,
            baseline_version: entry.baseline_version ?? null,
          },
          diff,
        };
      } else {
        merged["_workbench_delta"] = {
          live: "candidate",
          mode: "recorded",
          candidate: result.candidate,
          baseline: null,
          diff: {
            bytes_diff: 0,
            ms_diff: 0,
            structural_diff_summary: `no recorded baseline for ${toolName} (run scripts/workbench-record-baseline.sh)`,
          },
        };
      }
    } else {
      // go/snap/close/execute: not in the golden set v1. candidate-only,
      // no synthetic diff (honest: we did not record this).
      merged["_workbench_delta"] = {
        live: "candidate",
        mode: "recorded",
        candidate: result.candidate,
        baseline: null,
        diff: {
          bytes_diff: 0,
          ms_diff: 0,
          structural_diff_summary: `recorded mode: ${toolName} not in golden set (resolve-only v1)`,
        },
      };
    }
    writeOut(merged);
    return;
  }

  // live mode: diff candidate against the live baseline sibling.
  const diff = computeStructuralDiff(
    result.candidateResponse,
    result.baselineResponse,
    result.candidate,
    result.baseline,
  );
  merged["_workbench_delta"] = {
    live: liveSide,
    mode: "live",
    candidate: result.candidate,
    baseline: result.baseline,
    diff,
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
