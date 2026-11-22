// The ways a request to the node ends that no happy path reaches: a failed reply with no usable body, an answer that
// points elsewhere, a stream that isn't the node's, an owner stream with no one to tell, an agent tool missing what it
// needs, and the shapes of a network route's reputation. Each against a fake node that answers as the node does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { UnbrowseNode, UnbrowseOwner, UnbrowseError, AuthenticationError, NodeUnavailableError, NodeConnectionError, NodeTimeoutError } from "../dist/index.js";
import { portOf } from "../dist/proof.js";
import { runTool } from "../dist/adapters/core.js";
import { TOOLS } from "../dist/adapters/tools.js";
import { fakeNode, json } from "./fake-node.mjs";
import { proofAnswer } from "./proof-fixture.mjs";

const TOKEN = "edges-agent-token";
const OWNER = "edges-owner-token";
let fake;

// What the next whoami is answered with.
const reply = { status: 200, raw: "{}", headers: {} };

before(async () => {
  fake = await fakeNode({
    tokens: [TOKEN],
    owner: OWNER,
    handler: (req, res) => {
      if (req.url === "/v1/whoami") {
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        return res.end(reply.raw);
      }
      if (req.url === "/owner/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        res.write("event: note\ndata: not json at all\n\n");
        res.write("event: note\ndata: {\"kind\":\"json\"}\n\n");
        return;
      }
      if (req.url === "/v1/do") return json(res, 200, { how: "called", route: { id: "r", site: "s.example", what: "w", method: "GET", path: "/", write: false, listed: false, yours: true, inputs: [] }, result: { ok: true, ms: 1, data: {}, error: null, paid_usdc: null, possible_commit: false, retry: "as_is" } });
      if (req.url.startsWith("/v1/routes")) {
        return json(res, 200, { routes: [
          { id: "0x" + "a".repeat(64), contributor: "0xdef", fee: 0.1, remote: true, reputation: { default: true, unverified: false, counted_uses: 12, pass_rate: 0.75, unavailable: false, version: 3 } },
          { id: "0x" + "b".repeat(64), contributor: "0xfed", fee: 0.2, remote: true, reputation: {} },
          { id: "0x" + "c".repeat(64), contributor: "0xfed", fee: 0.3, remote: true },
        ] });
      }
      json(res, 404, { error: "no such route" });
    },
  });
});
after(() => fake.close());

const node = () => new UnbrowseNode({ token: TOKEN, baseUrl: fake.base });
const answers = (status, raw, headers = {}) => Object.assign(reply, { status, raw, headers });

test("a failed reply whose body is the JSON value null is the SDK's own error with the node's status, not a TypeError (UNB-180)", async () => {
  answers(401, "null");
  await assert.rejects(node().whoami(), (e) => e instanceof AuthenticationError && e.status === 401 && e.code === "unauthorized" && !(e instanceof TypeError));
  answers(503, "null");
  await assert.rejects(node().whoami(), (e) => e instanceof NodeUnavailableError && e.status === 503);
  answers(500, "null");
  await assert.rejects(node().whoami(), (e) => e instanceof UnbrowseError && e.status === 500 && e.code === "http_500");
});

test("a failed reply that is not JSON says its own words, and a structured one keeps the node's message", async () => {
  answers(500, "the box fell over");
  await assert.rejects(node().whoami(), (e) => e.status === 500 && e.message === "the box fell over" && e.body === "the box fell over");
  answers(500, "");
  await assert.rejects(node().whoami(), (e) => e.status === 500 && e.message.length > 0, "an empty body still says something");
  answers(409, JSON.stringify({ error: "two sites do that", code: "not_a_code_of_ours" }));
  await assert.rejects(node().whoami(), (e) => e.status === 409 && e.message === "two sites do that" && e.code === "conflict" && e.body.code === "not_a_code_of_ours", "a code the SDK doesn't know falls back to the status's");
});

test("an answer that points elsewhere is never followed, and the request that got it says why", async () => {
  answers(302, "", { location: "http://127.0.0.1:1/steal" });
  await assert.rejects(node().whoami(), (e) => e instanceof NodeConnectionError && /pointed elsewhere \(status 302\)/.test(e.message));
});

test("a node that proves itself but doesn't sign its event stream is never listened to", async () => {
  // An address that answers the proof as the node does and then streams without the node's signature.
  const server = http.createServer((req, res) => {
    const proof = proofAnswer(req.url, server.address().port, { owner: OWNER });
    if (proof) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(proof));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: activity\ndata: 1\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const errors = [];
  const heard = [];
  const stream = new UnbrowseOwner({ token: OWNER, baseUrl: `http://127.0.0.1:${server.address().port}` }).events({ onError: (e) => errors.push(e) });
  stream.on("activity", (p) => heard.push(p));
  try {
    for (let i = 0; i < 300 && !errors.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(errors[0]?.message ?? "", /didn't sign its answer/);
    assert.deepEqual(heard, [], "nothing it said reached a listener");
  } finally {
    stream.close();
    server.closeAllConnections();
    server.close();
  }
});

test("a stream whose fixed token is refused, with no error handler, says so on the console and stops", async () => {
  const said = [];
  const log = console.error;
  console.error = (...a) => said.push(a);
  try {
    const stream = new UnbrowseOwner({ token: "not-the-owner-token", baseUrl: fake.base }).events();
    for (let i = 0; i < 300 && !stream.closed; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(stream.closed, "the stream stopped");
  } finally {
    console.error = log;
  }
  assert.equal(said.length, 1);
  assert.ok(said[0][0] instanceof UnbrowseError);
  assert.match(said[0][0].message, /ownerToken/);
});

test("a network route's reputation reads as the node counts it, and a record with none says none", async () => {
  const [full, empty, none] = await node().search("flights");
  assert.deepEqual(full.reputation, { default: true, unverified: false, countedUses: 12, passRate: 0.75, unavailable: false, version: 3 });
  assert.deepEqual(empty.reputation, { default: false, unverified: true, countedUses: 0, passRate: 0, unavailable: false, version: 0 }, "a reputation with nothing in it is unverified, not good");
  assert.equal("reputation" in none, false);
});

test("a tool that needs a goal or an ask says which it is missing, and runs nothing", async () => {
  const before = fake.seen.length;
  assert.deepEqual(await runTool(node(), TOOLS.do, {}), { error: "unbrowse_do needs goal", code: "bad_request" });
  assert.deepEqual(await runTool(node(), TOOLS.do, { goal: "" }), { error: "unbrowse_do needs goal", code: "bad_request" });
  assert.deepEqual(await runTool(node(), TOOLS.walk, {}), { error: "unbrowse_walk needs url", code: "bad_request" });
  assert.equal(fake.seen.length, before, "nothing was sent to the node");
});

test("the port of an address is the one named, else its scheme's, and an address that isn't one has none", () => {
  assert.equal(portOf("http://127.0.0.1:7777/x"), 7777);
  assert.equal(portOf("https://node.example"), 443);
  assert.equal(portOf("http://node.example"), 80);
  assert.equal(portOf("ftp://node.example"), undefined);
  assert.equal(portOf("not an address"), undefined);
});

test("an event whose data isn't JSON reaches its listener as the text the node sent", async () => {
  const heard = [];
  const stream = new UnbrowseOwner({ token: OWNER, baseUrl: fake.base }).events();
  stream.on("note", (p) => heard.push(p));
  try {
    for (let i = 0; i < 300 && heard.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(heard, ["not json at all", { kind: "json" }]);
  } finally {
    stream.close();
  }
});

// A fetch that lets the node prove itself and then fails the request itself, as a node going down between the two does.
const afterProof = (second) => (url, init) => (String(url).includes("/v1/node/proof") ? fetch(url, init) : second(url, init));

test("a node that goes quiet after it proved itself is said to be unreachable, with why", async () => {
  const gone = new UnbrowseNode({ token: TOKEN, baseUrl: fake.base, fetch: afterProof(() => Promise.reject(new Error("connection reset"))) });
  await assert.rejects(gone.whoami(), (e) => e instanceof NodeConnectionError && e.status === 0 && e.code === "unreachable" && e.message === `couldn't reach the node at ${fake.base}: is the Unbrowse app running? (connection reset)`);
});

test("a node that doesn't answer within the time given is said to have timed out, and not as unreachable", async () => {
  const hangs = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const slow = new UnbrowseNode({ token: TOKEN, baseUrl: fake.base, timeoutMs: 80, fetch: afterProof(hangs) });
  await assert.rejects(slow.whoami(), (e) => e instanceof NodeTimeoutError && e.code === "timeout" && /didn't answer within 80 ms/.test(e.message));
});

test("what a node can do is asked again after a failed ask, so one bad moment doesn't keep a call off the node for good", async () => {
  answers(500, JSON.stringify({ error: "starting up" }));
  const n = node();
  await assert.rejects(n.do("search HN stories", { browser: "never" }), (e) => e.status === 500);
  const sent = fake.seen.filter((r) => r.url === "/v1/do").length;
  answers(200, JSON.stringify({ agent: "a", address: "0x", node: "n", browser: "present", browser_fetch: true }));
  await n.do("search HN stories", { browser: "never" });
  const posts = fake.seen.filter((r) => r.url === "/v1/do");
  assert.equal(posts.length, sent + 1, "nothing was sent while the node couldn't say what it can do; the next try was");
  assert.equal(posts[posts.length - 1].body.browser, "never");
});

// UNB-181, open. Fails on the current src: the stream's reader turns each CR into a line end before it looks for the
// CRLF, so a CRLF cut between its CR and its LF reads as two line ends, and the event after it loses its name. Marked
// `todo` (it runs and reports, and fails nothing) until src/owner.ts reads such a stream; then the mark goes.
// A plain server, not the signing fake: a signed stream's events are signed whole, which hides the cut.
test("a CRLF stream cut between its CR and its LF is read event by event (UNB-181)", { todo: "UNB-181: the cut CRLF reads as two line ends" }, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.write("event: split\r");
    setTimeout(() => res.write("\ndata: one\r\n\r"), 30);
    setTimeout(() => res.write("\nevent: split\rdata: two\r\r"), 60);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const heard = [];
  const stream = new UnbrowseOwner({ baseUrl: `http://127.0.0.1:${server.address().port}` }).events();
  for (const name of ["split", "message"]) stream.on(name, (p) => heard.push([name, p]));
  try {
    for (let i = 0; i < 100 && heard.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(heard, [["split", "one"], ["split", "two"]]);
  } finally {
    stream.close();
    server.closeAllConnections();
    server.close();
  }
});
