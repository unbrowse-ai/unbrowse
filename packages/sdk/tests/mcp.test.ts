import { afterEach, expect, test } from "bun:test";
import { DEFAULT_MCP_URL, UnbrowseError, UnbrowseMcp, parseRpcBody, resultText } from "../src/index.ts";

type Sent = { url: string; headers: Headers; body: { id: number; method: string; params?: Record<string, unknown> } };

function stub(reply: (s: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const s = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
    sent.push(s);
    return reply(s);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const sse = (msg: unknown) => new Response(`id: 1\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`, { headers: { "content-type": "text/event-stream" } });

const saved = { key: process.env.UNBROWSE_API_KEY, url: process.env.UNBROWSE_MCP_URL, user: process.env.UNBROWSE_END_USER };
afterEach(() => {
  for (const [k, v] of [["UNBROWSE_API_KEY", saved.key], ["UNBROWSE_MCP_URL", saved.url], ["UNBROWSE_END_USER", saved.user]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("defaults to the hosted MCP, UNBROWSE_API_KEY and UNBROWSE_END_USER", async () => {
  delete process.env.UNBROWSE_MCP_URL;
  process.env.UNBROWSE_API_KEY = "ub_live_env";
  process.env.UNBROWSE_END_USER = "user-7";
  const { sent, fetch } = stub((s) => Response.json({ jsonrpc: "2.0", id: s.body.id, result: { tools: [] } }));
  const mcp = new UnbrowseMcp({ fetch, client: "test" });
  expect(mcp.url).toBe(DEFAULT_MCP_URL);
  await mcp.listTools();
  expect(sent[0].url).toBe("https://unbrowse.ai/mcp");
  expect(sent[0].headers.get("authorization")).toBe("Bearer ub_live_env");
  expect(sent[0].headers.get("x-unbrowse-end-user")).toBe("user-7");
  expect(sent[0].headers.get("accept")).toContain("text/event-stream");
  expect(sent[0].headers.get("user-agent")).toBe("unbrowse-test");
  expect(sent[0].headers.get("mcp-protocol-version")).toBe("2025-11-25");
  expect(sent[0].body).toMatchObject({ jsonrpc: "2.0", method: "tools/list" });
});

test("tools/list follows nextCursor", async () => {
  const { sent, fetch } = stub((s) =>
    sse({ jsonrpc: "2.0", id: s.body.id, result: s.body.params?.cursor ? { tools: [{ name: "b", inputSchema: { type: "object" } }] } : { tools: [{ name: "a", inputSchema: { type: "object" } }], nextCursor: "c1" } }),
  );
  const tools = await new UnbrowseMcp({ fetch, apiKey: "k" }).listTools();
  expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
  expect(sent[1].body.params).toEqual({ cursor: "c1" });
});

test("tools/call sends name + arguments and returns the result (SSE)", async () => {
  const { sent, fetch } = stub((s) => sse({ jsonrpc: "2.0", id: s.body.id, result: { content: [{ type: "text", text: "# Example" }] } }));
  const r = await new UnbrowseMcp({ fetch, apiKey: "k" }).callTool("unbrowse.scrape", { url: "https://example.com" });
  expect(sent[0].body).toMatchObject({ method: "tools/call", params: { name: "unbrowse.scrape", arguments: { url: "https://example.com" } } });
  expect(resultText(r)).toBe("# Example");
});

test("JSON-RPC errors carry the server's data.code", async () => {
  const { fetch } = stub((s) => sse({ jsonrpc: "2.0", id: s.body.id, error: { code: -32000, message: "Every cloud browser is busy", data: { code: "browser_capacity", details: { retryAfter: 30 } } } }));
  const err = await new UnbrowseMcp({ fetch, apiKey: "k" }).callTool("unbrowse.scrape", { url: "x" }).catch((e) => e);
  expect(err).toBeInstanceOf(UnbrowseError);
  expect(err.code).toBe("browser_capacity");
  expect(err.message).toContain("busy");
});

test("HTTP 401 becomes an UnbrowseError with the OAuth error code", async () => {
  const { fetch } = stub(() => Response.json({ error: "invalid_token", error_description: "Sign in to Unbrowse (OAuth) or send an Unbrowse API key." }, { status: 401 }));
  const err = await new UnbrowseMcp({ fetch }).listTools().catch((e) => e);
  expect(err).toMatchObject({ status: 401, code: "invalid_token" });
});

test("parseRpcBody takes the last SSE data event; resultText falls back to structuredContent", () => {
  expect(parseRpcBody('event: message\ndata: {"id":1,"result":1}\n\nevent: message\ndata: {"id":1,"result":2}\n\n')).toEqual({ id: 1, result: 2 } as never);
  expect(resultText({ content: [], structuredContent: { ok: true } })).toBe('{"ok":true}');
});
