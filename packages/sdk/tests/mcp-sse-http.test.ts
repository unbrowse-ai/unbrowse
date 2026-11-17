import { expect, test } from "bun:test";
import { UnbrowseMcp } from "../src/index.ts";

// SSE permits CRLF, LF and CR line endings, including a mix within one stream.
// Exercise the real HTTP transport: a progress notification precedes the reply.
for (const [label, endings] of [
  ["LF", ["\n"]],
  ["CRLF", ["\r\n"]],
  ["CR", ["\r"]],
  ["mixed", ["\r\n", "\n", "\r"]],
] as const) {
  test(`MCP HTTP response preserves event boundaries with ${label} line endings`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const { id, method } = await req.json() as { id: number; method: string };
        expect(method).toBe("tools/list");
        const lines = [
          ": heartbeat",
          "",
          "event: message",
          'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
          "",
          "event: message",
          `data: {"jsonrpc":"2.0","id":${id},`,
          'data: "result":{"tools":[{"name":"example","inputSchema":{"type":"object"}}]}}',
          "",
          ": done",
          "",
        ];
        const body = lines.map((line, i) => line + endings[i % endings.length]).join("");
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const client = new UnbrowseMcp({ url: `http://127.0.0.1:${server.port}/mcp`, apiKey: "", endUser: "" });
      expect(await client.listTools()).toEqual([{ name: "example", inputSchema: { type: "object" } }]);
    } finally {
      server.stop(true);
    }
  });
}
