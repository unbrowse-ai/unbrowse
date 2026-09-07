#!/usr/bin/env bash
# mcp-stdio-lifecycle-probe.sh
#
# Falsifier: does the unbrowse MCP stdio child stay alive across a 13s idle
# gap between tool calls? Observed bug: child exits "cleanly" 1-2s into a
# tool call after such a gap.
#
# Spawns `unbrowse mcp` the way Claude Code does (stdio piped, no flags) and
# drives JSON-RPC over stdin/stdout via a small embedded Node runner.
#
# Exit codes:
#   0 = PROBE_PASSED — child survived all idle+call iterations
#   1 = PROBE_FAILED — any assertion failed (child died, missing response, etc.)
#   2 = PROBE_ERROR  — setup/spawn failure (binary missing, etc.)
#
# Run:
#   bash scripts/mcp-stdio-lifecycle-probe.sh
#
# Env overrides:
#   PROBE_ITERATIONS=10            # idle+call cycles
#   PROBE_IDLE_SECS=13             # idle gap (the bug's trigger)
#   PROBE_CALL_TIMEOUT=60          # per-call response timeout (s)
#   PROBE_TOOL=unbrowse_resolve    # MCP tool to call. The bug report named
#                                  # unbrowse_fetch, but no such tool is
#                                  # registered; unbrowse_resolve is the
#                                  # canonical fetch-like op. Override if a
#                                  # build adds unbrowse_fetch.
#   PROBE_URL=https://example.com
#   PROBE_INTENT="fetch the page"

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p "$ROOT/.harness-out"
TS="$(date +%Y%m%dT%H%M%S)"
OUT_JSONL="$ROOT/.harness-out/mcp-stdio-probe-${TS}.jsonl"

# Prefer installed binary (the path that exhibits the bug).
UNBROWSE_BIN="$(command -v unbrowse || true)"
if [ -n "$UNBROWSE_BIN" ]; then
  SPAWN_KIND="installed"
  SPAWN_CMD_DESC="$UNBROWSE_BIN mcp"
else
  SPAWN_KIND="source"
  if ! command -v bun >/dev/null 2>&1; then
    echo "PROBE_ERROR no unbrowse binary on PATH and bun not installed; cannot fall back to source" >&2
    exit 2
  fi
  SPAWN_CMD_DESC="bun src/mcp.ts"
fi

export PROBE_ITERATIONS="${PROBE_ITERATIONS:-10}"
export PROBE_IDLE_SECS="${PROBE_IDLE_SECS:-13}"
export PROBE_CALL_TIMEOUT="${PROBE_CALL_TIMEOUT:-60}"
export PROBE_TOOL="${PROBE_TOOL:-unbrowse_resolve}"
export PROBE_URL="${PROBE_URL:-https://example.com}"
export PROBE_INTENT="${PROBE_INTENT:-fetch the example.com page}"
export PROBE_OUT_JSONL="$OUT_JSONL"
export PROBE_UNBROWSE_BIN="$UNBROWSE_BIN"
export PROBE_SPAWN_KIND="$SPAWN_KIND"
export PROBE_ROOT="$ROOT"

echo "[probe] spawn=$SPAWN_KIND ($SPAWN_CMD_DESC) tool=$PROBE_TOOL iters=$PROBE_ITERATIONS idle=${PROBE_IDLE_SECS}s evidence=$OUT_JSONL" >&2

exec node --no-warnings -e '
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const fs = require("node:fs");

const ITERS = parseInt(process.env.PROBE_ITERATIONS, 10);
const IDLE_MS = parseInt(process.env.PROBE_IDLE_SECS, 10) * 1000;
const CALL_TIMEOUT_MS = parseInt(process.env.PROBE_CALL_TIMEOUT, 10) * 1000;
const TOOL = process.env.PROBE_TOOL;
const URL_ARG = process.env.PROBE_URL;
const INTENT = process.env.PROBE_INTENT;
const OUT = process.env.PROBE_OUT_JSONL;
const BIN = process.env.PROBE_UNBROWSE_BIN;
const ROOT = process.env.PROBE_ROOT;

const out = fs.createWriteStream(OUT, { flags: "a" });
const log = (obj) => { out.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n"); };

let cmd, args;
if (BIN) { cmd = BIN; args = ["mcp"]; }
else     { cmd = "bun"; args = ["src/mcp.ts"]; }

const child = spawn(cmd, args, {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, MCP_SERVER_MODE: "1" },
});

let stderrBuf = "";
child.stderr.on("data", (c) => {
  stderrBuf += c.toString();
  if (stderrBuf.length > 200000) stderrBuf = stderrBuf.slice(-100000);
});

let exited = false;
let exitInfo = null;
child.once("exit", (code, signal) => {
  exited = true;
  exitInfo = { code, signal };
  log({ event: "child_exit", code, signal, stderr_tail: stderrBuf.slice(-2000) });
});
child.once("error", (err) => {
  log({ event: "spawn_error", message: err.message });
  fail("spawn_error", err.message);
});

const pending = new Map();
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (msg && msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }
});

function send(id, method, params) {
  const req = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout waiting for id=" + id + " method=" + method + " after " + CALL_TIMEOUT_MS + "ms"));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    if (exited) {
      clearTimeout(timer); pending.delete(id);
      reject(new Error("child exited before send id=" + id));
      return;
    }
    child.stdin.write(JSON.stringify(req) + "\n", (err) => {
      if (err) { clearTimeout(timer); pending.delete(id); reject(err); }
    });
  });
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(mode, detail) {
  log({ event: "probe_failed", mode, detail, child_pid: child.pid, child_alive: !exited && pidAlive(child.pid), exit: exitInfo, stderr_tail: stderrBuf.slice(-2000) });
  console.log("PROBE_FAILED mode=" + mode + " detail=" + JSON.stringify(detail) + " pid=" + child.pid + " exit=" + JSON.stringify(exitInfo) + " evidence=" + OUT);
  try { child.kill("SIGKILL"); } catch {}
  process.exit(1);
}

(async () => {
  log({ event: "probe_start", child_pid: child.pid, cmd, args, iters: ITERS, idle_ms: IDLE_MS, tool: TOOL });

  let resp;
  try {
    resp = await send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-stdio-lifecycle-probe", version: "1" } });
  } catch (e) { return fail("initialize_failed", e.message); }
  log({ event: "initialize_ok", result_keys: resp.result ? Object.keys(resp.result) : null });

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  try {
    resp = await send(2, "tools/list", {});
  } catch (e) { return fail("tools_list_failed", e.message); }
  const toolNames = (resp.result && Array.isArray(resp.result.tools)) ? resp.result.tools.map((t) => t.name) : [];
  log({ event: "tools_list_ok", count: toolNames.length, has_target: toolNames.includes(TOOL) });
  if (!toolNames.includes(TOOL)) {
    return fail("tool_missing", { tool: TOOL, available_sample: toolNames.slice(0, 12) });
  }

  const callArgs = TOOL === "unbrowse_resolve"
    ? { intent: INTENT, url: URL_ARG }
    : { url: URL_ARG };

  try {
    resp = await send(3, "tools/call", { name: TOOL, arguments: callArgs });
  } catch (e) { return fail("warmup_call_failed", e.message); }
  if (exited) return fail("child_exited_during_warmup", exitInfo);
  log({ event: "warmup_call_ok", has_result: resp.result !== undefined, has_error: resp.error !== undefined });

  let nextId = 4;
  for (let i = 1; i <= ITERS; i++) {
    log({ event: "idle_begin", iter: i, idle_ms: IDLE_MS, child_alive_before_idle: !exited && pidAlive(child.pid) });
    await sleep(IDLE_MS);

    if (exited) {
      log({ event: "child_died_during_idle", iter: i, exit: exitInfo });
      return fail("child_exited_during_idle", { iter: i, exit: exitInfo });
    }
    if (!pidAlive(child.pid)) {
      return fail("child_pid_dead_after_idle", { iter: i });
    }

    const id = nextId++;
    let r;
    const t0 = Date.now();
    try {
      r = await send(id, "tools/call", { name: TOOL, arguments: callArgs });
    } catch (e) {
      log({ event: "call_failed", iter: i, id, error: e.message, child_alive: !exited && pidAlive(child.pid), exit: exitInfo });
      return fail("call_after_idle_failed", { iter: i, id, error: e.message, exit: exitInfo });
    }
    const dt = Date.now() - t0;
    if (exited) return fail("child_exited_during_call", { iter: i, id, exit: exitInfo });
    if (!pidAlive(child.pid)) return fail("child_pid_dead_after_call", { iter: i, id });
    log({ event: "call_ok", iter: i, id, dt_ms: dt, has_result: r.result !== undefined, has_error: r.error !== undefined });
  }

  log({ event: "probe_passed", iters: ITERS, child_pid: child.pid, child_alive: pidAlive(child.pid) });
  console.log("PROBE_PASSED iters=" + ITERS + " idle=" + IDLE_MS + "ms pid=" + child.pid + " evidence=" + OUT);
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill("SIGTERM"); } catch {} process.exit(0); }, 500);
})().catch((e) => fail("probe_threw", e.stack || e.message));
'
