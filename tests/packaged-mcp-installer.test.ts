import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const tmpDirs: string[] = [];
const children: ChildProcess[] = [];

function cleanupChild(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

function cleanupBackgroundServer(homeDir: string, port: number): void {
  const pidFile = path.join(homeDir, ".unbrowse", "run", `server-127.0.0.1-${port}.json`);
  if (!existsSync(pidFile)) return;

  try {
    const state = JSON.parse(readFileSync(pidFile, "utf8")) as { pid?: number };
    if (state.pid) process.kill(state.pid, "SIGTERM");
  } catch {
    // ignore
  }
}

afterEach(() => {
  while (children.length > 0) {
    const child = children.pop();
    if (child) cleanupChild(child);
  }

  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("packaged MCP installer", () => {
  it("installs a working MCP command that answers initialize and health over stdio", async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-mcp-installer-"));
    tmpDirs.push(homeDir);

    execFileSync("./setup", [
      "--host",
      "mcp",
      "--no-start",
      "--accept-tos",
      "--agent-email",
      "agent@example.com",
      "--skip-wallet-setup",
      "--non-interactive",
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: path.join(homeDir, ".config"),
        UNBROWSE_BIN_DIR: path.join(homeDir, ".local", "bin"),
      },
      stdio: "ignore",
    });

    const configPath = path.join(homeDir, ".config", "unbrowse", "mcp", "unbrowse.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers?: {
        unbrowse?: {
          command: string;
          args?: string[];
        };
      };
    };

    const installed = config.mcpServers?.unbrowse;
    expect(installed?.command).toBeTruthy();
    expect(installed?.args).toEqual(["mcp"]);

    const port = 6979 + Math.floor(Math.random() * 100);
    const child = spawn(installed!.command, installed!.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: path.join(homeDir, ".config"),
        HOST: "127.0.0.1",
        PORT: String(port),
        UNBROWSE_URL: `http://localhost:${port}`,
        UNBROWSE_NON_INTERACTIVE: "1",
        UNBROWSE_TOS_ACCEPTED: "1",
      },
    });
    children.push(child);

    const responses = new Map<number, unknown>();
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === "number") responses.set(message.id, message);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const send = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "installer-proof", version: "1.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unbrowse_health", arguments: {} } });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (!responses.has(1) || !responses.has(2))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    cleanupChild(child);
    cleanupBackgroundServer(homeDir, port);

    const init = responses.get(1) as { result?: { protocolVersion?: string } } | undefined;
    const health = responses.get(2) as { result?: { content?: Array<{ text?: string }> } } | undefined;

    expect(init?.result?.protocolVersion).toBe("2025-11-25");
    expect(health?.result?.content?.[0]?.text).toContain("\"status\": \"ok\"");
    expect(stderr).toContain("starting stateless stdio MCP (in-process API, no daemon)");
  }, 45_000);
});
