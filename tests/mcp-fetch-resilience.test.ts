import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

// Day 4 (Luminaries) Worker C — Phase 0c failing lights.
//
// Contract (Phase 0c):
//   When a tool handler throws (synchronously or via uncaughtException), the
//   MCP stdio server emits a JSON-RPC error envelope with code -32603 and
//   the inbound request id, then stays alive. Subsequent `tools/list` and
//   `unbrowse_health` calls succeed on the same stdio session. No call ever
//   takes down the broker.
//
// These tests will FAIL today because:
//   (a) The env-var-gated `unbrowse_test_crash` tool does not exist yet —
//       Day 5 will register it under `UNBROWSE_TEST_CRASH=1` with a handler
//       that throws synchronously.
//   (b) The resilience seed at src/mcp.ts:2419 only logs to stderr; it does
//       not yet emit a JSON-RPC error envelope.

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
  const body = JSON.parse(result.stdout.trim() || "{}") as { status?: string };
  expect(body.status).toBe("ok");
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

async function nextMessageMatching(
  rl: Interface,
  child: ChildProcessWithoutNullStreams,
  predicate: (msg: any) => boolean,
  timeoutMs: number,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const onLine = (line: string) => {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!predicate(parsed)) return;
      cleanup();
      resolve(parsed);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`mcp exited early code=${code} signal=${signal}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for matching mcp response`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      rl.off("line", onLine);
      child.off("exit", onExit);
    };
    rl.on("line", onLine);
    child.once("exit", onExit);
  });
}

async function initialize(child: ChildProcessWithoutNullStreams, rl: Interface): Promise<void> {
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "bun-test", version: "1.0.0" },
    },
  })}\n`);
  await nextMessageMatching(rl, child, (m) => m.id === 1, 10_000);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
}

function buildEnv(port: number, runDir: string): Record<string, string> {
  return {
    UNBROWSE_URL: `http://127.0.0.1:${port}`,
    UNBROWSE_RUN_DIR: runDir,
    UNBROWSE_DISABLE_AUTO_UPDATE: "1",
    UNBROWSE_NON_INTERACTIVE: "1",
    UNBROWSE_TOS_ACCEPTED: "1",
    UNBROWSE_TEST_CRASH: "1",
  };
}

afterAll(() => {
  for (const dir of runDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP stdio resilience (Phase 0c)", () => {
  it("triggering uncaughtException in a handler emits JSON-RPC error envelope code -32603", async () => {
    const port = await getFreePort();
    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-mcp-resil-"));
    runDirs.push(runDir);
    const env = buildEnv(port, runDir);
    await startLocalServer(env);
    const { child, rl } = spawnMcp(env);

    try {
      await initialize(child, rl);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "unbrowse_test_crash", arguments: {} },
      })}\n`);
      const response = await nextMessageMatching(rl, child, (m) => m.id === 7, 10_000);
      expect(response.jsonrpc).toBe("2.0");
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32603);
      expect(typeof response.error.message).toBe("string");
    } finally {
      rl.close();
      child.stdin.end();
      child.kill("SIGTERM");
      await stopLocalServer(env);
    }
  }, 30_000);

  it("error envelope id matches request id of crashing call, not null", async () => {
    const port = await getFreePort();
    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-mcp-resil-"));
    runDirs.push(runDir);
    const env = buildEnv(port, runDir);
    await startLocalServer(env);
    const { child, rl } = spawnMcp(env);

    try {
      await initialize(child, rl);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "abc-123",
        method: "tools/call",
        params: { name: "unbrowse_test_crash", arguments: {} },
      })}\n`);
      const response = await nextMessageMatching(rl, child, (m) => m.id === "abc-123", 10_000);
      expect(response.id).toBe("abc-123");
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32603);
    } finally {
      rl.close();
      child.stdin.end();
      child.kill("SIGTERM");
      await stopLocalServer(env);
    }
  }, 30_000);

  it("subsequent tools/list succeeds after crash (pipe survives)", async () => {
    const port = await getFreePort();
    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-mcp-resil-"));
    runDirs.push(runDir);
    const env = buildEnv(port, runDir);
    await startLocalServer(env);
    const { child, rl } = spawnMcp(env);

    try {
      await initialize(child, rl);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "unbrowse_test_crash", arguments: {} },
      })}\n`);
      await nextMessageMatching(rl, child, (m) => m.id === 7, 10_000);

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} })}\n`);
      const listed = await nextMessageMatching(rl, child, (m) => m.id === 8, 10_000);
      expect(listed.id).toBe(8);
      expect(listed.error).toBeUndefined();
      expect(Array.isArray(listed.result.tools)).toBe(true);
      expect(listed.result.tools.length).toBeGreaterThan(20);
    } finally {
      rl.close();
      child.stdin.end();
      child.kill("SIGTERM");
      await stopLocalServer(env);
    }
  }, 30_000);

  it("subsequent unbrowse_health call returns status:\"ok\" after crash", async () => {
    const port = await getFreePort();
    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-mcp-resil-"));
    runDirs.push(runDir);
    const env = buildEnv(port, runDir);
    await startLocalServer(env);
    const { child, rl } = spawnMcp(env);

    try {
      await initialize(child, rl);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "unbrowse_test_crash", arguments: {} },
      })}\n`);
      await nextMessageMatching(rl, child, (m) => m.id === 7, 10_000);

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "unbrowse_health", arguments: {} },
      })}\n`);
      const health = await nextMessageMatching(rl, child, (m) => m.id === 9, 10_000);
      expect(health.id).toBe(9);
      expect(health.error).toBeUndefined();
      const status = health.result?.structuredContent?.status
        ?? health.result?.status
        ?? (() => {
          const text = health.result?.content?.[0]?.text;
          if (typeof text === "string") {
            try { return JSON.parse(text).status; } catch { return undefined; }
          }
          return undefined;
        })();
      expect(status).toBe("ok");
    } finally {
      rl.close();
      child.stdin.end();
      child.kill("SIGTERM");
      await stopLocalServer(env);
    }
  }, 30_000);
});
