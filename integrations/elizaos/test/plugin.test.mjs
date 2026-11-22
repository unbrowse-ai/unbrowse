// A fake node on the agent API's paths, and a fake ElizaOS runtime whose model answers what
// each test says, so the plugin is checked end to end without a live node, a model or the network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeProof, tokenKey } from "unbrowse";
// The node's signed door, as the SDK's own fake nodes have it.
import { signing } from "../../../unbrowse-sdk/typescript/test/signed-fixture.mjs";
import { readFileSync } from "node:fs";
import plugin, { UnbrowseService, unbrowse, doAction, browseAction, searchAction, callAction, unbrowseProvider, unbrowseRoutesProvider } from "../dist/index.js";

// What the node serves: its agent primitives, from the manifest the node writes (unbrowse-node/agent-api.json).
const api = JSON.parse(readFileSync(new URL("../../../unbrowse-node/agent-api.json", import.meta.url), "utf8"));

const TOKEN = "agent-token";

/** The node's answer to `/v1/node/proof`: the proof for TOKEN when the asker names its key. */
function proofAnswer(url, port) {
  const u = new URL(url, "http://x");
  if (u.pathname !== "/v1/node/proof") return undefined;
  const challenge = Uint8Array.from(u.searchParams.get("challenge")?.match(/../g) ?? [], (b) => parseInt(b, 16));
  return { agents: u.searchParams.get("key") === tokenKey(TOKEN) ? [nodeProof(TOKEN, port, challenge)] : [] };
}
const seen = [];
let server;
let base;

const story = { id: "story-search", site: "news.example", what: "search stories", method: "GET", path: "/api/search", write: false, listed: false, yours: true, inputs: [{ name: "q", default: "rust", secret: false }] };

function answer(req, body) {
  const url = new URL(req.url, "http://x");
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return [401, { error: "unknown, revoked or expired agent key" }];
  switch (`${req.method} ${url.pathname}`) {
    case "GET /v1/routes":
      if (url.searchParams.get("q") === "flights") {
        return [200, { routes: [{ id: "0x" + "a".repeat(64), site: "air.example", what: "search flights", contributor: "0xdef", fee: 0.4, remote: true }] }];
      }
      return [200, { routes: [story, { id: "post-listing", site: "market.example", what: "post a listing", write: true, inputs: [{ name: "title" }] }] }];
    case "POST /v1/do": {
      const call = { ok: true, ms: 212, data: { hits: [{ title: body.inputs?.q ?? "rust" }] }, error: null, paid_unb: null, possible_commit: false, retry: "as_is" };
      if (body.ask === "ask_0f9b3e4a5e46facc" && body.goal === undefined) return [200, { how: "called", route: story, result: call, outcome: "answered", ask: body.ask }];
      if (body.goal === "search stories") return [200, { how: "called", route: story, result: call }];
      if (body.goal === "search comments") return [200, { how: "learned", picked_by: "judge", route: { ...story, id: "comment-search", what: body.goal }, result: call }];
      if (body.goal === "buy a ticket") return [200, { how: "called", route: { ...story, id: "buy", write: true }, result: { ...call, data: { order: 1 } } }];
      if (!body.url) return [404, { error: "no route does that yet: give url, a page that does it, and the node learns it" }];
      return [200, { how: "browse", site: "chat.example", page: '- textbox "Message" [ref=e3]', why: "no call on the page answers the goal" }];
    }
    case "POST /v1/routes/story-search/call":
      return [200, { ok: true, ms: 90, data: { hits: [{ title: body.inputs?.q }] }, error: null, paid_unb: null, possible_commit: false, retry: "as_is" }];
    case "POST /v1/routes/post-listing/call":
      return [200, { ok: false, ms: 900, data: null, error: "the site answered 502", paid_unb: null, possible_commit: true, retry: "check_first" }];
    case "POST /v1/routes/r1/judge":
      return [200, { route: "r1", verdict: body.verdict, bounty: body.bounty ?? null }];
    case "POST /v1/routes/paused/call":
      return [503, { error: "the node is paused by its owner" }];
    case "POST /v1/browse": {
      const [verb, arg] = body.do;
      const reply = { site: verb === "open" ? new URL(arg).hostname : body.site || "last.example", output: `${verb} done` };
      if (verb === "fill") reply.learned = [{ route_id: "send-message", what: "send a message", inputs: ["text"], write: true }];
      if (verb === "open" && body.goal === "send a message") reply.route_for_goal = { route_id: "send-message", what: "send a message", inputs: ["text"], write: true };
      return [200, reply];
    }
  }
  return [404, { error: "no such route" }];
}

before(async () => {
  server = http.createServer(signing((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      // The SDK asks the node to prove it holds the token before the token goes: not a request the plugin made.
      const proof = proofAnswer(req.url, server.address().port);
      if (proof) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(proof));
      }
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const [status, json] = answer(req, body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  }, () => [TOKEN]));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const last = () => seen[seen.length - 1];

/** A runtime with the character's settings, the plugin's service started, and a model that answers `model`. */
async function runtime({ settings = { UNBROWSE_NODE: base, UNBROWSE_AGENT_TOKEN: TOKEN }, model = "", recent = "" } = {}) {
  const services = new Map();
  const rt = {
    agentId: "agent-1",
    character: { name: "Ada" },
    prompts: [],
    getSetting: (k) => settings[k] ?? null,
    getService: (t) => services.get(t) ?? null,
    composeState: async () => ({ values: { agentName: "Ada", recentMessages: recent }, data: {}, text: "" }),
    useModel: async (type, params) => {
      rt.prompts.push({ type, prompt: params.prompt });
      return model;
    },
  };
  services.set(UnbrowseService.serviceType, await UnbrowseService.start(rt));
  return rt;
}

const message = (text, extra = {}) => ({ id: "m-1", entityId: "u-1", roomId: "r-1", content: { text, source: "test", ...extra } });

/** Run an action's handler and keep what it said through the callback. */
async function run(action, rt, msg) {
  const said = [];
  const result = await action.handler(rt, msg, undefined, {}, async (c) => (said.push(c), []));
  return { result, said };
}

test("the plugin carries a service, an action for every tool the node serves, and two providers", () => {
  assert.equal(plugin.name, "unbrowse");
  assert.deepEqual(plugin.services, [UnbrowseService]);
  assert.deepEqual(plugin.actions.map((a) => a.name), api.primitives.map((p) => p.tool.toUpperCase()));
  for (const a of plugin.actions) {
    const p = api.primitives.find((x) => x.tool.toUpperCase() === a.name);
    assert.ok(a.description.length > 0, a.name);
    assert.doesNotMatch(a.description, /\bunbrowse_[a-z]/, `${a.name}: action names for tool names`);
    assert.ok(a.examples.every((ex) => ex.some((m) => m.content.actions?.includes(a.name))), a.name);
    assert.ok(p, a.name);
  }
  for (const a of [doAction, browseAction, searchAction, callAction]) assert.ok(a.examples.length > 0, a.name);
  assert.deepEqual(plugin.providers.map((p) => p.name), ["UNBROWSE", "UNBROWSE_ROUTES"]);
});

test("actions and the provider stay off without a token", async () => {
  const saved = process.env.UNBROWSE_AGENT_TOKEN;
  process.env.UNBROWSE_AGENT_TOKEN = "foreign-process-token";
  try {
    const rt = await runtime({ settings: { UNBROWSE_NODE: base } });
    for (const a of plugin.actions) assert.equal(await a.validate(rt, message("hi")), false);
    assert.equal((await unbrowseProvider.get(rt, message("hi"), {})).text, "");
  } finally {
    if (saved !== undefined) process.env.UNBROWSE_AGENT_TOKEN = saved;
  }
});

test("the service reads the node and the token from the character's settings", async () => {
  const rt = await runtime();
  assert.equal(await doAction.validate(rt, message("hi")), true);
  const p = await unbrowseProvider.get(rt, message("hi"), {});
  assert.match(p.text, /Say what you want with UNBROWSE_DO/);
  assert.match(p.text, /UNBROWSE_JUDGE/);
  assert.doesNotMatch(p.text, /pays_usd|UNB fee/);
  assert.equal(p.values.unbrowseNode, base);
});

test("do reads its parameters off the conversation and calls the node", async () => {
  const rt = await runtime({ model: '<response><goal>search stories</goal><url>https://news.example/?q=rust</url><inputs>{"q": "tauri"}</inputs></response>' });
  const { result, said } = await run(doAction, rt, message("find tauri stories on news.example"));
  assert.equal(last().url, "/v1/do");
  assert.equal(last().body.goal, "search stories");
  assert.equal(last().body.url, "https://news.example/?q=rust");
  assert.deepEqual(last().body.inputs, { q: "tauri" });
  assert.equal(last().headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(result.success, true);
  assert.equal(result.data.reply.how, "called");
  assert.match(said[0].text, /"title": "tauri"/);
  assert.deepEqual(said[0].actions, ["UNBROWSE_DO"]);
  // The prompt lists the tool's own parameters, from its input schema.
  assert.match(rt.prompts[0].prompt, /- goal \(required\)/);
  assert.match(rt.prompts[0].prompt, /- browser \(optional\): .*One of: auto, if_present, never/);
});

test("parameters the planner gives are used as they are, with no model call", async () => {
  const rt = await runtime();
  const { result } = await run(doAction, rt, message("x", { actionParams: { goal: "search comments", url: "https://news.example/?q=rust&type=comment" } }));
  assert.equal(rt.prompts.length, 0);
  assert.equal(result.data.reply.how, "learned");
});

test("a number the conversation never named is not sent", async () => {
  const judge = plugin.actions.find((a) => a.name === "UNBROWSE_JUDGE");
  const said = "<response><route_id>r1</route_id><verdict>right</verdict><bounty>4</bounty><entry>e1</entry></response>";
  const rt = await runtime({ model: said });
  await run(judge, rt, message("r1's answer does the bounty, through entry e1"));
  assert.equal(last().url, "/v1/routes/r1/judge");
  assert.equal(last().body.bounty, undefined, "a bounty id the model made up is dropped");
  assert.equal(last().body.entry, "e1");
  const named = await runtime({ model: said });
  const ok = await run(judge, named, message("r1's answer does bounty 4, through entry e1"));
  assert.equal(last().body.bounty, 4);
  assert.equal(ok.result.success, true);
});

test("a goal with no value is asked for, and nothing is sent", async () => {
  const rt = await runtime({ model: "<response></response>" });
  const before = seen.length;
  const { result, said } = await run(doAction, rt, message("do something"));
  assert.equal(result.success, false);
  assert.match(said[0].text, /UNBROWSE_DO needs goal/);
  assert.equal(seen.length, before);
});

test("an ask alone is sent to the node to collect its answer", async () => {
  const rt = await runtime({ model: "<response><ask>ask_0f9b3e4a5e46facc</ask></response>" });
  const { result } = await run(doAction, rt, message("collect ask_0f9b3e4a5e46facc"));
  assert.equal(last().url, "/v1/do");
  assert.equal(last().body.ask, "ask_0f9b3e4a5e46facc");
  assert.equal(last().body.goal, undefined);
  assert.equal(result.success, true);
  assert.equal(result.data.reply.ask, "ask_0f9b3e4a5e46facc");
});

test("a node that refuses is answered as text, not thrown", async () => {
  const rt = await runtime({ model: "<response><route_id>paused</route_id></response>" });
  const { result, said } = await run(callAction, rt, message("run paused"));
  assert.equal(result.success, false);
  assert.match(said[0].text, /Unbrowse couldn't do it: the node is paused by its owner/);
});

test("a call the site didn't pass is a result that says how to retry", async () => {
  const rt = await runtime({ model: "<response><route_id>post-listing</route_id></response>" });
  const { result, said } = await run(callAction, rt, message("post it"));
  assert.equal(result.success, false);
  assert.equal(result.data.reply.retry, "check_first");
  assert.match(said[0].text, /"possible_commit": true/);
});

test("browse sends the command and its steps share one session", async () => {
  const rt = await runtime({ model: '<response><do>["open", "https://chat.example/"]</do><goal>send a message</goal></response>' });
  await run(browseAction, rt, message("open the chat"));
  assert.deepEqual(last().body.do, ["open", "https://chat.example/"]);
  const first = last().body.session;
  const rt2 = { ...rt, useModel: async () => "<response><do>snapshot -i</do></response>", prompts: [] };
  await run(browseAction, rt2, message("look at it"));
  assert.deepEqual(last().body.do, ["snapshot", "-i"]);
  assert.ok(first);
  assert.equal(last().body.session, first);
});

test("search encodes the query", async () => {
  const rt = await runtime({ model: "<response><query>flights</query></response>" });
  const { result } = await run(searchAction, rt, message("any flight routes?"));
  assert.equal(last().url, "/v1/routes?q=flights");
  assert.equal(result.data.reply.routes[0].remote, true);
});

test("a message that looks like a template is read as text", async () => {
  const rt = await runtime({ model: "<response><query>{{agentName}}</query></response>" });
  await run(searchAction, rt, message("find {{recentMessages}} routes"));
  assert.match(rt.prompts[0].prompt, /find \{\{recentMessages\}\} routes/);
});

test("the routes provider lists what the node knows, and says nothing when it can't reach it", async () => {
  const rt = await runtime();
  assert.equal(unbrowseRoutesProvider.dynamic, true);
  const p = await unbrowseRoutesProvider.get(rt, message("hi"), {});
  assert.match(p.text, /story-search: search stories \(news.example\), inputs: q/);
  assert.equal(p.data.routes.length, 2);

  const down = await runtime({ settings: { UNBROWSE_NODE: "http://127.0.0.1:1", UNBROWSE_AGENT_TOKEN: TOKEN } });
  const none = await unbrowseRoutesProvider.get(down, message("hi"), {});
  assert.equal(none.text, "");
  assert.ok(none.data.error);
});

test("a token set after the agent started turns the actions on, and its calls carry it", async () => {
  const settings = { UNBROWSE_NODE: base };
  const rt = await runtime({ settings });
  assert.equal(await doAction.validate(rt), false, "no token yet");
  settings.UNBROWSE_AGENT_TOKEN = TOKEN;
  assert.equal(await doAction.validate(rt), true);
  assert.ok((await unbrowse(rt).node.search("")).length > 0, "the node took the token set later");
});

test("a token taken away turns the actions off again", async () => {
  const settings = { UNBROWSE_NODE: base, UNBROWSE_AGENT_TOKEN: TOKEN };
  const rt = await runtime({ settings });
  assert.equal(await doAction.validate(rt), true);
  delete settings.UNBROWSE_AGENT_TOKEN;
  assert.equal(await doAction.validate(rt), false);
});

test("a changed token keeps the agent's browsing session, so its page stays its own", async () => {
  const settings = { UNBROWSE_NODE: base, UNBROWSE_AGENT_TOKEN: "an-older-token" };
  const rt = await runtime({ settings });
  const session = unbrowse(rt).node.session;
  settings.UNBROWSE_AGENT_TOKEN = TOKEN;
  assert.equal(unbrowse(rt).node.session, session);
  assert.ok((await unbrowse(rt).node.search("")).length > 0, "the new token is the one sent");
});

test("the client stays the same one while nothing changes", async () => {
  const rt = await runtime();
  assert.equal(unbrowse(rt).node, unbrowse(rt).node);
});
