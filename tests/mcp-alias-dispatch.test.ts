import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

// Day 5 (Luminaries) — Phase 0a alias dispatch contract.
//
// Contract:
//   `unbrowse_run` is a deprecated alias for `unbrowse_resolve`. Calling it
//   over MCP stdio dispatches to the resolve handler, returns the resolve
//   body verbatim, and tags the envelope with `deprecated: true` and
//   `renamed_to: "unbrowse_resolve"`. Removed tool names like
//   `unbrowse_fetch` return a structured JSON-RPC result envelope that
//   carries an `error` field and `renamed_to` pointer; the call never
//   crashes the stdio loop and the request id is echoed.
//
// These tests FAIL on Phase 0a's seed (src/mcp.ts:2168, :2199 both return
// errorResult with no renamed_to merge). They PASS once the alias handler
// delegates to toolMap.get("unbrowse_resolve").handler and merges
// { deprecated: true, renamed_to: "unbrowse_resolve" } into the result.

const ROOT = join(import.meta.dir, "..");
const runDirs: string[] = [];

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const { port } = address;
      server.close((err) => err ? reject(err) : resolve(port));
    });
    server.on("error", reject);
  });
}

async function runProcess(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) {
        reject(new Error(`process exited via signal ${signal}\nstderr:\n${stderr}`));
        return;
      }
      resolve(exitCode ?? 1);
    });
  });
  return { code, stdout, stderr };
}

async function startLocalServer(env: Record<string, string>): Promise<void> {
  const result = await runProcess(["src/cli.ts", "health"], env);
  if (result.code !== 0) {
    throw new Error(`health failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

async function stopLocalServer(env: Record<string, string>): Promise<void> {
  await runProcess(["src/cli.ts", "stop"], env);
}

function spawnMcp(env: Record<string, string>): { child: ChildProcessWithoutNullStreams; rl: Interface } {
  const child = spawn(process.execPath, ["src/cli.ts", "mcp", "--no-auto-start"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return { child, rl };
}

function readMessage(rl: Interface, child: ChildProcessWithoutNullStreams, wantId: number | string): Promise<any> {
  return new Promise((resolve, reject) => {
    const onLine = (line: string) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (msg && msg.id === wantId) {
        cleanup();
        resolve(msg);
      }
      // Skip notifications and other messages until we find the one we want.
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`mcp exited early code=${code} signal=${signal}`));
    };
    const cleanup = () => {
      rl.off("line", onLine);
      child.off("exit", onExit);
    };
    rl.on("line", onLine);
    child.once("exit", onExit);
  });
}

let envShared: Record<string, string>;
let mcpChild: ChildProcessWithoutNullStreams;
let mcpRl: Interface;
let runResponse: any;
let resolveResponse: any;
let fetchResponse: any;
let fetchResponseId42: any;

beforeAll(async () => {
  const port = await getFreePort();
  const runDir = mkdtempSync(join(tmpdir(), "unbrowse-alias-"));
  runDirs.push(runDir);

  envShared = {
    UNBROWSE_URL: `http://127.0.0.1:${port}`,
    UNBROWSE_RUN_DIR: runDir,
    UNBROWSE_DISABLE_AUTO_UPDATE: "1",
    UNBROWSE_NON_INTERACTIVE: "1",
    UNBROWSE_TOS_ACCEPTED: "1",
  };

  await startLocalServer(envShared);

  const spawned = spawnMcp(envShared);
  mcpChild = spawned.child;
  mcpRl = spawned.rl;

  // Initialize handshake.
  mcpChild.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "bun-test-alias", version: "1.0.0" },
    },
  })}\n`);
  await readMessage(mcpRl, mcpChild, 1);

  mcpChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  // Fire all four tool calls in sequence.
  mcpChild.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "unbrowse_run", arguments: { intent: "trending stories" } },
  })}\n`);
  runResponse = await readMessage(mcpRl, mcpChild, 10);

  mcpChild.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "unbrowse_resolve", arguments: { intent: "trending stories" } },
  })}\n`);
  resolveResponse = await readMessage(mcpRl, mcpChild, 11);

  mcpChild.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: { name: "unbrowse_fetch", arguments: { url: "https://www.carousell.sg/search/shoes" } },
  })}\n`);
  fetchResponse = await readMessage(mcpRl, mcpChild, 20);

  mcpChild.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name: "unbrowse_fetch", arguments: { url: "https://www.carousell.sg/search/shoes" } },
  })}\n`);
  fetchResponseId42 = await readMessage(mcpRl, mcpChild, 42);
}, 60_000);

afterAll(async () => {
  try {
    mcpRl?.close();
    mcpChild?.stdin.end();
    mcpChild?.kill("SIGTERM");
  } catch {}
  try {
    await stopLocalServer(envShared);
  } catch {}
  for (const dir of runDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP alias dispatch (Phase 0a)", () => {
  it("unbrowse_run dispatches to unbrowse_resolve handler and result carries deprecated:true + renamed_to:\"unbrowse_resolve\"", () => {
    // The response must be a JSON-RPC result envelope (not error envelope).
    expect(runResponse.error).toBeUndefined();
    expect(runResponse.result).toBeDefined();
    // The tool result must NOT be tagged as a tool error.
    expect(runResponse.result.isError).toBeUndefined();
    const sc = runResponse.result.structuredContent;
    expect(sc).toBeDefined();
    expect(sc.deprecated).toBe(true);
    expect(sc.renamed_to).toBe("unbrowse_resolve");
  });

  it("unbrowse_run result body matches unbrowse_resolve result body for same args", () => {
    expect(runResponse.result).toBeDefined();
    expect(resolveResponse.result).toBeDefined();

    const runSc = { ...(runResponse.result.structuredContent ?? {}) };
    const resolveSc = { ...(resolveResponse.result.structuredContent ?? {}) };
    delete runSc.deprecated;
    delete runSc.renamed_to;

    const runKeys = Object.keys(runSc).sort();
    const resolveKeys = Object.keys(resolveSc).sort();
    expect(runKeys).toEqual(resolveKeys);
  });

  it("unbrowse_fetch returns a JSON-RPC result envelope (not process death) with renamed_to pointer", () => {
    // The response must be a JSON-RPC result (server stays alive, pipe open).
    expect(fetchResponse.error).toBeUndefined();
    expect(fetchResponse.result).toBeDefined();
    const sc = fetchResponse.result.structuredContent;
    expect(sc).toBeDefined();
    // Content must surface an error message and the renamed-to replacement.
    expect(typeof sc.error).toBe("string");
    expect(sc.renamed_to).toBe("unbrowse_resolve");
  });

  it("unbrowse_fetch error envelope id matches the in-flight request id", () => {
    expect(fetchResponseId42.id).toBe(42);
    expect(fetchResponseId42.result).toBeDefined();
    // The same renamed-to invariant must hold on the id=42 call.
    expect(fetchResponseId42.result.structuredContent?.renamed_to).toBe("unbrowse_resolve");
  });
});
