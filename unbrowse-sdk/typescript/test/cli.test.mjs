// The `unbrowse` command: which program each command goes to, that it runs the programs it finds with the caller's
// arguments and exit code, and that it puts the skill where it's asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { route, platformPackage, appBundle, binDir, newestApp, appVersion, trustedApp, teamOf, pinnedTeam, namedApp, uncheckedApp, oldCopyAt, onlyOursAt } from "../dist/cli.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("start and the node's own commands go to the node; the rest to unb", () => {
  assert.deepEqual(route(["start"]), { program: "unbrowse-node", args: [] });
  // The install line's source tag reaches the node as it was typed: `unbrowse-node --from <tag>` starts it with the tag.
  assert.deepEqual(route(["start", "--from", "hn-e"]), { program: "unbrowse-node", args: ["--from", "hn-e"] });
  assert.deepEqual(route(["start", "--from=hn-e"]), { program: "unbrowse-node", args: ["--from=hn-e"] });
  assert.deepEqual(route(["wallet", "show"]), { program: "unbrowse-node", args: ["wallet", "show"] });
  // Bounties and route coins are the owner's, signed by the node's key: `unbrowse bounty post shop.example 2000`.
  assert.deepEqual(route(["bounty", "post", "shop.example", "2000"]), { program: "unbrowse-node", args: ["bounty", "post", "shop.example", "2000"] });
  assert.deepEqual(route(["coin", "stake", "0xE", "60"]), { program: "unbrowse-node", args: ["coin", "stake", "0xE", "60"] });
  // Imports run on the node from a shell, with no window: passwords under vault, cookies under session, passkeys under passkey.
  assert.deepEqual(route(["vault", "import", "export.csv"]), { program: "unbrowse-node", args: ["vault", "import", "export.csv"] });
  assert.deepEqual(route(["session", "import", "github.com", "--from", "cookies.txt"]), {
    program: "unbrowse-node",
    args: ["session", "import", "github.com", "--from", "cookies.txt"],
  });
  assert.deepEqual(route(["terms", "accept"]), { program: "unbrowse-node", args: ["terms", "accept"] });
  // The browser add-on is the node's to fetch and keep.
  assert.deepEqual(route(["browser", "install"]), { program: "unbrowse-node", args: ["browser", "install"] });
  assert.deepEqual(route(["browser", "remove", "--chromium"]), { program: "unbrowse-node", args: ["browser", "remove", "--chromium"] });
  assert.deepEqual(route(["network", "off"]), { program: "unbrowse-node", args: ["network", "off"] });
  assert.deepEqual(route(["share", "used"]), { program: "unbrowse-node", args: ["share", "used"] });
  assert.deepEqual(route(["sign-in"]), { program: "unbrowse-node", args: ["sign-in"] });
  // Which chain the node runs on, and deploying the shared contracts to it, are the node's.
  assert.deepEqual(route(["chain", "arc-testnet"]), { program: "unbrowse-node", args: ["chain", "arc-testnet"] });
  assert.deepEqual(route(["chain", "deploy"]), { program: "unbrowse-node", args: ["chain", "deploy"] });
  assert.deepEqual(route(["passkey", "import", "bitwarden.json"]), { program: "unbrowse-node", args: ["passkey", "import", "bitwarden.json"] });
  assert.deepEqual(route(["passkey", "list"]), { program: "unbrowse-node", args: ["passkey", "list"] });
  assert.deepEqual(route(["session", "import", "github.com"]), { program: "unbrowse-node", args: ["session", "import", "github.com"] });
  assert.deepEqual(route(["telemetry", "off"]), { program: "unbrowse-node", args: ["telemetry", "off"] });
  assert.deepEqual(route(["reports", "off"]), { program: "unbrowse-node", args: ["reports", "off"] });
  // The commands the node tells its owner to run.
  assert.deepEqual(route(["update"]), { program: "unbrowse-node", args: ["update"] });
  assert.deepEqual(route(["update", "channel", "canary"]), { program: "unbrowse-node", args: ["update", "channel", "canary"] });
  assert.deepEqual(route(["restart"]), { program: "unbrowse-node", args: ["restart"] });
  // The most the node pays to fetch one route is the owner's setting, shown or set on the node.
  assert.deepEqual(route(["max-fetch"]), { program: "unbrowse-node", args: ["max-fetch"] });
  assert.deepEqual(route(["max-fetch", "0.1"]), { program: "unbrowse-node", args: ["max-fetch", "0.1"] });
  assert.deepEqual(route(["domain", "status", "shop.example"]), { program: "unbrowse-node", args: ["domain", "status", "shop.example"] });
  assert.deepEqual(route(["do", "search", "--url", "https://x.test"]), {
    program: "unb",
    args: ["do", "search", "--url", "https://x.test"],
  });
  assert.equal(platformPackage("darwin", "arm64"), "@unbrowse/darwin-arm64");
});

test("runs the program it finds, with the caller's arguments and exit code", () => {
  const bin = mkdtempSync(join(tmpdir(), "unbrowse-bin-"));
  const said = join(bin, "said");
  for (const p of ["unbrowse-node", "unb"]) {
    writeFileSync(join(bin, p), `#!/bin/sh\necho "${p} $*" > "${said}"\nexit 3\n`, { mode: 0o644 });
  }
  const r = spawnSync(process.execPath, [cli, "do", "search", "hn"], { env: { ...process.env, UNBROWSE_BIN: bin } });
  assert.equal(r.status, 3);
  assert.equal(readFileSync(said, "utf8").trim(), "unb do search hn");
  spawnSync(process.execPath, [cli, "start"], { env: { ...process.env, UNBROWSE_BIN: bin } });
  assert.equal(readFileSync(said, "utf8").trim(), "unbrowse-node");
});

// The install line `npx unbrowse start --from hn-e` reaches the node as it was typed: the program run is unbrowse-node and
// it is given every word after `start`, the source tag in either spelling included, and nothing else.
test("start passes every word after it to the node, the source tag included", () => {
  const bin = mkdtempSync(join(tmpdir(), "unbrowse-bin-"));
  const said = join(bin, "said");
  for (const p of ["unbrowse-node", "unb"]) {
    writeFileSync(join(bin, p), `#!/bin/sh\nprintf '%s|' "${p}" "$@" > "${said}"\n`, { mode: 0o755 });
  }
  const env = { ...process.env, UNBROWSE_BIN: bin };
  for (const [words, got] of [
    [["start", "--from", "hn-e"], "unbrowse-node|--from|hn-e|"],
    [["start", "--from=hn-e"], "unbrowse-node|--from=hn-e|"],
    [["start", "--from", "Not A Tag"], "unbrowse-node|--from|Not A Tag|"],
  ]) {
    const r = spawnSync(process.execPath, [cli, ...words], { env });
    assert.equal(r.status, 0, r.stderr.toString());
    assert.equal(readFileSync(said, "utf8"), got, words.join(" "));
  }
});

// The node's own source, read as the shipped programs are built from it: the first words `unbrowse-node` runs a command
// for (its `main`), the words its usage line names, and the commands `unb` knows.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const nodeMain = readFileSync(join(repo, "unbrowse-node/app/src/main.rs"), "utf8");
const mainBody = nodeMain.slice(nodeMain.indexOf("\nfn main() {"), nodeMain.indexOf("\n}\n", nodeMain.indexOf("\nfn main() {")));
const nodeRuns = [...new Set([...mainBody.matchAll(/args\.get\(1\)\.map\(String::as_str\) == Some\("([a-z-]+)"\)/g)].map((m) => m[1]))];
const usageNames = new Set(
  [...nodeMain.match(/const NODE_COMMAND_WORDS: \[&str; \d+\] = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1].split(" ")[0]),
);
const unbKnows = new Set([...readFileSync(join(repo, "unbrowse-node/app/src/bin/unb.rs"), "utf8").matchAll(/Some\("([a-z]+)"\)/g)].map((m) => m[1]));

// `unbrowse` is the one command an owner has: every command the node runs is reached through it, and its usage line
// names each one. A node command sent to unb instead fails there as a command unb doesn't have.
test("every command the node runs is reached through unbrowse and named in its usage", () => {
  assert.ok(nodeRuns.length > 20, `read the node's commands: ${nodeRuns}`);
  assert.deepEqual(nodeRuns.filter((w) => route([w]).program !== "unbrowse-node"), [], "node commands `unbrowse` sends to unb");
  assert.deepEqual(nodeRuns.filter((w) => !usageNames.has(w)), [], "node commands its usage line leaves out");
});

// The docs name the programs that are built (`unbrowse`, `unbrowse-node`, `unb`) and only commands those programs have:
// `unbrowse <word>` reaches a program that runs <word>, as `unbrowse-node <word>` and `unb <word>` do. Old skills kept as
// test fixtures are left out: they are kept to test that an install replaces them.
test("the docs name only commands the built programs have", () => {
  const own = new Set(["app", "start", "where", "skill", "help", "mcp", "postinstall"]);
  const has = { "unbrowse-node": (w) => nodeRuns.includes(w), unb: (w) => unbKnows.has(w) };
  has.unbrowse = (w) => own.has(w) || has[route([w]).program](w);
  const docs = spawnSync("git", ["ls-files", "*.md"], { cwd: repo, encoding: "utf8" })
    .stdout.split("\n")
    .filter((f) => f && !/^unbrowse-browser\/|\/test\/fixtures\/|CHANGELOG/.test(f));
  assert.ok(docs.length > 20, `found the docs: ${docs.length}`);
  const wrong = [];
  for (const f of docs) {
    readFileSync(join(repo, f), "utf8").split("\n").forEach((line, i) => {
      for (const [, program, word] of line.matchAll(/`(unbrowse-node|unbrowse|unb) ([a-z][a-z-]*)/g)) {
        if (!has[program](word)) wrong.push(`${f}:${i + 1} ${program} ${word}`);
      }
    });
  }
  assert.deepEqual(wrong, []);
});

test("puts the skill where it's asked", () => {
  const to = join(mkdtempSync(join(tmpdir(), "unbrowse-skill-")), "skills", "unbrowse");
  const r = spawnSync(process.execPath, [cli, "skill", to]);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(readFileSync(join(to, "SKILL.md"), "utf8"), /^---\nname: unbrowse\n/);
});

test("replaces an earlier skill of the same name whole", () => {
  const to = join(mkdtempSync(join(tmpdir(), "unbrowse-skill-")), "skills", "unbrowse");
  mkdirSync(join(to, "references"), { recursive: true });
  writeFileSync(join(to, "references", "old.md"), "an earlier skill's page");
  assert.equal(spawnSync(process.execPath, [cli, "skill", to]).status, 0);
  assert.ok(!existsSync(join(to, "references")));
  assert.ok(existsSync(join(to, "SKILL.md")));
});

const keptIn = (to) => join(dirname(dirname(to)), "unbrowse-kept");
const asides = (to) => {
  // Never in the skills folder itself, where the agent would load it as a second skill.
  assert.deepEqual(readdirSync(dirname(to)).filter((n) => n.includes(".before-unbrowse-")), [], "nothing kept in the skills folder");
  return existsSync(keptIn(to)) ? readdirSync(keptIn(to)).filter((n) => n.startsWith(`${basename(to)}.before-unbrowse-`)) : [];
};
/** A skill's place under a skills folder of its own, so what is kept lands in the scratch folder too. */
const skillAt = () => {
  const to = join(mkdtempSync(join(tmpdir(), "unbrowse-skill-")), "skills", "unbrowse");
  mkdirSync(dirname(to), { recursive: true });
  return to;
};
const newSkill = (to) => assert.match(readFileSync(join(to, "SKILL.md"), "utf8"), /^---\nname: unbrowse\n/);

test("an install replaces its own unchanged copy, and moves anything else aside, never deleting it", () => {
  const home = mkdtempSync(join(tmpdir(), "unbrowse-home-"));
  const to = join(home, ".claude", "skills", "unbrowse");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const install = () => spawnSync(process.execPath, [cli, "postinstall"], { env: { ...process.env, HOME: home, npm_config_global: "true" } });
  assert.equal(install().status, 0);
  assert.ok(existsSync(join(to, "SKILL.md")), "nothing there: the skill goes in");
  assert.equal(install().status, 0);
  newSkill(to);
  assert.deepEqual(asides(to), [], "its own copy, untouched: replaced, nothing kept");
  // The owner's edit, or a page they added, is theirs: kept beside, as it was, and the new skill goes in.
  writeFileSync(join(to, "SKILL.md"), "the owner's own words");
  const r = install();
  assert.equal(r.status, 0, "an install never fails for it");
  const [kept] = asides(to);
  assert.match(kept, /^unbrowse\.before-unbrowse-\d{14}$/);
  assert.match(r.stderr.toString(), /kept what was at .*\.claude\/skills\/unbrowse as .*\.claude\/unbrowse-kept\/unbrowse\.before-unbrowse-\d{14}, as it was/);
  assert.equal(readFileSync(join(keptIn(to), kept, "SKILL.md"), "utf8"), "the owner's own words");
  newSkill(to);
  // The owner's own command does the same.
  writeFileSync(join(to, "SKILL.md"), "edited again");
  assert.equal(spawnSync(process.execPath, [cli, "skill", to]).status, 0);
  newSkill(to);
  assert.equal(asides(to).length, 2, "the second edit is kept too");
});

test("an older Unbrowse's skill, as it was published, is replaced (R-I3); an edited one is moved aside", () => {
  const old = fileURLToPath(new URL("fixtures/skill-12.5.0", import.meta.url));
  const to = skillAt();
  cpSync(old, to, { recursive: true });
  assert.ok(oldCopyAt(to), "the 12.5.0 copy is known by its hashes");
  assert.ok(!onlyOursAt(to), "it has no record of an install's");
  assert.equal(spawnSync(process.execPath, [cli, "skill", to]).status, 0);
  newSkill(to);
  assert.deepEqual(asides(to), [], "the old copy was ours: replaced, nothing kept");
  assert.ok(!existsSync(join(to, "references", "tools.json")), "no file the old copy left reads as part of the new one");
  // The same old copy with the owner's line added is theirs.
  rmSync(to, { recursive: true });
  cpSync(old, to, { recursive: true });
  writeFileSync(join(to, "SKILL.md"), readFileSync(join(to, "SKILL.md"), "utf8") + "\nmy own rule\n");
  assert.ok(!oldCopyAt(to));
  assert.equal(spawnSync(process.execPath, [cli, "skill", to]).status, 0);
  const [kept] = asides(to);
  assert.match(readFileSync(join(keptIn(to), kept, "SKILL.md"), "utf8"), /my own rule\n$/);
  assert.ok(existsSync(join(keptIn(to), kept, "references", "tools.json")));
  newSkill(to);
  // A page the owner added beside an unchanged old copy is theirs too.
  rmSync(to, { recursive: true });
  cpSync(old, to, { recursive: true });
  writeFileSync(join(to, "notes.md"), "mine");
  assert.ok(!oldCopyAt(to));
});

test("a link to the owner's own skill is moved aside; what it points at is untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "unbrowse-skill-"));
  const mine = join(dir, "my-checkout");
  mkdirSync(mine);
  writeFileSync(join(mine, "SKILL.md"), "my checkout's skill");
  const to = join(dir, "skills", "unbrowse");
  mkdirSync(dirname(to));
  symlinkSync("../my-checkout", to);
  assert.equal(spawnSync(process.execPath, [cli, "skill", to]).status, 0);
  assert.ok(!lstatSync(to).isSymbolicLink());
  newSkill(to);
  const [kept] = asides(to);
  assert.ok(lstatSync(join(keptIn(to), kept)).isSymbolicLink());
  assert.equal(readFileSync(join(keptIn(to), kept, "SKILL.md"), "utf8"), "my checkout's skill", "a relative link still points at it");
  assert.equal(readFileSync(join(mine, "SKILL.md"), "utf8"), "my checkout's skill");
  assert.deepEqual(readdirSync(mine), ["SKILL.md"]);
});

test("a missing program is said plainly", () => {
  const r = spawnSync(process.execPath, [cli, "whoami"], { env: { ...process.env, UNBROWSE_BIN: join(tmpdir(), "nowhere") } });
  assert.equal(r.status, 127);
  assert.match(r.stderr.toString(), /can't run unb/);
  assert.ok(!existsSync(join(tmpdir(), "nowhere")));
});

/** A stand-in Unbrowse.app: the window and the programs in Contents/MacOS, each writing what it was run with. */
function fakeApp() {
  const app = join(mkdtempSync(join(tmpdir(), "unbrowse-app-")), "Unbrowse.app");
  const bin = join(app, "Contents", "MacOS");
  mkdirSync(bin, { recursive: true });
  const said = join(app, "said");
  for (const p of ["unbrowse-window", "unbrowse-node", "unb"]) {
    writeFileSync(join(bin, p), `#!/bin/sh\necho "${p} $*" > "${said}"\nexit 3\n`, { mode: 0o644 });
  }
  return { app, bin, said };
}

/** The environment for running the command with no programs to find but those a test names: none on PATH. */
function bare(extra) {
  const env = { ...process.env, PATH: "", ...extra };
  delete env.UNBROWSE_BIN;
  delete env.UNBROWSE_APP;
  delete env.UNBROWSE_UNCHECKED_APP;
  return { ...env, ...extra };
}

test("the programs run from inside the app, an unchecked one only by the loud opt-in that says so on every run", () => {
  const { app, bin, said } = fakeApp();
  process.env.UNBROWSE_UNCHECKED_APP = app;
  try {
    assert.equal(appBundle(), app);
    assert.equal(binDir(), bin);
  } finally {
    delete process.env.UNBROWSE_UNCHECKED_APP;
  }
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(process.execPath, [cli, "whoami"], { env: bare({ UNBROWSE_UNCHECKED_APP: app }) });
    assert.equal(r.status, 3, r.stderr.toString());
    assert.equal(readFileSync(said, "utf8").trim(), "unb whoami");
    assert.match(r.stderr.toString(), /WARNING: signature checks are OFF/, "said on every run");
    assert.ok(r.stderr.toString().includes(app));
  }
  // Its value must be the app's own absolute path: a switch, or a path that is no app, turns nothing off.
  for (const value of ["1", "true", "Unbrowse.app", join(tmpdir(), "no-such", "Unbrowse.app")]) {
    assert.equal(uncheckedApp({ UNBROWSE_UNCHECKED_APP: value }).app, undefined, value);
    assert.match(uncheckedApp({ UNBROWSE_UNCHECKED_APP: value }).said, /ignoring it/);
  }
  assert.deepEqual(uncheckedApp({}), {});
});

test("an app UNBROWSE_APP names is held to the vendor's team like any app found elsewhere", () => {
  const { app, said } = fakeApp();
  // Unsigned, named by an inherited variable: it doesn't run, and nothing it carries is run in its place.
  process.env.UNBROWSE_APP = app;
  try {
    assert.equal(appBundle(), undefined);
  } finally {
    delete process.env.UNBROWSE_APP;
  }
  const r = spawnSync(process.execPath, [cli, "whoami"], { env: bare({ UNBROWSE_APP: app }) });
  assert.notEqual(r.status, 3);
  assert.ok(!existsSync(said), "the named app's programs never ran");
  assert.match(r.stderr.toString(), /isn't run/);
  assert.match(r.stderr.toString(), /UNBROWSE_UNCHECKED_APP=<its absolute path>/, "the way to run one's own build is named, and is loud");
  assert.doesNotMatch(r.stderr.toString(), /set UNBROWSE_APP/);

  const own = fakeApp(), ours = fakeApp(), planted = fakeApp();
  const teams = new Map([[ours.app, "OURTEAM123"], [planted.app, "OTHERTEAM1"]]);
  const team = (a) => teams.get(a);
  // The pinned team: only an app it signed runs.
  assert.equal(namedApp(ours.app, undefined, "OURTEAM123", team), ours.app);
  assert.equal(namedApp(planted.app, undefined, "OURTEAM123", team), undefined);
  assert.equal(namedApp(app, undefined, "OURTEAM123", team), undefined, "unsigned");
  // Nothing pinned: the package app's team, and with no signed package app, no team, so none runs.
  assert.equal(namedApp(planted.app, own.app, undefined, team), undefined);
  assert.equal(namedApp(ours.app, own.app, undefined, team), undefined);
  teams.set(own.app, "OURTEAM123");
  assert.equal(namedApp(ours.app, own.app, undefined, team), ours.app);
  assert.equal(namedApp(planted.app, own.app, undefined, team), undefined);
  // The package's own app, named, is the package's: trusted as the package is.
  teams.delete(own.app);
  assert.equal(namedApp(own.app, own.app, undefined, team), own.app);
  assert.equal(namedApp(join(tmpdir(), "no-such", "Unbrowse.app"), own.app, "OURTEAM123", team), undefined);
});

test("the newest app wins over the one the platform package brought", () => {
  const plist = (v) => `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`;
  const old = fakeApp(), cur = fakeApp(), none = fakeApp();
  writeFileSync(join(old.app, "Contents", "Info.plist"), plist("13.0.1"));
  writeFileSync(join(cur.app, "Contents", "Info.plist"), plist("13.9.0-dev"));
  assert.deepEqual(appVersion(cur.app), [13, 9, 0]);
  assert.deepEqual(appVersion(none.app), []);
  assert.equal(newestApp([old.app, cur.app]), cur.app);
  assert.equal(newestApp([cur.app, old.app]), cur.app);
  assert.equal(newestApp([none.app, old.app]), old.app);
  assert.equal(newestApp([old.app, join(tmpdir(), "no-such", "Unbrowse.app")]), old.app);
  assert.equal(newestApp([]), undefined);
});

test("an app found elsewhere runs instead of the package's only when its signature is the package app's team", () => {
  const plist = (v) => `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`;
  const own = fakeApp(), ours = fakeApp(), planted = fakeApp(), unsigned = fakeApp();
  writeFileSync(join(own.app, "Contents", "Info.plist"), plist("13.0.0"));
  for (const a of [ours, planted, unsigned]) writeFileSync(join(a.app, "Contents", "Info.plist"), plist("99.0.0"));
  const teams = new Map([[own.app, "OURTEAM"], [ours.app, "OURTEAM"], [planted.app, "OTHERTEAM"]]);
  const team = (a) => teams.get(a);
  // A newer app signed by the package app's team is an update the owner installed: it runs.
  assert.equal(trustedApp(own.app, [ours.app], undefined, team), ours.app);
  // One that says a higher version and is another team's, or unsigned, never runs in the package's app's place.
  assert.equal(trustedApp(own.app, [planted.app, unsigned.app], undefined, team), own.app);
  // A package app that isn't signed (a build of one's own) has no team: only it runs.
  teams.delete(own.app);
  assert.equal(trustedApp(own.app, [ours.app, planted.app], undefined, team), own.app);
  // A folder with no signature has no team, wherever this runs.
  assert.equal(teamOf(unsigned.app), undefined);
});

test("an app signed by somebody is not the vendor's: with no pinned team none found elsewhere runs", () => {
  const plist = (v) => `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`;
  const ours = fakeApp(), planted = fakeApp(), unsigned = fakeApp();
  for (const a of [ours, planted, unsigned]) writeFileSync(join(a.app, "Contents", "Info.plist"), plist("99.0.0"));
  const teams = new Map([[ours.app, "OURTEAM123"], [planted.app, "OTHERTEAM1"]]);
  const team = (a) => teams.get(a);
  // No app from the package and no pinned team: a validly signed app of any team, ours included, does not run.
  assert.equal(trustedApp(undefined, [planted.app], undefined, team), undefined);
  assert.equal(trustedApp(undefined, [ours.app, planted.app, unsigned.app], undefined, team), undefined);
  // With the vendor's team pinned, only an app signed by that team runs; another team's never, whatever it says.
  assert.equal(trustedApp(undefined, [planted.app, unsigned.app], "OURTEAM123", team), undefined);
  assert.equal(trustedApp(undefined, [planted.app, ours.app], "OURTEAM123", team), ours.app);
  // The pin holds over the package app's own team when both are there.
  const own = fakeApp();
  writeFileSync(join(own.app, "Contents", "Info.plist"), plist("13.0.0"));
  teams.set(own.app, "OTHERTEAM1");
  assert.equal(trustedApp(own.app, [planted.app], "OURTEAM123", team), own.app);
  assert.equal(trustedApp(own.app, [ours.app], "OURTEAM123", team), ours.app);
});

test("the pinned team is read from the package's own metadata, and only a Team ID counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "unbrowse-pkg-"));
  const pkg = join(dir, "package.json");
  writeFileSync(pkg, JSON.stringify({ name: "unbrowse", unbrowseAppTeam: "ABCDE12345" }));
  assert.equal(pinnedTeam(pkg), "ABCDE12345");
  for (const bad of ["", "not a team", "abcde12345", 1234567890, null]) {
    writeFileSync(pkg, JSON.stringify({ name: "unbrowse", unbrowseAppTeam: bad }));
    assert.equal(pinnedTeam(pkg), undefined);
  }
  writeFileSync(pkg, JSON.stringify({ name: "unbrowse" }));
  assert.equal(pinnedTeam(pkg), undefined);
  assert.equal(pinnedTeam(join(dir, "none.json")), undefined);
});

test("unbrowse app says plainly when there's no app to open", () => {
  const env = { ...process.env, UNBROWSE_APP: join(tmpdir(), "no-such", "Unbrowse.app") };
  const r = spawnSync(process.execPath, [cli, "app"], { env });
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /no Unbrowse app here/);
});

test("without an app bundle, unbrowse app starts the window beside the programs, as on Linux and Windows", async () => {
  const bin = mkdtempSync(join(tmpdir(), "unbrowse-bin-"));
  const said = join(bin, "said");
  writeFileSync(join(bin, "unbrowse-window"), `#!/bin/sh\necho "unbrowse-window $*" > "${said}"\n`, { mode: 0o644 });
  const env = { ...process.env, UNBROWSE_APP: join(tmpdir(), "no-such", "Unbrowse.app"), UNBROWSE_BIN: bin };
  const r = spawnSync(process.execPath, [cli, "app"], { env });
  assert.equal(r.status, 0, r.stderr.toString());
  // The window runs on its own, after the command has returned.
  for (let i = 0; i < 50 && !existsSync(said); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(readFileSync(said, "utf8").trim(), "unbrowse-window");
});

test("an MCP server that names its agent goes to unb, which reads the key by name: no token on a command line", () => {
  const bin = mkdtempSync(join(tmpdir(), "unbrowse-bin-"));
  const said = join(bin, "said");
  writeFileSync(join(bin, "unb"), `#!/bin/sh\necho "unb $*" > "${said}"\nexit 0\n`, { mode: 0o644 });
  const env = { ...process.env, UNBROWSE_BIN: bin };
  delete env.UNBROWSE_AGENT_TOKEN;
  const r = spawnSync(process.execPath, [cli, "mcp", "--agent", "first"], { env, input: "" });
  assert.equal(r.status, 0);
  assert.equal(readFileSync(said, "utf8").trim(), "unb mcp --agent first");
});

test("an entry an older Unbrowse wrote goes to unb with its flags, which unb ignores: the hosted sign-in is never read", () => {
  const bin = mkdtempSync(join(tmpdir(), "unbrowse-bin-"));
  const said = join(bin, "said");
  writeFileSync(join(bin, "unb"), `#!/bin/sh\necho "unb $*" >> "${said}"\nexit 0\n`, { mode: 0o644 });
  const env = { ...process.env, UNBROWSE_BIN: bin };
  delete env.UNBROWSE_AGENT_TOKEN;
  delete env.UNBROWSE_NODE;
  // `npx -y unbrowse mcp`, and `node …/dist/cli.js mcp --account x`, as 12.x configs hold them.
  for (const args of [["mcp"], ["mcp", "--account", "x", "--base-url", "https://unbrowse.ai"]]) {
    const r = spawnSync(process.execPath, [cli, ...args], { env, input: "" });
    assert.equal(r.status, 0, r.stderr.toString());
  }
  assert.deepEqual(readFileSync(said, "utf8").trim().split("\n"), ["unb mcp", "unb mcp --account x --base-url https://unbrowse.ai"]);
});
