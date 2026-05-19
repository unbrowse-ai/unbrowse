#!/usr/bin/env bun
//
// Hot-reload MCP proxy. Sits between Claude Code (parent) and the
// unbrowse stdio MCP child (bun src/mcp.ts). Relays JSON-RPC lines
// bidirectionally and restarts the child when watched source files
// change, while keeping the parent connection alive.
//
// Design: .claude/build-a-proxy-mcp-server-in-front-of-unbrowse-mc/references/DESIGN.md
//
// Usage:
//   bun scripts/mcp-hot-proxy.ts                  # default child = "bun src/mcp.ts"
//   UNBROWSE_PROXY_CHILD_CMD="bun src/mcp.ts" bun scripts/mcp-hot-proxy.ts
//   UNBROWSE_PROXY_WATCH_GLOB="src/**/*.ts" bun scripts/mcp-hot-proxy.ts
//   UNBROWSE_PROXY_DEBOUNCE_MS=300 bun scripts/mcp-hot-proxy.ts
//   UNBROWSE_PROXY_SILENT=1 (suppress proxy stderr; child stderr still forwarded)
//
// MCP register: add to Claude Code mcpServers as
//   { "unbrowse": { "command": "bun", "args": ["<repo>/scripts/mcp-hot-proxy.ts"] } }

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import chokidar from "chokidar";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CHILD_CMD = (process.env.UNBROWSE_PROXY_CHILD_CMD || "bun src/mcp.ts").split(/\s+/);
const WATCH_GLOB = process.env.UNBROWSE_PROXY_WATCH_GLOB || "src/**/*.ts";
const EXTRA_WATCH = [
  "src/mcp.ts",
  "harness/probes/corpus-gate.txt",
  "harness/probes/GATE_JUDGE.md",
  "harness/probes/bench-gate-baseline.json",
];
const DEBOUNCE_MS = Number(process.env.UNBROWSE_PROXY_DEBOUNCE_MS || 300);
const CHILD_GRACE_MS = Number(process.env.UNBROWSE_PROXY_CHILD_GRACE_MS || 2000);
const CHILD_INIT_TIMEOUT_MS = Number(process.env.UNBROWSE_PROXY_CHILD_INIT_TIMEOUT_MS || 5000);
const CRASH_WINDOW_MS = 10_000;
const CRASH_LIMIT = 3;
const SILENT = process.env.UNBROWSE_PROXY_SILENT === "1";

function log(msg: string): void {
  if (SILENT) return;
  process.stderr.write(`[mcp-hot-proxy] ${msg}\n`);
}

type ProxyState = {
  child: ChildProcess | null;
  childReader: Interface | null;
  // Raw bytes of the parent's initialize request, for replay on child respawn.
  initializeLine: string | null;
  // Lines from parent that arrived while child was down. Drained after respawn.
  parentQueue: string[];
  // Map of JSON-RPC ids in flight from parent to child. On restart we cancel
  // them with -32099 so the parent sees a transient error and retries.
  inflight: Set<string | number>;
  // Crash budget.
  crashes: number[];
  // Set true between SIGTERM and post-init drain.
  restarting: boolean;
};

const state: ProxyState = {
  child: null,
  childReader: null,
  initializeLine: null,
  parentQueue: [],
  inflight: new Set(),
  crashes: [],
  restarting: false,
};

function writeToParent(line: string): void {
  process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
}

function cancelInflight(reason: string): void {
  if (state.inflight.size === 0) return;
  log(`cancelling ${state.inflight.size} in-flight request(s): ${reason}`);
  for (const id of state.inflight) {
    writeToParent(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32099, message: `proxy hot-reload: ${reason}` },
    }));
  }
  state.inflight.clear();
}

function tryParseId(line: string): string | number | null {
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj === "object" && "id" in obj) {
      return obj.id;
    }
  } catch { /* tolerate; the relay still forwards */ }
  return null;
}

function isInitialize(line: string): boolean {
  try {
    const obj = JSON.parse(line);
    return obj && obj.method === "initialize";
  } catch {
    return false;
  }
}

async function spawnChild(): Promise<void> {
  log(`spawning child: ${CHILD_CMD.join(" ")}`);
  const [cmd, ...args] = CHILD_CMD;
  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, UNBROWSE_PROXY_CHILD: "1" },
  });
  state.child = child;
  state.childReader = createInterface({ input: child.stdout!, crlfDelay: Infinity });

  state.childReader.on("line", (line) => {
    // Suppress the replayed-initialize response if we are inside a restart drain.
    if (state.restarting && tryParseId(line) === -1) {
      log("swallowing replay-initialize response from child");
      return;
    }
    const id = tryParseId(line);
    if (id != null) state.inflight.delete(id);
    writeToParent(line);
  });

  child.on("exit", (code, signal) => {
    log(`child exited code=${code} signal=${signal} restarting=${state.restarting}`);
    state.child = null;
    state.childReader = null;
    if (!state.restarting) {
      // Unexpected exit; auto-respawn with crash budget.
      const now = Date.now();
      state.crashes = state.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
      state.crashes.push(now);
      cancelInflight("child crashed");
      if (state.crashes.length > CRASH_LIMIT) {
        log(`crash budget exceeded (${state.crashes.length} in ${CRASH_WINDOW_MS}ms); giving up`);
        writeToParent(JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "error", data: "unbrowse child crashed repeatedly; waiting for source edit" },
        }));
        return;
      }
      log("auto-respawning after crash");
      void restart("crash");
    }
  });

  if (state.initializeLine) {
    // Replay initialize with sentinel id=-1; the response is discarded above.
    const replay = state.initializeLine.replace(/"id"\s*:\s*[^,}]+/, '"id":-1');
    log("replaying cached initialize to new child");
    child.stdin!.write(replay.endsWith("\n") ? replay : `${replay}\n`);
    // Wait briefly for the response, then drain queue.
    await waitForChildReply(-1, CHILD_INIT_TIMEOUT_MS);
  }
}

function waitForChildReply(_id: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    // We do not actually parse the reply id; spawn-and-grace is enough for MVP.
    // The childReader 'line' handler will swallow id=-1 during restarting=true.
    setTimeout(resolve, Math.min(500, timeoutMs));
  });
}

async function restart(reason: string): Promise<void> {
  if (state.restarting) {
    log(`restart already in progress (reason=${reason}, current=in-progress)`);
    return;
  }
  state.restarting = true;
  log(`restart requested: ${reason}`);
  cancelInflight(reason);
  if (state.child) {
    const child = state.child;
    child.kill("SIGTERM");
    const exited = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), CHILD_GRACE_MS);
      child.once("exit", () => { clearTimeout(t); resolve(true); });
    });
    if (!exited) {
      log("child did not exit in grace; SIGKILL");
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
  await spawnChild();
  // Drain queued parent lines to new child.
  const queue = state.parentQueue.splice(0);
  if (queue.length > 0) {
    log(`draining ${queue.length} queued parent line(s)`);
    for (const line of queue) {
      state.child?.stdin?.write(line.endsWith("\n") ? line : `${line}\n`);
    }
  }
  state.restarting = false;
  log(`restart complete: ${reason}`);
}

function setupWatcher(): void {
  const paths = [path.join(REPO_ROOT, WATCH_GLOB), ...EXTRA_WATCH.map((p) => path.join(REPO_ROOT, p))];
  log(`watching: ${paths.join(", ")}`);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = chokidar.watch(paths, {
    ignored: [/node_modules/, /\.git/, /\.bench-gate/, /\.bench-local/, /dist\//, /\.test\.ts$/],
    ignoreInitial: true,
    persistent: true,
  });
  const trigger = (event: string, filePath: string): void => {
    log(`watcher ${event}: ${path.relative(REPO_ROOT, filePath)}`);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void restart(`file ${event}: ${path.relative(REPO_ROOT, filePath)}`);
    }, DEBOUNCE_MS);
  };
  watcher.on("change", (p) => trigger("change", p));
  watcher.on("add", (p) => trigger("add", p));
  watcher.on("unlink", (p) => trigger("unlink", p));
  watcher.on("error", (err) => log(`watcher error: ${err}`));
}

function setupParentReader(): void {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  reader.on("line", (line) => {
    if (line.trim() === "") return;
    if (!state.initializeLine && isInitialize(line)) {
      state.initializeLine = line;
      log("cached parent initialize for future child replay");
    }
    const id = tryParseId(line);
    if (id != null) state.inflight.add(id);
    if (state.restarting || !state.child) {
      state.parentQueue.push(line);
      return;
    }
    state.child.stdin?.write(line.endsWith("\n") ? line : `${line}\n`);
  });
  reader.on("close", () => {
    log("parent stdin closed; shutting down");
    if (state.child) state.child.kill("SIGTERM");
    process.exit(0);
  });
}

async function main(): Promise<void> {
  process.on("SIGTERM", () => {
    log("got SIGTERM; forwarding to child and exiting");
    if (state.child) state.child.kill("SIGTERM");
    process.exit(0);
  });
  setupParentReader();
  await spawnChild();
  setupWatcher();
  log("proxy ready");
}

void main();
