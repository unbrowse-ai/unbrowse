// What the MCP bridge says to an agent that sends it something it can't relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { bridge } from "../dist/mcp.js";

async function say(lines, opts = {}) {
  const input = new PassThrough();
  const said = [];
  const done = bridge({ baseUrl: "http://127.0.0.1:1", input, output: { write: (s) => said.push(JSON.parse(s)) }, ...opts });
  for (const l of lines) input.write(`${l}\n`);
  input.end();
  await done;
  return said;
}

test("a line that isn't JSON is answered with a parse error, and the lines after it are still heard", async () => {
  const said = await say(["this is not json", "", JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })], { token: undefined });
  assert.equal(said.length, 2);
  assert.deepEqual(said[0], { jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } });
  assert.equal(said[1].id, 9);
  assert.equal(said[1].error.code, -32001, "with no token set, the next message is refused by name, not sent");
  assert.match(said[1].error.message, /UNBROWSE_AGENT_TOKEN/);
});
