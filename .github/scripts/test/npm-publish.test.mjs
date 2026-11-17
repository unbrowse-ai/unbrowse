// npm-publish.sh against a stand-in for `npm`: a script on the PATH that answers from a folder of what "npm has" and
// keeps a list of what it was asked to publish. Nothing here reaches a registry.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "npm-publish.sh");

const NPM = `#!/bin/sh
# npm view <name> name | npm view <name>@<version> version | npm view <name>@<version> dist.integrity | npm publish <tgz>
case $1 in
  view)
    case $3 in
      name) grep -q "^$2@" "$HAS/list" ;;
      version) grep -q "^$2 " "$HAS/list" ;;
      dist.integrity) grep "^$2 " "$HAS/list" | cut -d' ' -f2 ;;
    esac ;;
  publish) echo "$2" >> "$HAS/published" ;;
esac
`;

/** A folder with the stand-in `npm`, and a tarball of `name@version` holding `body`. */
function registry() {
  const dir = mkdtempSync(join(tmpdir(), "npm-publish-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "npm"), NPM);
  chmodSync(join(dir, "bin", "npm"), 0o755);
  writeFileSync(join(dir, "list"), "");
  const tarball = (name, version, body = "") => {
    const at = mkdtempSync(join(dir, "pkg-"));
    mkdirSync(join(at, "package"));
    writeFileSync(join(at, "package", "package.json"), JSON.stringify({ name, version, body }));
    const file = join(at, "p.tgz");
    assert.equal(spawnSync("tar", ["-czf", file, "-C", at, "package"]).status, 0);
    return file;
  };
  const integrity = (file) => `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
  const has = (name, version, tgz) => writeFileSync(join(dir, "list"), `${readFileSync(join(dir, "list"), "utf8")}${name}@${version} ${integrity(tgz)}\n`);
  const publish = (...tarballs) =>
    spawnSync("sh", [script, "13.6.0", "release.yml", ...tarballs], { encoding: "utf8", env: { ...process.env, HAS: dir, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
  const published = () => (existsSync(join(dir, "published")) ? readFileSync(join(dir, "published"), "utf8").trim().split("\n") : []);
  return { tarball, has, publish, published };
}

test("a metadata version npm holds with other bytes fails the run instead of dropping what it signed", () => {
  const { tarball, has, publish, published } = registry();
  // The release signed 1.0.2 with canary on the new release, then the nightly refresh took 1.0.2 with no canary.
  has("@unbrowse/updates", "1.0.2", tarball("@unbrowse/updates", "1.0.2", "the refresh's"));
  const run = publish(tarball("@unbrowse/updates", "1.0.2", "the release's"));
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /::error::npm has @unbrowse\/updates@1\.0\.2 with other bytes/);
  assert.match(run.stdout, /Sign the update metadata/, "it says how to recover");
  assert.deepEqual(published(), []);
});

test("a package version npm holds with other bytes stops the run before anything after it", () => {
  const { tarball, has, publish, published } = registry();
  has("@unbrowse/linux-x64", "13.6.0", tarball("@unbrowse/linux-x64", "13.6.0", "an earlier build"));
  has("unbrowse", "1.0.0", tarball("unbrowse", "1.0.0"));
  const run = publish(tarball("@unbrowse/linux-x64", "13.6.0", "this build"), tarball("unbrowse", "13.6.0"));
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /::error::npm has @unbrowse\/linux-x64@13\.6\.0 with other bytes/);
  assert.deepEqual(published(), []);
});

test("a version npm holds with the same bytes is left as it is, so a rerun finishes what the last run started", () => {
  const { tarball, has, publish, published } = registry();
  const platform = tarball("@unbrowse/linux-x64", "13.6.0");
  const unbrowse = tarball("unbrowse", "13.6.0");
  has("@unbrowse/linux-x64", "13.6.0", platform);
  has("unbrowse", "1.0.0", tarball("unbrowse", "1.0.0"));
  const run = publish(platform, unbrowse);
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /@unbrowse\/linux-x64@13\.6\.0 is on npm already/);
  assert.deepEqual(published(), [unbrowse]);
});
