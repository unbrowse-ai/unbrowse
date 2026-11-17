// Starting the node for a client (`Unbrowse.start`, `autoStart`), against a stub `unbrowse-node`: a small program that
// answers as the node does (the proof, whoami with no browser) on UNBROWSE_PORT, and `agent token` as the node's CLI
// does, exiting 3 until its first key is made.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Unbrowse, NodeConnectionError } from "../dist/index.js";
import { STUB, TOKEN, answers, freePort } from "./stub-node.mjs";

let dir;
let program;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "unbrowse-start-"));
  program = join(dir, "unbrowse-node");
  writeFileSync(program, STUB);
  chmodSync(program, 0o755);
});

after(() => rmSync(dir, { recursive: true, force: true }));

const home = (name) => {
  const h = join(dir, name);
  rmSync(h, { recursive: true, force: true });
  return h;
};

test("start runs the node with no browser, waits for it, reads its token, and close stops it", async () => {
  const port = await freePort();
  const h = home("fresh");
  const node = await Unbrowse.start({ program, home: h, port, env: { STUB_TOKEN: TOKEN, UNBROWSE_BROWSER: join(dir, "nowhere") } });
  assert.equal(node.baseUrl, `http://127.0.0.1:${port}`);
  const who = await node.whoami();
  assert.equal(who.node, "stub");
  assert.deepEqual(await node.capabilities(), { browser: "missing", fetchesBrowser: true, browserOption: true });
  assert.match(readFileSync(join(h, "stub.log"), "utf8"), /started .*nowhere/, "the node got the environment it was given");
  await node.close();
  assert.equal(await answers(port), false, "close stopped the node it started");
  assert.match(readFileSync(join(h, "stub.log"), "utf8"), /stopped/);
  await node.close();
});

test("a named agent token is used even when a home is set", async () => {
  const port = await freePort();
  const h = home("environment-home");
  const names = ["UNBROWSE_HOME", "UNBROWSE_PORT", "UNBROWSE_AGENT_TOKEN", "STUB_TOKEN"];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    // The caller named a narrow key of its own: a home in the environment never swaps in the node's first key.
    Object.assign(process.env, { UNBROWSE_HOME: h, UNBROWSE_PORT: String(port), UNBROWSE_AGENT_TOKEN: "a-narrow-key", STUB_TOKEN: TOKEN });
    const node = await Unbrowse.start({ program });
    await assert.rejects(node.whoami(), (e) => e.status === 401, "the named key is the one sent, and this node doesn't hold it");
    await node.close();
    // Named nothing: the node this process started gives its own key.
    delete process.env.UNBROWSE_AGENT_TOKEN;
    const own = await Unbrowse.start({ program });
    assert.equal((await own.whoami()).node, "stub");
    await own.close();
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
});

test("start uses a node that is running already, and close leaves it running", async () => {
  const port = await freePort();
  const h = home("running");
  const first = await Unbrowse.start({ program, home: h, port, env: { STUB_TOKEN: TOKEN } });
  // A node this process didn't start gives no key of its own: the caller names one.
  await assert.rejects(Unbrowse.start({ program, home: h, port, env: { STUB_TOKEN: TOKEN } }), (e) => /only a node this process starts gives its own key/.test(e.message));
  const second = await Unbrowse.start({ program, home: h, port, token: TOKEN, env: { STUB_TOKEN: TOKEN } });
  assert.equal((await second.whoami()).node, "stub");
  assert.equal(readFileSync(join(h, "stub.log"), "utf8").match(/started/g).length, 1, "only one node was started");
  await second.close();
  assert.equal(await answers(port), true, "a node the client didn't start keeps running");
  await first.close();
  assert.equal(await answers(port), false);
});

test("autoStart starts the node on the first request", async () => {
  const port = await freePort();
  const h = home("auto");
  const node = new Unbrowse({ autoStart: { program, home: h, port, env: { STUB_TOKEN: TOKEN } } });
  assert.equal(await answers(port), false, "nothing starts before a request");
  assert.equal((await node.whoami()).agent, "agent");
  assert.ok(existsSync(join(h, "stub.log")));
  await node.close();
  assert.equal(await answers(port), false);
});

test("with no node running and no node program, start says how to get one", async () => {
  const port = await freePort();
  const was = process.env.UNBROWSE_BIN;
  process.env.UNBROWSE_BIN = join(dir, "no-such-folder");
  try {
    await assert.rejects(Unbrowse.start({ home: home("none"), port }), (e) => e instanceof NodeConnectionError && /npm install -g unbrowse/.test(e.message) && /UNBROWSE_BIN/.test(e.message));
  } finally {
    if (was === undefined) delete process.env.UNBROWSE_BIN;
    else process.env.UNBROWSE_BIN = was;
  }
});

test("a node that exits before it answers is said, with what it wrote", async () => {
  const port = await freePort();
  const broken = join(dir, "broken-node");
  writeFileSync(broken, `#!/usr/bin/env node\nconsole.error("settings written by a newer node");\nprocess.exit(1);\n`);
  chmodSync(broken, 0o755);
  await assert.rejects(Unbrowse.start({ program: broken, home: home("broken"), port, readyTimeoutMs: 10_000 }), (e) => e instanceof NodeConnectionError && /newer node/.test(e.message));
});
