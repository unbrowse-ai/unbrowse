// A client's node going away, against the stub `unbrowse-node`: closed, crashed, stopped by another client, or lost in a
// race to start. The same as the Python package's tests/test_start.py.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Unbrowse, NodeConnectionError } from "../dist/index.js";
import { STUB, TOKEN, answers, freePort } from "./stub-node.mjs";

let dir;
let program;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "unbrowse-gone-"));
  program = join(dir, "unbrowse-node");
  writeFileSync(program, STUB);
  chmodSync(program, 0o755);
});

after(() => rmSync(dir, { recursive: true, force: true }));

const home = (name) => join(dir, name);

// Most of these name the token: reading one means running the program until its first key exists, which isn't what
// they check, and --test-timeout covers the whole file. The one through `start` reads it, each time it brings a node.
const started = (h) => readFileSync(join(h, "stub.log"), "utf8").match(/started/g).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Crashes the stub on `port` and waits until the process that started it can tell. */
async function crash(port) {
  await fetch(`http://127.0.0.1:${port}/die`).catch(() => {});
  while (await answers(port)) await sleep(20);
  await sleep(100);
}

test("after close, the next request starts the node again, and close stops that one too", async () => {
  const port = await freePort();
  const h = home("reopened");
  const node = new Unbrowse({ autoStart: { program, home: h, port, token: TOKEN, env: { STUB_TOKEN: TOKEN } } });
  await node.whoami();
  await node.close();
  assert.equal(await answers(port), false);
  assert.equal((await node.whoami()).node, "stub");
  assert.equal(started(h), 2);
  await node.close();
  assert.equal(await answers(port), false);
});

test("a node this client started that dies is started again before the next request goes", async () => {
  const port = await freePort();
  const h = home("crashed");
  const node = new Unbrowse({ autoStart: { program, home: h, port, token: TOKEN, env: { STUB_TOKEN: TOKEN } } });
  await node.whoami();
  await crash(port);
  assert.equal((await node.whoami()).node, "stub", "the request itself never sees the dead node");
  assert.equal(started(h), 2);
  await node.close();
  assert.equal(await answers(port), false);
});

test("a client whose node another client stopped says so once, then brings its own", async () => {
  const port = await freePort();
  const h = home("shared");
  const opts = { program, home: h, port, env: { STUB_TOKEN: TOKEN } };
  const first = await Unbrowse.start(opts);
  const second = await Unbrowse.start({ ...opts, token: TOKEN });
  await first.close();
  assert.equal(await answers(port), false);
  await assert.rejects(second.whoami(), NodeConnectionError, "a request that found no node is answered as it failed, never sent twice");
  assert.equal((await second.whoami()).node, "stub");
  assert.equal(started(h), 2);
  await second.close();
  assert.equal(await answers(port), false, "the node it brought back is its own to stop");
});

// What a node that lost the port leaves behind, every time: another's node answering, and its own process gone. Two real
// starters can't show this, since which of them loses is a coin toss.
const LOSER = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const net = require("node:net");
spawn(process.env.STUB_PROGRAM, [], { detached: true, stdio: "ignore" }).unref();
const up = () => net.connect(Number(process.env.UNBROWSE_PORT), "127.0.0.1").on("connect", () => process.exit(1)).on("error", () => setTimeout(up, 20));
up();
`;

test("a client whose node lost the port uses the winner's, and brings one when that goes", async () => {
  const port = await freePort();
  const loser = join(dir, "losing-node");
  writeFileSync(loser, LOSER);
  chmodSync(loser, 0o755);
  const node = new Unbrowse({ autoStart: { program: loser, home: home("race"), port, token: TOKEN, env: { STUB_TOKEN: TOKEN, STUB_PROGRAM: program } } });
  assert.equal((await node.whoami()).node, "stub");
  await crash(port);
  // A dead process counted as this client's node would hold it here for good.
  assert.equal((await node.whoami().catch(() => node.whoami())).node, "stub");
  await crash(port);
});

test("close during a start stops the node that start brings", async () => {
  const port = await freePort();
  const node = new Unbrowse({ autoStart: { program, home: home("closing"), port, token: TOKEN, env: { STUB_TOKEN: TOKEN } } });
  const first = node.whoami().catch(() => {});
  await sleep(50);
  await node.close();
  await first;
  assert.equal(await answers(port), false);
});
