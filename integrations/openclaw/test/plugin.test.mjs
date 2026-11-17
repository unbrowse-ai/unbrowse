// The plugin as OpenClaw loads it: the entry's register(api) against a stub of the plugin API, and its tools against
// a fake node answering on the agent API's paths. No OpenClaw, no live node, no network past loopback.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeProof, tokenKey } from "unbrowse";
// The node's signed door, as the SDK's own fake nodes have it.
import { signing } from "../../../unbrowse-sdk/typescript/test/signed-fixture.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import plugin from "../dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// What the node serves: its agent primitives, from the manifest the node writes (unbrowse-node/agent-api.json).
const api = JSON.parse(readFileSync(join(root, "../../unbrowse-node/agent-api.json"), "utf8"));

// The setup on this machine must not stand in for what each test gives.
delete process.env.UNBROWSE_NODE;
delete process.env.UNBROWSE_AGENT_TOKEN;

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

const HN = { id: "hn-search", site: "hn.algolia.com", what: "search HN stories", method: "GET", path: "/api/v1/search", write: false, inputs: [{ name: "q", default: "rust", secret: false }] };

function answer(req, body) {
  const url = new URL(req.url, "http://x");
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return [401, { error: "unknown, revoked or expired agent key" }];
  switch (`${req.method} ${url.pathname}`) {
    case "GET /v1/routes":
      return [200, { routes: [HN] }];
    case "POST /v1/do":
      if (body.goal === "search HN stories") return [200, { how: "called", route: HN, result: { ok: true, ms: 212, data: { hits: [{ title: body.inputs?.q ?? "rust" }] }, retry: "as_is" } }];
      return [404, { error: "no route does that yet: give url, a page that does it, and the node learns it" }];
    case "POST /v1/routes/hn-search/call":
      return [200, { ok: true, ms: 90, data: { hits: [{ title: body.inputs.q }] }, retry: "as_is" }];
    case "POST /v1/routes/paused/call":
      return [503, { error: "the node is paused by its owner" }];
    case "POST /v1/browse":
      return [200, { site: body.site || "chat.example.com", output: `${body.do[0]} done` }];
    case "GET /v1/whoami":
      return [200, { agent: "openclaw", address: "0xabc", browser: "present" }];
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

/** register(api) against a stub of OpenClaw's plugin API: the tools it registers, by name. */
function load(pluginConfig = { node: base, agentToken: TOKEN }) {
  const registered = new Map();
  plugin.register({
    pluginConfig,
    registerTool(tool, opts) {
      assert.equal(opts.name, tool.name);
      registered.set(tool.name, { tool, opts });
    },
  });
  return registered;
}

const last = () => seen[seen.length - 1];

test("registers every tool the node serves, as the manifest declares, each a complete OpenClaw tool", () => {
  const tools = load();
  const served = api.primitives.map((p) => p.tool);
  assert.deepEqual([...tools.keys()], served);
  assert.deepEqual(manifest.contracts.tools, served);
  for (const [name, { tool, opts }] of tools) {
    const p = api.primitives.find((x) => x.tool === name);
    assert.equal(typeof tool.execute, "function", name);
    assert.ok(tool.label.startsWith("Unbrowse"), name);
    assert.ok(tool.description.includes(p.description), `${name}: the node's own description`);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), Object.keys(p.input.properties ?? {}).sort(), name);
    assert.equal(tool.resultContentSource, "network", name);
    assert.equal(opts.workspaceAccess, false, name);
  }
  assert.equal(tools.get("unbrowse_browse").tool.executionMode, "sequential");
  assert.equal(plugin.id, manifest.id);
});

test("only the tools that read are safe to replay; every other is side-effecting", () => {
  assert.deepEqual(Object.keys(manifest.toolMetadata), manifest.contracts.tools);
  for (const p of api.primitives) {
    const meta = manifest.toolMetadata[p.tool];
    if (p.method === "GET") assert.deepEqual(meta, { replaySafe: true }, p.tool);
    else assert.deepEqual(meta, { sideEffecting: true }, p.tool);
  }
});

test("do sends the goal, url and inputs as strings, with the token", async () => {
  const r = await load().get("unbrowse_do").tool.execute("1", { goal: "search HN stories", url: "https://hn.algolia.com/?q=rust", inputs: { q: "tauri", page: 2 } });
  assert.equal(last().url, "/v1/do");
  assert.equal(last().body.goal, "search HN stories");
  assert.equal(last().body.url, "https://hn.algolia.com/?q=rust");
  assert.deepEqual(last().body.inputs, { q: "tauri", page: "2" });
  assert.equal(last().headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(r.details.how, "called");
  assert.deepEqual(r.details.result.data, { hits: [{ title: "tauri" }] });
  assert.deepEqual(JSON.parse(r.content[0].text), r.details);
});

test("a missing argument and a node refusal come back as the reply, in the node's words", async () => {
  const tools = load();
  const before = seen.length;
  const r = await tools.get("unbrowse_do").tool.execute("1", {});
  assert.deepEqual(r.details, { error: "unbrowse_do needs goal", code: "bad_request" });
  assert.equal(seen.length, before);
  const missing = await tools.get("unbrowse_do").tool.execute("1", { goal: "send a message" });
  assert.equal(missing.details.code, "not_found");
  assert.match(missing.details.error, /give url/);
  const paused = await tools.get("unbrowse_call").tool.execute("1", { route_id: "paused" });
  assert.match(paused.details.error, /paused by its owner/);
});

test("browse steps share one session, so the next step acts on the page the last one opened", async () => {
  const tools = load();
  await tools.get("unbrowse_browse").tool.execute("1", { do: ["open", "https://chat.example.com/"] });
  const first = last().body.session;
  await tools.get("unbrowse_browse").tool.execute("2", { do: ["snapshot", "-i"] });
  assert.ok(first);
  assert.equal(last().body.session, first);
  assert.deepEqual(last().body.do, ["snapshot", "-i"]);
});

test("search, call and whoami reach the node's paths", async () => {
  const tools = load();
  await tools.get("unbrowse_search").tool.execute("1", { query: "hn stories & more" });
  assert.equal(last().url, "/v1/routes?q=hn%20stories%20%26%20more");
  const called = await tools.get("unbrowse_call").tool.execute("1", { route_id: "hn-search", inputs: { q: "tauri" } });
  assert.equal(last().url, "/v1/routes/hn-search/call");
  assert.equal(called.details.ok, true);
  const me = await tools.get("unbrowse_whoami").tool.execute("1", {});
  assert.equal(me.details.agent, "openclaw");
});

test("a process-wide token cannot substitute for this agent's configured key", async () => {
  process.env.UNBROWSE_NODE = base;
  process.env.UNBROWSE_AGENT_TOKEN = TOKEN;
  try {
    const before = seen.length;
    const r = await load({}).get("unbrowse_whoami").tool.execute("1", {});
    assert.equal(r.details.code, "unauthorized");
    assert.equal(seen.length, before, "no request borrowed the process-wide key");
  } finally {
    delete process.env.UNBROWSE_NODE;
    delete process.env.UNBROWSE_AGENT_TOKEN;
  }
});

test("without this agent's token the plugin sends no authorization header", async () => {
  const before = seen.length;
  const r = await load({ node: base }).get("unbrowse_whoami").tool.execute("1", {});
  assert.equal(r.details.code, "unauthorized");
  assert.equal(seen.length, before);
});

test("a node that isn't running is named as such", async () => {
  const r = await load({ node: "http://127.0.0.1:9", agentToken: TOKEN }).get("unbrowse_whoami").tool.execute("1", {});
  assert.equal(r.details.code, "unreachable");
});

test("the manifest's config schema takes the node and token, and nothing else", () => {
  assert.deepEqual(Object.keys(manifest.configSchema.properties).sort(), ["agentToken", "node"]);
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.equal(manifest.uiHints.agentToken.sensitive, true);
});

test("the skill ships with the plugin and directs the owner to configure an agent key", () => {
  const [dir] = manifest.skills;
  const skill = readFileSync(join(root, dir, "unbrowse", "SKILL.md"), "utf8");
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/)[1];
  assert.match(front, /^name: unbrowse$/m);
  assert.match(front, /^description: .{80,}$/m);
  assert.doesNotMatch(front, /UNBROWSE_AGENT_TOKEN/, "the skill does not advertise a process-wide token fallback");
  assert.doesNotMatch(skill, /signs? in to (Unbrowse|the node)|Wallet, New agent key/);
});

test("the package ships a self-contained entry: OpenClaw installs plugins without peers or scripts", () => {
  assert.deepEqual(pkg.openclaw.extensions, ["./dist/index.js"]);
  for (const f of ["dist", "skills", "openclaw.plugin.json"]) assert.ok(pkg.files.includes(f), f);
  assert.equal(pkg.dependencies, undefined);
  const bundle = readFileSync(join(root, "dist/index.js"), "utf8");
  assert.doesNotMatch(bundle, /from\s+["']unbrowse/);
  assert.doesNotMatch(bundle, /from\s+["']openclaw/);
});
