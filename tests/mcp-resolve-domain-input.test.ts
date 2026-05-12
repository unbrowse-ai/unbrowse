// Day 4 (Luminaries) failing test for AC2 — substrate-lie at unbrowse_resolve schema.
// FAILS today (domain advertised but degrades to 'root'). Day 6 removes the field;
// this test flips green.
//
// Background: src/orchestrator/index.ts:3446,3669-3672 shows that the `domain`
// argument advertised on unbrowse_resolve.inputSchema.properties has no real
// effect — it silently degrades to a "root" cache key. Advertising the field
// is a substrate-lie. AC2 (option b) is to remove it from the schema.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleRequest } from "../src/mcp.js";

type Frame = { jsonrpc: "2.0" } & Record<string, unknown>;
let captured: Frame[] = [];
let origWrite: typeof process.stdout.write;

beforeEach(() => {
  captured = [];
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try { captured.push(JSON.parse(trimmed)); } catch { /* not JSON */ }
    }
    return true;
  }) as any;
});

afterEach(() => {
  (process.stdout as any).write = origWrite;
});

async function call(method: string, params?: Record<string, unknown>): Promise<Frame> {
  captured = [];
  await handleRequest({ jsonrpc: "2.0", id: 1, method, params } as any);
  const reply = captured.find((f) => f.id === 1);
  if (!reply) throw new Error(`no reply for ${method}; captured=${JSON.stringify(captured)}`);
  return reply;
}

describe("unbrowse_resolve inputSchema — no substrate-lie (AC2)", () => {
  test("inputSchema.properties does NOT advertise `domain`", async () => {
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0" },
    });
    const r = await call("tools/list");
    const tools = (r.result as any).tools as Array<{ name: string; inputSchema?: any }>;
    const resolve = tools.find((t) => t.name === "unbrowse_resolve");
    expect(resolve, "unbrowse_resolve must be in tools/list").toBeDefined();
    const properties = resolve!.inputSchema?.properties ?? {};
    expect(
      Object.prototype.hasOwnProperty.call(properties, "domain"),
      "unbrowse_resolve.inputSchema.properties.domain must NOT be advertised — it silently degrades to 'root' cache key (src/orchestrator/index.ts:3446,3669-3672). Substrate-lie per AC2.",
    ).toBe(false);
  });
});
