// The check that npm can take a release, run before anything is built or tagged, against a registry on this machine.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { machinesIn, packagesOf, survey, verdict } from "../npm-preflight.mjs";

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("every package a release publishes is asked about, from the machines the release packs", () => {
  const machines = machinesIn(readFileSync(join(scripts, "pack-platforms.sh"), "utf8"));
  assert.deepEqual(machines, ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"]);
  const names = packagesOf(machines);
  assert.equal(names.length, 10);
  for (const n of ["unbrowse", "@unbrowse/updates", "@unbrowse/darwin-arm64", "@unbrowse/browser-win32-x64"]) assert.ok(names.includes(n), n);
});

test("one message names every package npm doesn't have, not the first alone", async () => {
  const names = ["unbrowse", "@unbrowse/darwin-arm64", "@unbrowse/linux-x64", "@unbrowse/updates"];
  const found = await survey(names, async (n) => ({ status: n === "unbrowse" ? 200 : 404 }));
  assert.deepEqual(found, { missing: ["@unbrowse/darwin-arm64", "@unbrowse/linux-x64", "@unbrowse/updates"], unknown: [], held: [] });
  const { lines, ok } = verdict(found, "owner/repo");
  assert.equal(ok, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::error::npm has no @unbrowse\/darwin-arm64, @unbrowse\/linux-x64, @unbrowse\/updates \(3 packages\)/);
  assert.match(lines[0], /owner\/repo/);
  assert.match(lines[0], /OPERATIONS\.md §10/);
});

test("a registry that doesn't answer warns and stops nothing: only a package it says it hasn't got does", async () => {
  const found = await survey(["a", "b", "c"], async (n) => {
    if (n === "a") throw new Error("reset");
    return { status: n === "b" ? 503 : 200 };
  });
  assert.deepEqual(found, { missing: [], unknown: ["a", "b"], held: [] });
  const { lines, ok } = verdict(found, "owner/repo");
  assert.equal(ok, true);
  assert.match(lines[0], /^::warning::/);
});

test("a version npm holds in any package is spent, and the metadata's own numbers spend none", async () => {
  const found = await survey(["@unbrowse/linux-x64", "unbrowse", "@unbrowse/updates"], async (n) => ({
    status: 200,
    versions: n === "@unbrowse/updates" ? ["13.5.3"] : n === "unbrowse" ? ["12.5.0"] : ["0.0.0", "13.5.1", "13.5.2"],
  }));
  assert.deepEqual(found.held.sort(), ["0.0.0", "12.5.0", "13.5.1", "13.5.2"], "a stopped run's platform packages spend its number");
});

/** The script as CI runs it, against a registry answering 404 for what `has` leaves out. */
async function run(has, versions = [], ...args) {
  const asked = [];
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    asked.push(name);
    res.statusCode = has(name) ? 200 : 404;
    res.end(JSON.stringify({ versions: Object.fromEntries(versions.map((v) => [v, {}])) }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const output = join(mkdtempSync(join(tmpdir(), "preflight-")), "output");
  const child = spawn(process.execPath, [join(scripts, "npm-preflight.mjs"), ...args], {
    env: { ...process.env, UNBROWSE_REGISTRY: `http://127.0.0.1:${server.address().port}/`, GITHUB_REPOSITORY: "owner/repo", GITHUB_OUTPUT: output },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  return { code, out, asked, output };
}

test("the script fails with the whole list when npm lacks packages, and passes once it has them", async () => {
  const bare = await run((n) => n === "unbrowse");
  assert.equal(bare.code, 1, bare.out);
  assert.equal(bare.asked.length, 10);
  assert.match(bare.out, /\(9 packages\)/);
  const ready = await run(() => true);
  assert.equal(ready.code, 0, ready.out);
  assert.doesNotMatch(ready.out, /::error::/);
});

test("the script hands the job the version it can release, and refuses one npm holds", async () => {
  // A version is fixed before the run (a tag's, or a prerelease's run number): a spent one isn't moved off.
  const stopped = await run(() => true, ["13.5.1"], "13.5.1");
  assert.equal(stopped.code, 1, stopped.out);
  assert.match(stopped.out, /::error::npm holds 13\.5\.1/);
  assert.equal(existsSync(stopped.output), false);
  const rc = await run(() => true, ["13.6.0-rc.4"], "13.6.0-rc.4");
  assert.equal(rc.code, 1, rc.out);
  const next = await run(() => true, ["13.6.0-rc.4"], "13.6.0-rc.5");
  assert.equal(readFileSync(next.output, "utf8"), "version=13.6.0-rc.5\n");
  const clean = await run(() => true, ["13.5.0"], "13.5.1");
  assert.equal(readFileSync(clean.output, "utf8"), "version=13.5.1\n");
});

test("the release asks before its first build, and only when it has something to release", () => {
  const release = readFileSync(join(scripts, "..", "workflows", "release.yml"), "utf8");
  const asks = release.indexOf("node .github/scripts/npm-preflight.mjs");
  assert.ok(asks > 0 && asks < release.indexOf("\n  programs:\n"), "it runs in the version job");
  assert.match(release.slice(release.lastIndexOf("- name:", asks), asks), /if: steps\.next\.outputs\.version != ''/, "it asks about the version the ref gave");
});
