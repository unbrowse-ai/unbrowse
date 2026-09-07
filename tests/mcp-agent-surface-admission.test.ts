import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { admitMcpToolCall } from "../src/mcp.js";

const ROOT = path.resolve(import.meta.dir, "..");
let children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  children = [];
});

type Rpc = { id?: number; result?: { tools?: Array<{ name: string }>; content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };

async function start(surface: "agent" | "full") {
  const child = spawn("bun", ["src/mcp.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      UNBROWSE_MCP_SURFACE: surface,
      UNBROWSE_NON_INTERACTIVE: "1",
      UNBROWSE_TELEMETRY: "0",
      UNBROWSE_NO_AUTO_START: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  const messages: Rpc[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try { messages.push(JSON.parse(line) as Rpc); } catch { /* ignore logs */ }
    }
  });
  child.stderr.on("data", () => {});

  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const wait = async (id: number, timeoutMs = 15_000): Promise<Rpc> => {
    const started = Date.now();
    for (;;) {
      const hit = messages.find((message) => message.id === id);
      if (hit) return hit;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { send, wait };
}

describe("MCP agent-surface invocation admission", () => {
  test("pure gate is fail-closed for operator tools and open for the six agent tools", () => {
    expect(admitMcpToolCall("unbrowse_build_publish", "agent").decision).toBe("deny");
    for (const name of [
      "unbrowse_breath_get",
      "unbrowse_breath_auth_capture",
      "unbrowse_breath_capture",
      "unbrowse_eval_feedback",
      "unbrowse_eval_status",
      "unbrowse_diagnose",
    ]) {
      expect(admitMcpToolCall(name, "agent").decision).toBe("allow");
    }
    expect(admitMcpToolCall("unbrowse_build_publish", "full").decision).toBe("allow");
  });

  test("a hidden operator tool cannot be called by name on the real agent transport", async () => {
    const { send, wait } = await start("agent");
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await wait(2);
    expect(listed.result?.tools?.some((tool) => tool.name === "unbrowse_build_publish")).toBe(false);

    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unbrowse_build_publish", arguments: {} } });
    const denied = await wait(3);
    const text = denied.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
    expect(denied.result?.isError).toBe(true);
    expect(text).toContain("tool_not_available_on_agent_surface");
  }, 30_000);

  test("full/operator mode passes the same call through to normal argument validation", async () => {
    const { send, wait } = await start("full");
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unbrowse_build_publish", arguments: {} } });
    const response = await wait(2);
    const text = response.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
    expect(text).not.toContain("tool_not_available_on_agent_surface");
    expect(text).toContain("Invalid arguments");
  }, 30_000);
});
