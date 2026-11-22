// The `unbrowse` command's edges: its help, `where`, opening the app through the system's `open`, a skill that can't be
// written, programs whose mode can't be changed, the signing team as a Mac reads it, and `unbrowse mcp` with a token in
// the environment, against a fake node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appBundle, newestApp, onlyOursAt, oldCopyAt, passedOver, teamOf } from "../dist/cli.js";
import { fakeNode, json } from "./fake-node.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmp = (what) => mkdtempSync(join(tmpdir(), `unbrowse-${what}-`));

/** The environment for the command with no Unbrowse variable of the machine's own in it. */
function clean(extra = {}) {
  const env = { ...process.env };
  for (const k of ["UNBROWSE_BIN", "UNBROWSE_APP", "UNBROWSE_UNCHECKED_APP", "UNBROWSE_AGENT_TOKEN", "UNBROWSE_NODE"]) delete env[k];
  return { ...env, ...extra };
}

/** An app the command can open: the window's file is there, which is all it looks for. */
function app() {
  const a = join(tmp("app"), "Unbrowse.app");
  mkdirSync(join(a, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(a, "Contents", "MacOS", "unbrowse-window"), "#!/bin/sh\n", { mode: 0o755 });
  return a;
}

test("help, with or without a flag, lists what the command does and exits 0", () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const r = spawnSync(process.execPath, [cli, ...args], { env: clean() });
    assert.equal(r.status, 0, `unbrowse ${args.join(" ")}`);
    const out = r.stdout.toString();
    assert.match(out, /^usage: unbrowse app \| unbrowse start/);
    for (const word of ["unbrowse mcp", "unbrowse browser install", "unbrowse share used", "unbrowse restart"]) assert.ok(out.includes(word), `${word} is listed`);
  }
});

test("where says the folder the programs are in, or that they're looked up on PATH", () => {
  const bin = tmp("bin");
  assert.equal(spawnSync(process.execPath, [cli, "where"], { env: clean({ UNBROWSE_BIN: bin }) }).stdout.toString().trim(), bin);
  assert.equal(spawnSync(process.execPath, [cli, "where"], { env: clean({ UNBROWSE_BIN: "" }) }).stdout.toString().trim(), "on PATH", "nothing named and no platform package beside this one");
});

test("unbrowse app opens an app through the system's `open`, and says so when it can't", () => {
  const a = app();
  const toolbox = tmp("path");
  const said = join(toolbox, "said");
  writeFileSync(join(toolbox, "open"), `#!/bin/sh\necho "$@" > "${said}"\nexit 4\n`, { mode: 0o755 });
  // The unchecked variable is how a build of one's own runs; it is the way to name an app on a machine with no Team ID.
  const env = clean({ UNBROWSE_UNCHECKED_APP: a, PATH: toolbox });
  const r = spawnSync(process.execPath, [cli, "app"], { env });
  assert.equal(r.status, 4, "the exit code of `open` is the command's");
  assert.equal(readFileSync(said, "utf8").trim(), a);
  assert.match(r.stderr.toString(), /signature checks are OFF/, "an unchecked app is never run quietly");

  const none = spawnSync(process.execPath, [cli, "app"], { env: clean({ UNBROWSE_UNCHECKED_APP: a, PATH: tmp("empty") }) });
  assert.equal(none.status, 1);
  assert.match(none.stderr.toString(), new RegExp(`can't open ${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("a skill that can't be written is said, and the install still ends well", () => {
  const home = tmp("home");
  mkdirSync(join(home, ".claude"));
  // `skills` is a file, so nothing can be put inside it.
  writeFileSync(join(home, ".claude", "skills"), "not a folder");
  const r = spawnSync(process.execPath, [cli, "postinstall"], { env: clean({ HOME: home, npm_config_global: "true" }) });
  assert.equal(r.status, 0, "an install never fails for the skill");
  assert.match(r.stderr.toString(), /the skill wasn't put in ~\/\.claude\/skills\/unbrowse \(.+\); `unbrowse skill` does it\./);
});

test("a program whose mode can't be changed still runs with the mode it came with", { skip: (process.getuid?.() === 0 && "root can change any mode") || (!["/bin/true", "/usr/bin/true"].some((p) => existsSync(p)) && "no `true` program here") }, () => {
  const bin = tmp("bin");
  // A link to a program this user doesn't own: chmod is refused, and the program runs as it is.
  symlinkSync(["/bin/true", "/usr/bin/true"].find((p) => existsSync(p)), join(bin, "unb"));
  const r = spawnSync(process.execPath, [cli, "whoami"], { env: clean({ UNBROWSE_BIN: bin }) });
  assert.equal(r.status, 0, r.stderr.toString());
});

test("an app's team is none off a Mac, and none for an app the system's codesign can't verify", () => {
  const a = app();
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    if (process.platform !== "darwin") assert.equal(teamOf(a), undefined, "only a Mac has a team to read");
    Object.defineProperty(process, "platform", { value: "darwin" });
    assert.equal(teamOf(a), undefined, "a fake app has no signature that verifies");
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("on a Mac an app installed in the owner's Applications isn't run when the package names no team to hold it to", () => {
  const home = tmp("home");
  const installed = join(home, "Applications", "Unbrowse.app");
  mkdirSync(join(installed, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(installed, "Contents", "MacOS", "unbrowse-window"), "");
  const env = { ...process.env };
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    for (const k of ["UNBROWSE_APP", "UNBROWSE_UNCHECKED_APP"]) delete process.env[k];
    process.env.HOME = home;
    Object.defineProperty(process, "platform", { value: "darwin" });
    assert.equal(newestApp([installed]), installed, "it is an app");
    assert.equal(appBundle(), undefined, "anybody can put a folder there: with no team named it never runs");
    assert.match(passedOver(), /is there, but this package names no signing team to check it against, so it isn't run/);
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.env.HOME = env.HOME;
  }
});

test("a skill folder that isn't there holds nothing of ours to keep, and no old copy", () => {
  const gone = join(tmp("none"), "skills", "unbrowse");
  assert.equal(onlyOursAt(gone), true, "nothing there: the install may write");
  assert.equal(oldCopyAt(gone), false, "no folder, no older copy of the skill");
});

test("unbrowse mcp with a token in the environment relays a message to the node, signed, and writes the answer", async () => {
  const TOKEN = ["mcp", "env", Date.now().toString(36)].join("-");
  const heard = [];
  const fake = await fakeNode({
    tokens: [TOKEN],
    handler: (req, res, body) => {
      heard.push({ url: req.url, authorization: req.headers.authorization, body });
      json(res, 200, { jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    },
  });
  try {
    const child = spawn(process.execPath, [cli, "mcp"], { env: clean({ UNBROWSE_AGENT_TOKEN: TOKEN, UNBROWSE_NODE: fake.base }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" })}\n`);
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0, "the bridge ends cleanly when the agent closes its end");
    assert.deepEqual(JSON.parse(out), { jsonrpc: "2.0", id: 5, result: { tools: [] } });
    assert.equal(heard.length, 1);
    assert.equal(heard[0].url, "/mcp");
    assert.equal(heard[0].authorization, `Bearer ${TOKEN}`, "the node's own check, on a request signed with the token");
  } finally {
    fake.close();
  }
});
