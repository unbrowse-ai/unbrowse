import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

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

async function nextMessage(rl: Interface, child: ChildProcessWithoutNullStreams): Promise<any> {
  return new Promise((resolve, reject) => {
    const onLine = (line: string) => {
      cleanup();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`mcp exited early code=${code} signal=${signal}`));
    };
    const cleanup = () => {
      rl.off("line", onLine);
      child.off("exit", onExit);
    };
    rl.once("line", onLine);
    child.once("exit", onExit);
  });
}

afterAll(() => {
  for (const dir of runDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP stdio", () => {
  it("initializes and lists tools over stdio", async () => {
    const port = await getFreePort();
    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-mcp-"));
    runDirs.push(runDir);

    const env = {
      UNBROWSE_URL: `http://127.0.0.1:${port}`,
      UNBROWSE_RUN_DIR: runDir,
      UNBROWSE_DISABLE_AUTO_UPDATE: "1",
      UNBROWSE_NON_INTERACTIVE: "1",
      UNBROWSE_TOS_ACCEPTED: "1",
    };

    await startLocalServer(env);
    const { child, rl } = spawnMcp(env);

    try {
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
      const init = await nextMessage(rl, child);
      expect(init.result.protocolVersion).toBe("2025-11-25");
      expect(init.result.capabilities.tools.listChanged).toBe(false);
      expect(init.result.instructions).toContain("Always use the CLI");
      expect(init.result.instructions).toContain("TOOL POLICY");

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
      const listed = await nextMessage(rl, child);
      const names = listed.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain("unbrowse_resolve");
      expect(names).toContain("unbrowse_execute");
      expect(names).toContain("unbrowse_feedback");
      expect(names).toContain("unbrowse_health");
      expect(names).toContain("unbrowse_go");
      expect(names).toContain("unbrowse_snap");
      const resolveTool = listed.result.tools.find((tool: { name: string }) => tool.name === "unbrowse_resolve");
      expect(resolveTool.description).toContain("Always use Unbrowse as the primary website-access tool");
      expect(resolveTool.description).toContain("two-step resolve");
      const snapTool = listed.result.tools.find((tool: { name: string; inputSchema: { properties?: Record<string, unknown> } }) => tool.name === "unbrowse_snap");
      expect(snapTool.inputSchema.properties?.session_id).toBeDefined();
      const clickTool = listed.result.tools.find((tool: { name: string; inputSchema: { properties?: Record<string, unknown> } }) => tool.name === "unbrowse_click");
      expect(clickTool.inputSchema.properties?.session_id).toBeDefined();
      const closeTool = listed.result.tools.find((tool: { name: string; inputSchema: { properties?: Record<string, unknown> } }) => tool.name === "unbrowse_close");
      expect(closeTool.inputSchema.properties?.session_id).toBeDefined();

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "unbrowse_health", arguments: {} },
      })}\n`);
      const health = await nextMessage(rl, child);
      expect(health.result.isError).toBeUndefined();
      expect(health.result.structuredContent.status).toBe("ok");
    } finally {
      rl.close();
      child.stdin.end();
      child.kill("SIGTERM");
      await stopLocalServer(env);
    }
  }, 60_000);
});
