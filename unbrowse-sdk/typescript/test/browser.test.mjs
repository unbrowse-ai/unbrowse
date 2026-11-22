// The node's browser driven by hand (`node.browser()`): each method says the command the node's browser takes, word for
// word, and the browser keeps its site, goal and what it learned between steps.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { UnbrowseNode } from "../dist/index.js";
import { fakeNode, json } from "./fake-node.mjs";

const TOKEN = "browser-test-token";
let fake;

before(async () => {
  fake = await fakeNode({
    tokens: [TOKEN],
    handler: (req, res, body) => {
      if (req.url !== "/v1/browse") return json(res, 404, { error: "no such route" });
      const [verb, arg] = body.do;
      const reply = { site: verb === "open" ? new URL(arg).hostname : body.site, output: `${verb} done` };
      if (verb === "reload") reply.route_for_goal = { route_id: "reload-goal", what: "reload", inputs: [], write: false };
      json(res, 200, reply);
    },
  });
});
after(() => fake.close());

const node = () => new UnbrowseNode({ token: TOKEN, baseUrl: fake.base });
const lastDo = () => fake.seen[fake.seen.length - 1].body.do;

test("each browser method sends the node's browser the command it names, word for word", async () => {
  const b = node().browser({ site: "shop.example", goal: "buy a lamp" });
  const steps = [
    [() => b.dblclick("@e1"), ["dblclick", "@e1"]],
    [() => b.type("#q", "lamp"), ["type", "#q", "lamp"]],
    [() => b.press("Enter"), ["press", "Enter"]],
    [() => b.select("#size", "large"), ["select", "#size", "large"]],
    [() => b.check("#gift"), ["check", "#gift"]],
    [() => b.uncheck("#gift"), ["uncheck", "#gift"]],
    [() => b.hover("@e2"), ["hover", "@e2"]],
    [() => b.focus("@e3"), ["focus", "@e3"]],
    [() => b.scrollIntoView("@e9"), ["scrollintoview", "@e9"]],
    [() => b.upload("#file", "/tmp/a.png", "/tmp/b.png"), ["upload", "#file", "/tmp/a.png", "/tmp/b.png"]],
    [() => b.get("title"), ["get", "title"]],
    [() => b.get("text", "@e1"), ["get", "text", "@e1"]],
    [() => b.is("visible", "@e1"), ["is", "visible", "@e1"]],
    [() => b.back(), ["back"]],
    [() => b.forward(), ["forward"]],
    [() => b.run("get", "attr", "@e2", "href"), ["get", "attr", "@e2", "href"]],
  ];
  for (const [call, words] of steps) {
    await call();
    assert.deepEqual(lastDo(), words);
    assert.equal(fake.seen[fake.seen.length - 1].body.site, "shop.example", "every step says whose browser it drives");
  }
});

test("options turn into the flags the node's browser reads", async () => {
  const b = node().browser({ site: "shop.example" });
  await b.snapshot();
  assert.deepEqual(lastDo(), ["snapshot"], "no option, no flag");
  await b.snapshot({ interactive: true, compact: true, depth: 0, selector: "main" });
  assert.deepEqual(lastDo(), ["snapshot", "-i", "-c", "-d", "0", "-s", "main"], "a depth of 0 is still a depth");
  await b.scroll("up");
  assert.deepEqual(lastDo(), ["scroll", "up"]);
  await b.scroll("left", 0, { selector: ".rail" });
  assert.deepEqual(lastDo(), ["scroll", "left", "0", "--selector", ".rail"]);
  await b.wait("#done");
  assert.deepEqual(lastDo(), ["wait", "#done"]);
  await b.wait({ url: "**/cart", timeoutMs: 2000 });
  assert.deepEqual(lastDo(), ["wait", "--url", "**/cart", "--timeout", "2000"]);
  await b.wait({ load: "networkidle" });
  assert.deepEqual(lastDo(), ["wait", "--load", "networkidle"]);
  await b.wait({ fn: "window.ready" });
  assert.deepEqual(lastDo(), ["wait", "--fn", "window.ready"]);
  await b.screenshot();
  assert.deepEqual(lastDo(), ["screenshot"]);
  await b.screenshot({ path: "/tmp/p.png", full: true, annotate: true });
  assert.deepEqual(lastDo(), ["screenshot", "/tmp/p.png", "--full", "--annotate"]);
  await b.find("text", "Add to cart", "click");
  assert.deepEqual(lastDo(), ["find", "text", "Add to cart", "click"]);
});

test("a request that asks the owner waits 30 s longer than the ask, and an ask is never waited on past 30 minutes", async () => {
  const limits = [];
  const real = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => (limits.push(ms), real.call(AbortSignal, ms));
  try {
    const b = node().browser({ site: "shop.example" });
    await b.askOwner("pass the check");
    await b.askOwner("pass the check", { timeoutS: 600 });
    await b.askOwner("pass the check", { timeoutS: 99999 });
    assert.deepEqual(lastDo(), ["ask_owner", "pass the check", "--timeout", "99999"], "the node is told what was asked, and it decides its own limit");
  } finally {
    AbortSignal.timeout = real;
  }
  // Each request first proves the node (its own wait), then asks: the ask's wait is the one after each proof.
  assert.ok(limits.includes(330_000), "the default ask of 5 minutes is waited on for 330 s");
  assert.ok(limits.includes(630_000), "600 s is waited on for 630 s");
  assert.ok(limits.includes(1_830_000), "past 1800 s the wait stays at 1830 s");
  assert.ok(!limits.includes(100_029_000), "the asked 99999 s is not waited out");
});

test("a browser opened on a goal remembers the route the node found for it, and a reply without one keeps it", async () => {
  const b = node().browser({ site: "" });
  await b.open("https://shop.example/a", { goal: "reload" });
  assert.equal(b.goal, "reload");
  assert.equal(b.site, "shop.example", "the node names the site on the first page");
  assert.equal(b.routeForGoal, null, "no route for this goal on open: none is remembered");
  const r = await b.reload();
  assert.equal(r.routeForGoal.routeId, "reload-goal");
  assert.equal(b.routeForGoal.routeId, "reload-goal");
  await b.back();
  assert.equal(b.routeForGoal.routeId, "reload-goal", "a later step that finds none leaves the one found");
  await b.open("https://shop.example/b");
  assert.equal(b.routeForGoal, null, "opening a new page starts the question again");
});
