/**
 * Agent MCP surface (default): few tools so hosts don't dump a 60-tool menu.
 * Full catalog remains available via UNBROWSE_MCP_SURFACE=full.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleRequest, mcpSurfaceMode } from "../src/mcp.js";
import { AGENT_PATH, DEFAULT_AGENT_MCP_TOOLS } from "../src/agent-path.js";

type Frame = { jsonrpc: "2.0" } & Record<string, unknown>;
let captured: Frame[] = [];
let origWrite: typeof process.stdout.write;
const prevSurface = process.env.UNBROWSE_MCP_SURFACE;

beforeEach(() => {
  captured = [];
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        captured.push(JSON.parse(trimmed));
      } catch {
        /* not JSON */
      }
    }
    return true;
  }) as any;
});

afterEach(() => {
  (process.stdout as any).write = origWrite;
  if (prevSurface === undefined) delete process.env.UNBROWSE_MCP_SURFACE;
  else process.env.UNBROWSE_MCP_SURFACE = prevSurface;
});

async function call(method: string, params?: Record<string, unknown>): Promise<Frame> {
  captured = [];
  await handleRequest({ jsonrpc: "2.0", id: 1, method, params } as any);
  const reply = captured.find((f) => f.id === 1);
  if (!reply) throw new Error(`no reply for ${method}`);
  return reply;
}

describe("UNBROWSE_MCP_SURFACE agent default", () => {
  test("mcpSurfaceMode defaults to agent", () => {
    delete process.env.UNBROWSE_MCP_SURFACE;
    expect(mcpSurfaceMode()).toBe("agent");
  });

  test("agent surface lists only the core agent tools", async () => {
    process.env.UNBROWSE_MCP_SURFACE = "agent";
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0" },
    });
    const r = await call("tools/list");
    const tools = (r.result as { tools: Array<{ name: string; description: string }> }).tools;
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("unbrowse_breath_get")).toBe(true);
    expect(names.has("unbrowse_breath_auth_capture")).toBe(true);
    expect(names.has("unbrowse_breath_capture")).toBe(true);
    expect(names.has("unbrowse_eval_feedback")).toBe(true);
    // Power tools hidden from default agent menu
    expect(names.has("unbrowse_eval_resolve")).toBe(false);
    expect(names.has("unbrowse_breath_navigate")).toBe(false);
    expect(names.has("unbrowse_breath_click")).toBe(false);
    expect([...names].sort()).toEqual([...DEFAULT_AGENT_MCP_TOOLS].sort());
    expect(tools.find((tool) => tool.name === "unbrowse_breath_get")?.description).toContain(AGENT_PATH.mcp.primary);
    expect(tools.find((tool) => tool.name === "unbrowse_breath_get")?.description).toContain("next_step once");
  });

  test("full surface restores a large catalog", async () => {
    process.env.UNBROWSE_MCP_SURFACE = "full";
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0" },
    });
    const r = await call("tools/list");
    const tools = (r.result as { tools: Array<{ name: string }> }).tools;
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("unbrowse_breath_get")).toBe(true);
    expect(names.has("unbrowse_eval_resolve")).toBe(true);
    expect(names.has("unbrowse_breath_navigate")).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(20);
  });
});
