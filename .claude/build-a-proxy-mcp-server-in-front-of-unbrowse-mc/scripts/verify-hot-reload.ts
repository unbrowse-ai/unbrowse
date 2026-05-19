#!/usr/bin/env bun
//
// Hot-reload round-trip verifier for scripts/mcp-hot-proxy.ts.
//
// Contract (cited from references/DESIGN.md):
//   1. Spawn the proxy (child = bun src/mcp.ts).
//   2. Send initialize + tools/list. Record server-tool count.
//   3. Edit src/mcp.ts to inject a sentinel token in a tool description.
//   4. Wait up to 8s for the watcher debounce + child restart + re-initialize.
//   5. Send tools/list again on the SAME stdio connection.
//   6. Assert the sentinel is present in the new tools/list response.
//   7. Revert the edit.
//   8. Exit 0 on success, 1 on failure. Print evidence either way.
//
// Real-runtime: spawns the real proxy, talks to a real child unbrowse MCP,
// writes a real file edit. No mocks. The whole point of the gate.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { promises as fs } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PROXY_PATH = path.join(REPO_ROOT, "scripts", "mcp-hot-proxy.ts");
const TARGET_FILE = path.join(REPO_ROOT, "src", "mcp.ts");
const SENTINEL = `PROXY-RELOAD-OK-${Date.now()}`;
const INIT_WAIT_MS = 8_000;
const RELOAD_WAIT_MS = 12_000;

type JsonRpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

function log(msg: string): void {
  process.stderr.write(`[verify-hot-reload] ${msg}\n`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readUntil(reader: Interface, predicate: (msg: JsonRpc) => boolean, timeoutMs: number): Promise<JsonRpc | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      reader.off("line", onLine);
      resolve(null);
    }, timeoutMs);
    const onLine = (line: string): void => {
      let msg: JsonRpc;
      try { msg = JSON.parse(line) as JsonRpc; } catch { return; }
      if (predicate(msg)) {
        clearTimeout(t);
        reader.off("line", onLine);
        resolve(msg);
      }
    };
    reader.on("line", onLine);
  });
}

function send(child: ChildProcess, msg: JsonRpc): void {
  child.stdin!.write(`${JSON.stringify(msg)}\n`);
}

async function main(): Promise<number> {
  log(`spawning proxy: bun ${PROXY_PATH}`);
  const proxy = spawn("bun", [PROXY_PATH], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, UNBROWSE_PROXY_SILENT: process.env.VERIFY_VERBOSE === "1" ? "0" : "1" },
  });
  proxy.stderr!.on("data", (b) => {
    if (process.env.VERIFY_VERBOSE === "1") process.stderr.write(b);
  });
  proxy.on("exit", (code) => log(`proxy exited code=${code}`));

  const reader = createInterface({ input: proxy.stdout!, crlfDelay: Infinity });

  let exitCode = 1;
  let originalSrc: string | null = null;

  try {
    // Step 1: initialize.
    log("sending initialize");
    send(proxy, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "verify-hot-reload", version: "0.1.0" },
      },
    });
    const initResp = await readUntil(reader, (m) => m.id === 1, INIT_WAIT_MS);
    if (!initResp || initResp.error) {
      log(`initialize FAILED: ${JSON.stringify(initResp)}`);
      return 1;
    }
    log("initialize OK");

    // notifications/initialized (no response expected).
    send(proxy, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    // Step 2: first tools/list.
    log("requesting tools/list (pre-edit)");
    send(proxy, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list1 = await readUntil(reader, (m) => m.id === 2, INIT_WAIT_MS);
    if (!list1 || !list1.result) {
      log(`tools/list (pre) FAILED: ${JSON.stringify(list1)}`);
      return 1;
    }
    const tools1 = (list1.result as { tools?: Array<{ name: string; description?: string }> }).tools ?? [];
    log(`pre-edit: ${tools1.length} tools listed`);
    if (tools1.length === 0) {
      log("FAILED: zero tools in pre-edit list (proxy likely failed to start child)");
      return 1;
    }
    const target = tools1.find((t) => t.name === "unbrowse_health") ?? tools1[0];
    log(`target tool: ${target.name} (desc length: ${target.description?.length ?? 0})`);
    if ((target.description ?? "").includes(SENTINEL)) {
      log("FAILED: sentinel already present in pre-edit description (state bleed)");
      return 1;
    }

    // Step 3: edit src/mcp.ts to inject sentinel.
    log(`editing ${TARGET_FILE} to inject sentinel "${SENTINEL}"`);
    originalSrc = await fs.readFile(TARGET_FILE, "utf-8");
    // Find a tool registration with `name: "unbrowse_health"` or fallback to
    // any `description:` line we can extend. Simple approach: append a marker
    // comment to the file (changes mtime, triggers watcher) AND mutate one
    // description string. The comment alone might suffice if we cannot match,
    // but a description mutation is the falsifiable signal we want.
    const targetName = target.name;
    const descPattern = new RegExp(`(name:\\s*"${targetName}"[\\s\\S]{0,400}?description:\\s*")([^"]*)"`);
    let modified = originalSrc;
    if (descPattern.test(originalSrc)) {
      modified = originalSrc.replace(descPattern, (_m, head, body) => `${head}${body} [${SENTINEL}]"`);
      log(`pattern matched; mutated description for ${targetName}`);
    } else {
      log(`pattern did NOT match for ${targetName}; appending mtime-bumping comment only (less strict assertion)`);
      modified = `${originalSrc}\n// ${SENTINEL}\n`;
    }
    await fs.writeFile(TARGET_FILE, modified, "utf-8");

    // Step 4: wait for watcher debounce + child restart + initialize-replay.
    log(`waiting up to ${RELOAD_WAIT_MS}ms for proxy hot-reload`);
    await sleep(RELOAD_WAIT_MS);

    // Step 5: tools/list again.
    log("requesting tools/list (post-edit)");
    send(proxy, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const list2 = await readUntil(reader, (m) => m.id === 3, INIT_WAIT_MS);
    if (!list2 || !list2.result) {
      log(`tools/list (post) FAILED: ${JSON.stringify(list2)}`);
      return 1;
    }
    const tools2 = (list2.result as { tools?: Array<{ name: string; description?: string }> }).tools ?? [];
    log(`post-edit: ${tools2.length} tools listed`);
    const targetAfter = tools2.find((t) => t.name === targetName);
    if (!targetAfter) {
      log(`FAILED: target tool ${targetName} missing from post-edit list`);
      return 1;
    }
    const descAfter = targetAfter.description ?? "";
    const sawSentinel = descAfter.includes(SENTINEL);
    if (sawSentinel) {
      log(`PASS: sentinel "${SENTINEL}" present in post-edit ${targetName}.description`);
      log(`  description (truncated): ${descAfter.substring(0, 200)}`);
      exitCode = 0;
    } else {
      log(`FAIL: sentinel "${SENTINEL}" NOT in post-edit ${targetName}.description`);
      log(`  description (truncated): ${descAfter.substring(0, 200)}`);
      // If we fell back to append-comment mode, the description won't change.
      // In that case, exit 1 — the verify gate requires a falsifiable signal.
      exitCode = 1;
    }
  } catch (err) {
    log(`exception: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    // Revert the edit.
    if (originalSrc != null) {
      try {
        await fs.writeFile(TARGET_FILE, originalSrc, "utf-8");
        log(`reverted ${TARGET_FILE}`);
      } catch (err) {
        log(`WARN: failed to revert ${TARGET_FILE}: ${err}`);
      }
    }
    // Kill the proxy.
    try {
      proxy.kill("SIGTERM");
      await sleep(500);
      if (!proxy.killed) proxy.kill("SIGKILL");
    } catch { /* already gone */ }
  }
  return exitCode;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`[verify-hot-reload] fatal: ${err}\n`);
  process.exit(1);
});
