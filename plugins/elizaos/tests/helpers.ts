// Test doubles: a fake hosted MCP (JSON-RPC over fetch) and a minimal elizaOS runtime.
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

export type RpcCall = { url: string; headers: Record<string, string>; method: string; name?: string; args?: Record<string, unknown> };
export type ToolReply =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
  | { http: number; body: unknown };
export type ToolHandler = (args: Record<string, unknown>, call: RpcCall) => ToolReply | Promise<ToolReply>;

export const toolResult = (structured: unknown, isError = false) => ({
  result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError },
});

/** A fetch that answers tools/call and tools/list like the hosted MCP. `sse` answers as an event stream. */
export function fakeMcp(tools: Record<string, ToolHandler>, opts: { sse?: boolean; toolList?: { name: string }[] } = {}) {
  const calls: RpcCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: RpcCall = { url: String(input), headers, method: body.method, name: body.params?.name, args: body.params?.arguments };
    calls.push(call);
    let reply: ToolReply;
    if (body.method === "tools/list") reply = { result: { tools: opts.toolList ?? Object.keys(tools).map((name) => ({ name, inputSchema: { type: "object" } })) } };
    else if (body.method === "tools/call" && tools[call.name!]) reply = await tools[call.name!](call.args ?? {}, call);
    else reply = { error: { code: -32601, message: `unknown tool ${call.name}`, data: { code: "unknown_tool" } } };
    if ("http" in reply) return new Response(JSON.stringify(reply.body), { status: reply.http, headers: { "content-type": "application/json" } });
    const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, ...reply });
    return opts.sse
      ? new Response(`event: message\ndata: ${msg}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(msg, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, toolCalls: () => calls.filter((c) => c.method === "tools/call") };
}

export const ROOM = "00000000-0000-0000-0000-00000000a001" as UUID;

export function mockRuntime(settings: Record<string, string | undefined>, fetch?: typeof globalThis.fetch): IAgentRuntime {
  const character = { name: "Tester", bio: "test", settings: {}, secrets: {} };
  return {
    agentId: "00000000-0000-0000-0000-0000000000a9",
    character,
    fetch,
    getSetting: (key: string) => settings[key] ?? null,
  } as unknown as IAgentRuntime;
}

export function msg(text: string, roomId: UUID = ROOM): Memory {
  return {
    id: "00000000-0000-0000-0000-00000000b001" as UUID,
    entityId: "00000000-0000-0000-0000-00000000c001" as UUID,
    roomId,
    content: { text },
  } as Memory;
}

/** A callback that records what the action sent to the chat. */
export function recorder() {
  const sent: { text?: string; actions?: string[]; source?: string }[] = [];
  const callback = async (content: { text?: string; actions?: string[]; source?: string }) => {
    sent.push(content);
    return [];
  };
  return { sent, callback };
}

export const KEY = "ub_live_TESTKEY_never_printed";
