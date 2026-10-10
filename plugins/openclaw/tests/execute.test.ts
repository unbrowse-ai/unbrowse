import { describe, expect, test } from "bun:test";
import { register } from "../src/plugin.ts";
import { fakeApi, fakeMcp, rpcError, rpcResult, sseResult, tool } from "./helpers.ts";

const KEY = "ub_live_test_key";
const setup = (pluginConfig: Record<string, unknown> | undefined, reply: Parameters<typeof fakeMcp>[0], env: Record<string, string | undefined> = {}) => {
  const mcp = fakeMcp(reply);
  const f = fakeApi(pluginConfig);
  register(f.api, { fetch: mcp.fetch, env });
  return { ...f, calls: mcp.calls };
};

const scrapeResult = {
  content: [{ type: "text", text: '{"url":"https://example.com","markdown":"# Example Domain"}' }],
  structuredContent: { url: "https://example.com", finalUrl: "https://example.com/", via: "http", metadata: { title: "Example Domain", statusCode: 200 }, markdown: "# Example Domain" },
};

describe("execute → hosted MCP", () => {
  test("tools/call with the upstream name, bearer key, JSON-RPC body", async () => {
    const { tools, calls } = setup({ apiKey: KEY, mcpUrl: "https://mcp.test/api/mcp/" }, () => rpcResult(scrapeResult));
    const res = await tool(tools, "unbrowse_scrape").execute("call-1", { url: "https://example.com" });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://mcp.test/api/mcp");
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].headers["user-agent"]).toMatch(/^unbrowse-openclaw\//);
    expect(calls[0].body.method).toBe("tools/call");
    expect(calls[0].body.params).toEqual({ name: "unbrowse_scrape", arguments: { url: "https://example.com" } });
    expect(res.content).toEqual([{ type: "text", text: scrapeResult.content[0].text }]);
    expect(res.details).toEqual({ unbrowseTool: "unbrowse_scrape", structured: scrapeResult.structuredContent });
  });

  test("the served name goes upstream as is (unbrowse_browse_open); SSE responses parse", async () => {
    const { tools, calls } = setup({ apiKey: KEY }, () => sseResult({ content: [{ type: "text", text: "snapshot @e1" }] }));
    const res = await tool(tools, "unbrowse_browse_open").execute("c", { url: "https://news.ycombinator.com", task: "read" });
    expect(calls[0].body.params?.name).toBe("unbrowse_browse_open");
    expect(calls[0].url).toBe("https://unbrowse.ai/mcp");
    expect(res.content[0].text).toBe("snapshot @e1");
    expect(res.details).toEqual({ unbrowseTool: "unbrowse_browse_open" });
  });

  test("structured-only results become JSON text", async () => {
    const { tools } = setup({ apiKey: KEY }, () => rpcResult({ content: [], structuredContent: { balance: 5 } }));
    const res = await tool(tools, "unbrowse_credits").execute("c", {});
    expect(res.content[0].text).toBe('{"balance":5}');
  });

  test("env fallback: UNBROWSE_API_KEY, UNBROWSE_MCP_URL, UNBROWSE_END_USER", async () => {
    const { tools, calls } = setup(undefined, () => rpcResult(scrapeResult), { UNBROWSE_API_KEY: "ub_env", UNBROWSE_MCP_URL: "https://env.test/mcp", UNBROWSE_END_USER: "user-7" });
    await tool(tools, "unbrowse_discover").execute("c", { query: "x" });
    expect(calls[0].url).toBe("https://env.test/mcp");
    expect(calls[0].headers.authorization).toBe("Bearer ub_env");
    expect(calls[0].headers["x-unbrowse-end-user"]).toBe("user-7");
  });

  test("plugin config wins over env", async () => {
    const { tools, calls } = setup({ apiKey: KEY, endUser: "cfg-user", mcpUrl: "https://cfg.test/mcp" }, () => rpcResult(scrapeResult), { UNBROWSE_API_KEY: "ub_env", UNBROWSE_MCP_URL: "https://env.test/mcp", UNBROWSE_END_USER: "env-user" });
    await tool(tools, "unbrowse_discover").execute("c", { query: "x" });
    expect(calls[0].url).toBe("https://cfg.test/mcp");
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].headers["x-unbrowse-end-user"]).toBe("cfg-user");
  });

  test("no key anywhere: a clear error and no request", async () => {
    const { tools, calls } = setup(undefined, () => rpcResult(scrapeResult), {});
    await expect(tool(tools, "unbrowse_scrape").execute("c", { url: "https://example.com" })).rejects.toThrow(/UNBROWSE_API_KEY/);
    expect(calls.length).toBe(0);
  });

  test("abort: the signal reaches fetch; an already-aborted call never sends", async () => {
    const { tools, calls } = setup({ apiKey: KEY }, () => rpcResult(scrapeResult));
    const ac = new AbortController();
    await tool(tools, "unbrowse_scrape").execute("c", { url: "https://example.com" }, ac.signal);
    expect(calls[0].signal).toBe(ac.signal);
    ac.abort();
    await expect(tool(tools, "unbrowse_scrape").execute("c", { url: "https://example.com" }, ac.signal)).rejects.toThrow();
    expect(calls.length).toBe(1);
  });
});

describe("error mapping", () => {
  test("HTTP 401 → Unbrowse invalid_token with a fix", async () => {
    const { tools } = setup({ apiKey: "bad" }, () => new Response(JSON.stringify({ error: "invalid_token", error_description: "Token expired" }), { status: 401 }));
    const err = await tool(tools, "unbrowse_scrape").execute("c", { url: "https://example.com" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toStartWith("Unbrowse invalid_token: Token expired");
    expect(err.message).toContain("plugins.entries.unbrowse.config.apiKey");
    expect(err.code).toBe("invalid_token");
    expect(err.status).toBe(401);
    expect(err.message).not.toContain("bad");
  });

  test("RPC error with data.code browser_capacity → retry hint", async () => {
    const { tools } = setup({ apiKey: KEY }, () => rpcError(-32000, "All cloud browsers are busy", "browser_capacity"));
    const err = await tool(tools, "unbrowse_browse_open").execute("c", { url: "https://x.com" }).catch((e) => e);
    expect(err.message).toStartWith("Unbrowse browser_capacity: All cloud browsers are busy");
    expect(err.message).toContain("30 seconds");
    expect(err.code).toBe("browser_capacity");
  });

  test("RPC error without data.code → rpc_<code>", async () => {
    const { tools } = setup({ apiKey: KEY }, () => rpcError(-32602, "Unknown tool"));
    const err = await tool(tools, "unbrowse_run").execute("c", {}).catch((e) => e);
    expect(err.message).toBe("Unbrowse rpc_-32602: Unknown tool");
  });

  test("HTTP 500 with a plain body → http_error", async () => {
    const { tools } = setup({ apiKey: KEY }, () => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
    const err = await tool(tools, "unbrowse_run").execute("c", {}).catch((e) => e);
    expect(err.message).toBe("Unbrowse http_error: Internal Server Error");
  });

  test("isError tool results throw (OpenClaw: throw on failure) with the server's text", async () => {
    const { tools } = setup({ apiKey: KEY }, () => rpcResult({ isError: true, content: [{ type: "text", text: "url must be absolute" }] }));
    await expect(tool(tools, "unbrowse_scrape").execute("c", { url: "x" })).rejects.toThrow("Unbrowse unbrowse_scrape failed: url must be absolute");
  });

  test("network failure surfaces as an Error", async () => {
    const f = fakeApi({ apiKey: KEY });
    register(f.api, { fetch: (async () => { throw new TypeError("fetch failed"); }) as never, env: {} });
    await expect(tool(f.tools, "unbrowse_scrape").execute("c", { url: "https://example.com" })).rejects.toThrow("fetch failed");
  });
});
