#!/usr/bin/env node
// One-off probe: does `unbrowse mcp` (the stdio child) survive the daemon
// being killed mid-call?
//
// Procedure:
//  1. Spawn `unbrowse mcp` as a child over stdio.
//  2. Send initialize + tools/list, then tools/call unbrowse_run with a
//     slow URL.
//  3. After ~3s, pkill -9 the `unbrowse serve` daemon (auto-spawned by mcp).
//  4. Watch stdout/stderr/exit for the MCP child.
//  5. Then fire a SECOND tools/call on the same surviving (?) child and
//     see whether ensureServerReady transparently respawns the daemon.
//
// Logs: ./.probe-out/daemon-death-cascade-$timestamp.log

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const OUT_DIR = new URL("../.probe-out/", import.meta.url);
mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = new URL(`daemon-death-cascade-${stamp}.log`, OUT_DIR);
const log = createWriteStream(logPath, { flags: "a" });
const t0 = Date.now();
function note(line) {
  const ms = String(Date.now() - t0).padStart(6, " ");
  const msg = `[+${ms}ms] ${line}`;
  console.log(msg);
  log.write(msg + "\n");
}

note(`probe start; log=${logPath.pathname}`);
note(`pre-clean: pkill -9 -f 'unbrowse|kuri'`);
spawnSync("pkill", ["-9", "-f", "unbrowse|kuri"]);
await sleep(2000);

note("spawn: unbrowse mcp");
const mcp = spawn("unbrowse", ["mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});
note(`mcp child pid=${mcp.pid}`);

let stdoutBuf = "";
const pending = new Map(); // id -> {resolve, reject, sentAt}

mcp.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const id = msg.id;
      note(`<- stdout id=${id} keys=${Object.keys(msg).join(",")}`);
      if (id != null && pending.has(id)) {
        const p = pending.get(id);
        pending.delete(id);
        p.resolve({ msg, recvAt: Date.now() });
      }
    } catch {
      note(`<- stdout (non-json): ${line.slice(0, 200)}`);
    }
  }
});
mcp.stderr.on("data", (chunk) => {
  const s = chunk.toString("utf8").trimEnd();
  for (const line of s.split("\n")) note(`<- stderr: ${line.slice(0, 240)}`);
});
mcp.on("exit", (code, signal) => {
  note(`!! mcp child exit code=${code} signal=${signal}`);
});
mcp.on("error", (err) => {
  note(`!! mcp child error: ${err.message}`);
});

function send(method, params, id) {
  const req = { jsonrpc: "2.0", id, method, params };
  note(`-> id=${id} method=${method}`);
  mcp.stdin.write(JSON.stringify(req) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, sentAt: Date.now() });
  });
}

// Track in-flight long call separately so we can race it against the kill.
async function main() {
  // initialize
  const initP = send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "daemon-death-probe", version: "0.0.1" },
  }, 1);
  await Promise.race([initP, sleep(15000).then(() => { throw new Error("initialize timeout"); })]);
  send("notifications/initialized", {}, undefined); // notification — no id
  // Actually the line above is wrong for notifications because we set id. Re-send raw:
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  note("-> notifications/initialized (notification)");

  // tools/list
  const tools = await Promise.race([
    send("tools/list", {}, 2),
    sleep(15000).then(() => { throw new Error("tools/list timeout"); }),
  ]);
  const toolNames = (tools.msg.result?.tools || []).map((t) => t.name);
  note(`tools/list returned ${toolNames.length} tools; sample=${toolNames.slice(0, 6).join(",")}`);

  // Confirm daemon is up (mcp child auto-spawns it). Read pidfile.
  let daemonPid = null;
  for (let i = 0; i < 20; i++) {
    try {
      const { readFileSync } = await import("node:fs");
      const j = JSON.parse(readFileSync(`${process.env.HOME}/.unbrowse/run/server-localhost-6969.json`, "utf8"));
      // sanity: process actually exists
      try { process.kill(j.pid, 0); daemonPid = j.pid; break; } catch {}
    } catch {}
    await sleep(250);
  }
  note(`daemon pidfile pid=${daemonPid}`);

  // tools/call unbrowse_run on a slow URL — long-running
  const callP = send("tools/call", {
    name: "unbrowse_resolve",
    arguments: {
      intent: "search shoes",
      url: "https://www.carousell.sg/search/shoes",
      force_capture: true,
    },
  }, 3);

  // After ~3s, kill daemon.
  await sleep(3000);
  if (daemonPid) {
    note(`KILLING daemon pid=${daemonPid} with SIGKILL`);
    try { process.kill(daemonPid, "SIGKILL"); } catch (e) { note(`kill failed: ${e.message}`); }
  } else {
    note("WARN: no daemon pid known; falling back to pkill -9 -f 'unbrowse serve'");
    spawnSync("pkill", ["-9", "-f", "unbrowse serve"]);
  }
  note("daemon killed; now waiting on in-flight call result (timeout 30s)");

  let callResult;
  try {
    callResult = await Promise.race([
      callP,
      sleep(30000).then(() => ({ timedOut: true })),
    ]);
  } catch (e) {
    callResult = { error: e.message };
  }
  if (callResult?.timedOut) {
    note("IN-FLIGHT CALL: timed out after 30s (hang)");
  } else if (callResult?.msg) {
    const m = callResult.msg;
    const errStr = m.error ? JSON.stringify(m.error).slice(0, 400) : null;
    const isErr = !!m.error || m.result?.isError;
    note(`IN-FLIGHT CALL returned id=${m.id} isError=${isErr} error=${errStr}`);
    if (m.result?.content) {
      const text = m.result.content?.[0]?.text;
      note(`IN-FLIGHT CALL content excerpt: ${(text || "").slice(0, 300).replace(/\n/g, " | ")}`);
    }
  } else {
    note(`IN-FLIGHT CALL unexpected: ${JSON.stringify(callResult).slice(0, 300)}`);
  }

  // If child still alive, try a second call to test transparent respawn.
  if (mcp.exitCode === null && mcp.signalCode === null) {
    note("mcp child STILL ALIVE — sending second tools/call to test respawn");
    const call2 = send("tools/call", {
      name: "unbrowse_health",
      arguments: {},
    }, 4);
    const r2 = await Promise.race([
      call2,
      sleep(45000).then(() => ({ timedOut: true })),
    ]);
    if (r2?.timedOut) note("SECOND CALL: timed out (no respawn?)");
    else if (r2?.msg) {
      const m = r2.msg;
      const isErr = !!m.error || m.result?.isError;
      note(`SECOND CALL id=${m.id} isError=${isErr}`);
      if (m.result?.content) {
        const text = m.result.content?.[0]?.text;
        note(`SECOND CALL content excerpt: ${(text || "").slice(0, 300).replace(/\n/g, " | ")}`);
      }
    }
  } else {
    note(`mcp child has exited (code=${mcp.exitCode} signal=${mcp.signalCode}) — no second call`);
  }

  // Wrap up
  try { mcp.stdin.end(); } catch {}
  await sleep(1000);
  if (mcp.exitCode === null) {
    note("force-killing mcp child for cleanup");
    try { mcp.kill("SIGTERM"); } catch {}
  }
  await sleep(500);
  note(`final mcp exit code=${mcp.exitCode} signal=${mcp.signalCode}`);
  log.end();
}

main().catch((e) => {
  note(`FATAL: ${e?.stack || e}`);
  try { mcp.kill("SIGKILL"); } catch {}
  log.end();
  process.exit(1);
});
