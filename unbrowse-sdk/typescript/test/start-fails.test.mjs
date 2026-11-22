// A node the client started that can't give a key, and a script that ends without closing it, against the stub node.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Unbrowse, UnbrowseError } from "../dist/index.js";
import { STUB, TOKEN, answers, freePort } from "./stub-node.mjs";

let dir;
let program;
let keyless;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "unbrowse-start-fails-"));
  program = join(dir, "unbrowse-node");
  writeFileSync(program, STUB);
  chmodSync(program, 0o755);
  // A node whose `agent token` fails for good: exit 2, not the 3 that means "try again, the key isn't made yet".
  keyless = join(dir, "keyless-node");
  writeFileSync(keyless, STUB.replace("process.exit(3)", "process.exit(2)"));
  chmodSync(keyless, 0o755);
});

after(() => rmSync(dir, { recursive: true, force: true }));

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("a node that can't give an agent key is stopped, and start says what it said", async () => {
  const port = await freePort();
  const home = join(dir, "keyless-home");
  await assert.rejects(
    Unbrowse.start({ program: keyless, home, port, env: { STUB_TOKEN: TOKEN } }),
    (e) => e instanceof UnbrowseError && e.status === 401 && e.code === "unauthorized" && /couldn't get an agent token from the node: no live agent key yet/.test(e.message),
  );
  await until(async () => !(await answers(port)));
  assert.match(readFileSync(join(home, "stub.log"), "utf8"), /stopped/, "the node this start began did not keep running");
});

test("a script that ends without closing the node it started doesn't leave it running", async () => {
  const port = await freePort();
  const home = join(dir, "forgotten-home");
  const script = join(dir, "forgets-to-close.mjs");
  writeFileSync(
    script,
    `import { Unbrowse } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};\n` +
      `await Unbrowse.start({ program: ${JSON.stringify(program)}, home: ${JSON.stringify(home)}, port: ${port}, env: { STUB_TOKEN: ${JSON.stringify(TOKEN)} } });\n` +
      `console.log("started");\nprocess.exit(0);\n`,
  );
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  assert.equal(await new Promise((r) => child.on("close", r)), 0);
  assert.match(out, /started/);
  await until(async () => !(await answers(port)));
  assert.match(readFileSync(join(home, "stub.log"), "utf8"), /stopped/);
});

test("a client disposed with `await using` stops the node it started, as close() does", async () => {
  const port = await freePort();
  const home = join(dir, "disposed-home");
  const node = new Unbrowse({ autoStart: { program, home, port, env: { STUB_TOKEN: TOKEN } } });
  await node.whoami();
  assert.equal(await answers(port), true, "its first request started the node");
  await node[Symbol.asyncDispose]();
  assert.equal(await answers(port), false, "disposing stopped it");
  assert.match(readFileSync(join(home, "stub.log"), "utf8"), /stopped/);
});
