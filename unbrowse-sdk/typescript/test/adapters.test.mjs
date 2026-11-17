// The framework adapters (unbrowse/ai-sdk, unbrowse/langchain, unbrowse/mastra, unbrowse/openai-agents) against a fake
// node answering in the shapes app/src/api.rs produces, as client.test.mjs's does: the tools each gives and their
// schemas, one call through each tool, failures answered as the tool's result, and each framework's own tool-calling
// path with a scripted model, so no model API is called.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { Unbrowse } from "../dist/index.js";
import { proofAnswer } from "./proof-fixture.mjs";
import { signing } from "./signed-fixture.mjs";
import * as aiSdk from "../dist/adapters/ai-sdk.js";
import * as langchain from "../dist/adapters/langchain.js";
import * as mastra from "../dist/adapters/mastra.js";
import * as openaiAgents from "../dist/adapters/openai-agents.js";

const TOKEN = "agent-token";
const seen = [];
let server;
let base;

const HN = { id: "hn-search", site: "hn.algolia.com", what: "search HN stories", method: "GET", path: "/api/v1/search", write: false, listed: false, yours: true, inputs: [{ name: "q", default: "rust", secret: false }] };
const call = (q) => ({ ok: true, ms: 212, data: { hits: [{ title: q }] }, error: null, paid_usdc: null, possible_commit: false, retry: "as_is" });

function answer(req, body) {
  const url = new URL(req.url, "http://x");
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return [401, { error: "unknown, revoked or expired agent key" }];
  switch (`${req.method} ${url.pathname}`) {
    case "GET /v1/whoami":
      return [200, { agent: "claude", address: "0xabc", node: "lewis-mac" }];
    case "GET /v1/routes":
      return [200, { routes: url.searchParams.get("q") === "nothing here" ? [] : [HN] }];
    case "POST /v1/do":
      if (body.goal === "search HN stories") return [200, { how: "called", route: HN, result: call(body.inputs?.q ?? "rust") }];
      if (body.goal === "read a page" && body.url) return [422, { error: "the node has no browser: install Chrome, or download Chrome for Testing in the Unbrowse app's Settings" }];
      // A node with the browser add-on names the case and says how to get it, or that it is fetching it now.
      if (body.goal === "learn a page" && body.url) return [422, { error: "this needs the node's browser", code: "browser_missing", browser: "missing", missing: ["chromium"], install: "unbrowse browser install", fetch: false }];
      if (body.goal === "learn a page soon" && body.url) return [422, { error: "this needs the node's browser", code: "browser_missing", browser: "installing", missing: ["chromium"], install: "unbrowse browser install", fetch: true }];
      if (!body.url) return [404, { error: "no route does that yet: give url, a page that does it, and the node learns it" }];
      return [200, { how: "browse", site: "chat.example.com", page: '- textbox "Message" [ref=e3]', why: "no call on the page answers the goal" }];
    case "POST /v1/routes/hn-search/call":
      return [200, call(body.inputs.q)];
    case "GET /v1/logins":
      return [200, { logins: [{ ref: "vault:example.com:me", site: "example.com" }], cards: [] }];
    case "POST /v1/browse":
      return [200, { site: "chat.example.com", output: `${body.do[0]} done`, learned: [] }];
    case "POST /v1/report":
      return [200, { report: "off", fingerprint: "f", scrubbed: {}, contents: null }];
  }
  return [404, { error: "no such route: search, or say what you want with unbrowse_do" }];
}

before(async () => {
  server = http.createServer(signing((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const proof = proofAnswer(req.url, server.address().port, { agents: [TOKEN] });
      if (proof) return res.end(JSON.stringify(proof));
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, url: req.url, body });
      const [status, out] = answer(req, body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  }, () => [TOKEN]));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const node = () => new Unbrowse({ token: TOKEN, baseUrl: base, session: "s1" });
const last = () => seen[seen.length - 1];
const manifest = JSON.parse(readFileSync(new URL("../../../unbrowse-node/agent-api.json", import.meta.url), "utf8"));
const mcp = (tool) => manifest.primitives.find((p) => p.tool === tool);
const DEFAULT = ["unbrowse_do", "unbrowse_search", "unbrowse_call", "unbrowse_logins", "unbrowse_whoami"];

const MODULES = { "ai-sdk": aiSdk, langchain, mastra, "openai-agents": openaiAgents };

// Each adapter, as the tests below drive it: its tools by name, and one call through a tool giving the text the model reads.
const ADAPTERS = {
  "ai-sdk": {
    tools: (opts) => aiSdk.unbrowseTools(node(), opts),
    names: (t) => Object.keys(t),
    describe: (t, name) => ({ description: t[name].description, schema: t[name].inputSchema.jsonSchema }),
    run: async (t, name, input) => t[name].execute(input, { toolCallId: "c1", messages: [] }),
  },
  langchain: {
    tools: (opts) => langchain.unbrowseTools(node(), opts),
    names: (t) => t.map((x) => x.name),
    describe: (t, name) => { const x = t.find((y) => y.name === name); return { description: x.description, schema: x.schema }; },
    run: async (t, name, input) => JSON.parse(await t.find((x) => x.name === name).invoke(input)),
  },
  mastra: {
    tools: (opts) => mastra.unbrowseTools(node(), opts),
    names: (t) => Object.keys(t),
    // Mastra keeps a JSON Schema as a standard schema, which gives the JSON Schema back.
    describe: (t, name) => ({ description: t[name].description, schema: t[name].inputSchema["~standard"].jsonSchema.input({ target: "draft-07" }) }),
    run: async (t, name, input) => t[name].execute(input, {}),
  },
  "openai-agents": {
    tools: (opts) => openaiAgents.unbrowseTools(node(), opts),
    names: (t) => t.map((x) => x.name),
    describe: (t, name) => { const x = t.find((y) => y.name === name); return { description: x.description, schema: x.parameters }; },
    run: async (t, name, input) => JSON.parse(await t.find((x) => x.name === name).invoke({}, JSON.stringify(input))),
  },
};

for (const [fw, a] of Object.entries(ADAPTERS)) {
  test(`${fw}: the five tools by default, browse only when asked`, () => {
    assert.deepEqual(a.names(a.tools()), DEFAULT);
    assert.deepEqual(a.names(a.tools({ include: [...aiSdk.DEFAULT_TOOLS, "browse"] })), [...DEFAULT, "unbrowse_browse"]);
    assert.deepEqual(a.names(a.tools({ include: ["unbrowse_do", "report"] })), ["unbrowse_do", "unbrowse_report"]);
    assert.throws(() => a.tools({ include: ["scrape"] }), /no Unbrowse tool scrape/);
  });

  test(`${fw}: each tool has the MCP server's description and input schema`, () => {
    const t = a.tools({ include: ["do", "search", "call", "logins", "whoami", "browse"] });
    for (const name of a.names(t)) {
      const { description, schema } = a.describe(t, name);
      const p = mcp(name);
      assert.ok(description.endsWith(p.description), `${name} carries the node's description`);
      for (const [k, v] of Object.entries(p.input.properties)) assert.deepEqual(schema.properties[k], v, `${name}.${k}`);
      assert.deepEqual(schema.required ?? [], p.input.required ?? []);
    }
    const { description } = a.describe(t, "unbrowse_do");
    assert.match(description, /before you write a scraper/, "unbrowse_do says to call it before a scraper");
    assert.match(description, /inaccessible/);
  });

  test(`${fw}: one call through each tool reaches the node and answers its JSON`, async () => {
    const t = a.tools({ include: ["do", "search", "call", "logins", "whoami", "browse"] });

    const r = await a.run(t, "unbrowse_do", { goal: "search HN stories", url: "https://hn.algolia.com/?q=rust", inputs: { q: "42" } });
    assert.equal(r.how, "called");
    assert.equal(r.result.data.hits[0].title, "42");
    assert.equal(last().url, "/v1/do");
    assert.deepEqual(last().body, { goal: "search HN stories", url: "https://hn.algolia.com/?q=rust", inputs: { q: "42" }, session: "s1" });

    assert.equal((await a.run(t, "unbrowse_search", { query: "hn" })).routes[0].id, "hn-search");
    assert.equal(last().url, "/v1/routes?q=hn");

    const c = await a.run(t, "unbrowse_call", { route_id: "hn-search", inputs: { q: "zig" } });
    assert.equal(c.data.hits[0].title, "zig");
    assert.equal(c.retry, "as_is", "the node's own snake-case answer, as MCP gives it");

    assert.equal((await a.run(t, "unbrowse_logins", {})).logins[0].ref, "vault:example.com:me");
    assert.equal((await a.run(t, "unbrowse_whoami", {})).node, "lewis-mac");

    assert.equal((await a.run(t, "unbrowse_browse", { do: ["open", "https://chat.example.com"], session: "b" })).output, "open done");
    assert.equal(last().body.session, "s1:b", "a session the model names is one of this client's");
  });

  test(`${fw}: a failed call is the tool's answer, not a crash`, async () => {
    const t = a.tools();
    assert.deepEqual(await a.run(t, "unbrowse_do", { goal: "post a listing" }), { error: "no route does that yet: give url, a page that does it, and the node learns it", code: "not_found" });
    const missing = await a.run(t, "unbrowse_call", { route_id: "" });
    assert.deepEqual(missing, { error: "unbrowse_call needs route_id", code: "bad_request" });
    const noBrowser = await a.run(t, "unbrowse_do", { goal: "read a page", url: "https://example.com/page" });
    assert.equal(noBrowser.code, "browser_missing");
    assert.match(noBrowser.hint, /still calls the routes the node has/);
    const named = await a.run(t, "unbrowse_do", { goal: "learn a page", url: "https://example.com/page" });
    assert.equal(named.code, "browser_missing");
    assert.match(named.hint, /`unbrowse browser install` on the node's machine/, "the node's own way to get it");
    const fetching = await a.run(t, "unbrowse_do", { goal: "learn a page soon", url: "https://example.com/page" });
    assert.match(fetching.hint, /fetching its browser now: try again in a minute/);
    const unreachable = MODULES[fw].unbrowseTools({ token: TOKEN, baseUrl: "http://127.0.0.1:9", timeoutMs: 2000 });
    assert.equal((await a.run(unreachable, "unbrowse_whoami", {})).code, "unreachable", "a node that isn't running");
  });
}

// ---- each framework's own tool-calling path, with a scripted model ----

test("ai-sdk: generateText calls unbrowse_do through the tool set", async () => {
  const { generateText, isStepCount } = await import("ai");
  const { MockLanguageModelV4 } = await import("ai/test");
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const model = new MockLanguageModelV4({
    doGenerate: [
      { content: [{ type: "tool-call", toolCallId: "c1", toolName: "unbrowse_do", input: JSON.stringify({ goal: "search HN stories", url: "https://hn.algolia.com/?q=rust" }) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] },
      { content: [{ type: "text", text: "The top story is rust." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] },
    ],
  });
  const r = await generateText({ model, tools: aiSdk.unbrowseTools(node()), stopWhen: isStepCount(3), prompt: "What's on HN about rust?" });
  assert.equal(r.text, "The top story is rust.");
  const result = r.steps[0].toolResults[0];
  assert.equal(result.toolName, "unbrowse_do");
  assert.equal(result.output.how, "called");
  // The model was offered the tools with the node's schemas.
  const offered = model.doGenerateCalls[0].tools.map((t) => t.name);
  assert.deepEqual(offered, DEFAULT);
});

test("langchain: a chat model's tool call runs through the tool and comes back as a ToolMessage", async () => {
  const { BaseChatModel } = await import("@langchain/core/language_models/chat_models");
  const { AIMessage, HumanMessage } = await import("@langchain/core/messages");
  // A chat model that answers with one scripted tool call, and records the tools it was bound to.
  class Scripted extends BaseChatModel {
    bound = [];
    _llmType() {
      return "scripted";
    }
    bindTools(tools) {
      this.bound = tools;
      return this;
    }
    async _generate() {
      const message = new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "unbrowse_do", args: { goal: "search HN stories" }, type: "tool_call" }] });
      return { generations: [{ text: "", message }] };
    }
  }
  const tools = langchain.unbrowseTools(node());
  const model = new Scripted({});
  const ai = await model.bindTools(tools).invoke([new HumanMessage("What's on HN about rust?")]);
  assert.deepEqual(model.bound.map((t) => t.name), DEFAULT);
  const msg = await tools.find((t) => t.name === ai.tool_calls[0].name).invoke(ai.tool_calls[0]);
  assert.equal(msg.constructor.name, "ToolMessage");
  assert.equal(msg.tool_call_id, "c1");
  assert.equal(JSON.parse(msg.content).how, "called");
});

test("mastra: an agent's generate calls unbrowse_do", async () => {
  const { Agent } = await import("@mastra/core/agent");
  const { MockLanguageModelV3 } = await import("ai/test");
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const model = new MockLanguageModelV3({
    doGenerate: [
      { content: [{ type: "tool-call", toolCallId: "c1", toolName: "unbrowse_do", input: JSON.stringify({ goal: "search HN stories" }) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] },
      { content: [{ type: "text", text: "The top story is rust." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] },
    ],
  });
  const agent = new Agent({ id: "hn", name: "hn", instructions: "Answer from websites with Unbrowse.", model, tools: mastra.unbrowseTools(node()) });
  const r = await agent.generate("What's on HN about rust?", { maxSteps: 3 });
  assert.equal(r.text, "The top story is rust.");
  const results = r.steps.flatMap((s) => s.toolResults ?? []);
  assert.equal(results[0].payload.toolName, "unbrowse_do");
  assert.equal(results[0].payload.result.how, "called");
});

test("openai-agents: run() calls unbrowse_do through the function tool", async () => {
  const { Agent, run, Usage, setTracingDisabled } = await import("@openai/agents");
  setTracingDisabled(true);
  let n = 0;
  const model = {
    async getResponse() {
      if (n++ === 0) return { usage: new Usage(), output: [{ type: "function_call", callId: "c1", name: "unbrowse_do", arguments: JSON.stringify({ goal: "search HN stories" }), status: "completed" }] };
      return { usage: new Usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "The top story is rust." }] }] };
    },
    async *getStreamedResponse() {
      throw new Error("not streamed");
    },
  };
  const agent = new Agent({ name: "hn", instructions: "Answer from websites with Unbrowse.", model, tools: openaiAgents.unbrowseTools(node()) });
  const r = await run(agent, "What's on HN about rust?");
  assert.equal(r.finalOutput, "The top story is rust.");
  const output = r.newItems.find((i) => i.type === "tool_call_output_item");
  assert.equal(JSON.parse(output.output).how, "called");
});
