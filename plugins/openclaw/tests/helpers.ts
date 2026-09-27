import type { BeforeToolCallEvent, BeforeToolCallResult, HostTool, PluginApi, WebFetchProvider } from "../src/host-types.ts";

export type Captured = { url: string; headers: Record<string, string>; body: { jsonrpc: string; id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }; signal?: AbortSignal | null };

/** A fake hosted MCP: records each request and answers with `reply(body)`. */
export function fakeMcp(reply: (body: Captured["body"]) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), headers, body, signal: init?.signal });
    return reply(body);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const rpcResult = (result: unknown, id = 1) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
export const sseResult = (result: unknown, id = 1) =>
  new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } });
export const rpcError = (code: number, message: string, dataCode?: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message, ...(dataCode ? { data: { code: dataCode } } : {}) } }), { headers: { "content-type": "application/json" } });

/** A fake OpenClaw plugin API that records registrations. */
export function fakeApi(pluginConfig?: Record<string, unknown>) {
  const tools: HostTool[] = [];
  const providers: WebFetchProvider[] = [];
  const hooks: Record<string, ((e: BeforeToolCallEvent, ctx: unknown) => BeforeToolCallResult | Promise<BeforeToolCallResult>)[]> = {};
  const api: PluginApi = {
    id: "unbrowse",
    pluginConfig,
    registerTool: (t) => void tools.push(t),
    registerWebFetchProvider: (p) => void providers.push(p),
    on: (name, handler) => void (hooks[name] ??= []).push(handler),
  };
  return { api, tools, providers, hooks };
}

export const tool = (tools: HostTool[], name: string): HostTool => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
