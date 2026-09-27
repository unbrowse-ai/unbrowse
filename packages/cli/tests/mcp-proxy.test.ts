import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnbrowseError } from "@unbrowse/sdk";
import { createProxy, safeToolName } from "../src/mcp-proxy.ts";

const TOOLS = [
  { name: "unbrowse.scrape", description: "Read a page", inputSchema: { type: "object" as const, properties: { url: { type: "string" } } } },
  { name: "unbrowse.browse.open", inputSchema: { type: "object" as const } },
  { name: "news_ycombinator_com__read_page", inputSchema: { type: "object" as const } },
];

function fakeUpstream() {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  return {
    calls,
    upstream: async () => ({
      listTools: async () => TOOLS,
      rpc: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        if (params?.name === "unbrowse.boom") throw new UnbrowseError("Every cloud browser is busy", 200, "browser_capacity");
        if (method === "tools/call") return { content: [{ type: "text", text: `called ${String(params?.name)}` }] };
        return { echoed: method };
      },
    }),
  };
}

test("safeToolName keeps [A-Za-z0-9_-] and caps at 64", () => {
  expect(safeToolName("unbrowse.browse.open")).toBe("unbrowse_browse_open");
  expect(safeToolName("my__site-x.y")).toBe("my__site-x_y");
  expect(safeToolName("a".repeat(80)).length).toBe(64);
});

test("initialize answers locally and negotiates the protocol version", async () => {
  const handle = createProxy(fakeUpstream().upstream as never, "1.2.3");
  const r = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as { result: { protocolVersion: string; serverInfo: { version: string }; capabilities: object } };
  expect(r.result.protocolVersion).toBe("2025-06-18");
  expect(r.result.serverInfo.version).toBe("1.2.3");
  expect(r.result.capabilities).toHaveProperty("tools");
  const odd = (await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as { result: { protocolVersion: string } };
  expect(odd.result.protocolVersion).toBe("2025-11-25");
});

test("tools/list renames dotted tools; tools/call maps them back", async () => {
  const f = fakeUpstream();
  const handle = createProxy(f.upstream as never, "t");
  const list = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; description?: string }[] } };
  expect(list.result.tools.map((t) => t.name)).toEqual(["unbrowse_scrape", "unbrowse_browse_open", "news_ycombinator_com__read_page"]);
  expect(list.result.tools[0].description).toBe("Read a page");
  for (const t of list.result.tools) expect(t.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

  const call = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unbrowse_browse_open", arguments: { url: "https://x.test" } } })) as { result: { content: { text: string }[] } };
  expect(call.result.content[0].text).toBe("called unbrowse.browse.open");
  expect(f.calls.at(-1)).toEqual({ method: "tools/call", params: { name: "unbrowse.browse.open", arguments: { url: "https://x.test" } } });
});

test("a call before any tools/list still resolves the upstream name", async () => {
  const f = fakeUpstream();
  const handle = createProxy(f.upstream as never, "t");
  await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "unbrowse_scrape", arguments: {} } });
  expect(f.calls.at(-1)?.params?.name).toBe("unbrowse.scrape");
});

test("upstream errors become JSON-RPC errors with the server's code; notifications get no reply", async () => {
  const handle = createProxy(fakeUpstream().upstream as never, "t");
  const r = (await handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "unbrowse.boom" } })) as { error: { code: number; message: string; data: { code: string } } };
  expect(r.error).toMatchObject({ code: -32000, data: { code: "browser_capacity" } });
  expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
});

test("other methods are forwarded unchanged", async () => {
  const f = fakeUpstream();
  const handle = createProxy(f.upstream as never, "t");
  const r = (await handle({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} })) as { result: unknown };
  expect(r.result).toEqual({ echoed: "resources/list" });
});

test("`unbrowse mcp` speaks newline-delimited JSON-RPC over stdio against a real HTTP upstream", async () => {
  const seen: { auth: string | null; body: { method: string; params?: { name?: string } } }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string; params?: { name?: string } };
      seen.push({ auth: req.headers.get("authorization"), body });
      const result = body.method === "tools/list" ? { tools: TOOLS } : { content: [{ type: "text", text: `ok ${body.params?.name}` }] };
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const child = spawn("bun", [join(import.meta.dir, "../src/cli.ts"), "mcp", "--url", `http://127.0.0.1:${server.port}/api/mcp`], {
      env: { ...process.env, UNBROWSE_API_KEY: "ub_live_test", UNBROWSE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "ub-")) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += String(d);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) (lines.push(buf.slice(0, i)), (buf = buf.slice(i + 1)));
    });
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unbrowse_scrape", arguments: { url: "https://example.com" } } });
    const deadline = Date.now() + 10_000;
    while (lines.length < 3 && Date.now() < deadline) await Bun.sleep(25);
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
    const msgs = lines.map((l) => JSON.parse(l));
    expect(msgs.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(msgs[1].result.tools.map((t: { name: string }) => t.name)).toContain("unbrowse_browse_open");
    expect(msgs[2].result.content[0].text).toBe("ok unbrowse.scrape");
    expect(seen.every((s) => s.auth === "Bearer ub_live_test")).toBe(true);
  } finally {
    server.stop(true);
  }
});
