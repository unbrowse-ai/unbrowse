// `unbrowse mcp`: the stdio bridge an agent's MCP config starts in place of handing the token to its HTTP transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { bridge } from "../dist/mcp.js";
import { proofAnswer } from "./proof-fixture.mjs";
import { signing } from "./signed-fixture.mjs";

const TOKEN = ["mcp", "agent", Date.now().toString(36)].join("-");

/** A node's `/mcp` that answers as the node does (plain JSON, a session id at `initialize`), proving itself for
 * `holds`. What it heard is in `heard`. */
async function node({ holds }) {
  const heard = [];
  const server = http.createServer(signing((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const port = server.address().port;
      const proof = proofAnswer(req.url, port, { agents: holds });
      if (proof) return res.end(JSON.stringify(proof));
      const message = JSON.parse(body);
      heard.push({ authorization: req.headers.authorization, session: req.headers["mcp-session-id"], message });
      if (message.id === undefined) {
        res.statusCode = 202;
        return res.end("null");
      }
      if (message.method === "initialize") res.setHeader("mcp-session-id", "s1");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { method: message.method } }));
    });
  }, () => holds));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, heard, base: `http://127.0.0.1:${server.address().port}` };
}

async function run(base, lines) {
  const input = new PassThrough();
  const said = [];
  const done = bridge({ baseUrl: base, token: TOKEN, input, output: { write: (s) => said.push(JSON.parse(s)) } });
  for (const l of lines) input.write(`${JSON.stringify(l)}\n`);
  input.end();
  await done;
  return said;
}

test("the bridge signs each message with the token, never sending it, and carries the session", async () => {
  const { server, heard, base } = await node({ holds: [TOKEN] });
  try {
    const said = await run(base, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    assert.deepEqual(
      said.map((m) => m.id).sort(),
      [1, 2],
      "each request is answered once, a notification never",
    );
    assert.ok(heard.every((h) => h.authorization === `Bearer ${TOKEN}`));
    assert.deepEqual(heard.filter((h) => h.message.method !== "initialize").map((h) => h.session), ["s1", "s1"]);
  } finally {
    server.close();
  }
});

test("a listener that can't prove it is the token's node never hears the token, and the agent hears why", async () => {
  const { server, heard, base } = await node({ holds: [] });
  try {
    const said = await run(base, [{ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "unbrowse_do" } }]);
    assert.equal(heard.length, 0, "nothing but the proof was asked of it");
    assert.equal(said.length, 1);
    assert.equal(said[0].id, 7);
    assert.match(said[0].error.message, /couldn't prove/);
  } finally {
    server.close();
  }
});
