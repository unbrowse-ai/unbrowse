// The update metadata the release writes (updates.mjs), with test keys from fixed seeds: never a release key. The files
// it writes for one release after another are the fixture the node's own test checks
// (unbrowse-node/app/tests/fixtures/updates, `the_node_reads_the_metadata_the_release_script_signs` in update.rs), so the
// two can't drift apart. `UNBROWSE_WRITE_FIXTURES=1 node --test .github/scripts/test/` writes the fixture again.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash, sign as signBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PROMOTE_AFTER, ROOT_WARN, builtinRoot, canonical, checkPublishedRoot2, main, newer, requireCoSignerOnMain, rootNotice, signWith, signedBy, testKey } from "../updates.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixture = join(repo, "unbrowse-node", "app", "tests", "fixtures", "updates");
const NOW = 1_789_900_000;

const pem = (seed) => testKey(seed).key.export({ type: "pkcs8", format: "pem" });
const [release, rootA, rootB, targetsKey, timestampKey, stranger, targetsKey2] = [1, 2, 3, 4, 5, 6, 7].map(testKey);

/** A folder with a release's manifest, as pack-platforms.sh writes it. */
function dist(dir, version, min = "13.0.0") {
  const d = join(dir, `dist-${version}`);
  mkdirSync(d, { recursive: true });
  const platforms = Object.fromEntries(
    ["darwin-arm64", "linux-x64"].map((p) => [p, { name: `@unbrowse/${p}`, integrity: `sha512-${Buffer.from(`${p} ${version}`).toString("base64")}` }]),
  );
  writeFileSync(join(d, "manifest.json"), JSON.stringify({ version, min_version: min, platforms }));
  return d;
}

/** A scratch folder where root 2 (two of three root keys, new targets and timestamp keys) is signed and kept. */
async function world(targetSpec = `${targetsKey.id}:1`) {
  const dir = mkdtempSync(join(tmpdir(), "updates-test-"));
  const roots = join(dir, "roots");
  mkdirSync(roots);
  const opts = ["--roots", roots, "--release-key", release.id];
  const file = join(roots, "2.root.json");
  await main(["root-rotate", file, "--root", `${rootA.id},${rootB.id}:2`, "--targets", targetSpec, "--timestamp", `${timestampKey.id}:1`, ...opts, "--now", String(NOW)]);
  for (const seed of [1, 2, 3]) {
    writeFileSync(join(dir, `${seed}.pem`), pem(seed));
    await main(["root-sign", file, join(dir, `${seed}.pem`), ...opts]);
  }
  process.env.UNBROWSE_TARGETS_KEY = pem(4);
  process.env.UNBROWSE_TIMESTAMP_KEY = pem(5);
  delete process.env.UNBROWSE_RELEASE_KEY;
  delete process.env.GITHUB_REPOSITORY;
  const empty = join(dir, "none");
  mkdirSync(empty);
  // The clock is NOW unless a step names another: `at(when)`.
  return { dir, opts: [...opts, "--now", String(NOW)], at: (when) => [...opts, "--now", String(when)], empty };
}

const read = (dir, f) => JSON.parse(readFileSync(join(dir, f), "utf8"));

test("a release names its browser add-on's packages beside the node's, and one without names none", async () => {
  const { dir, opts, empty } = await world();
  const d = dist(dir, "13.7.0");
  const m = read(d, "manifest.json");
  m.browsers = { "linux-x64": { name: "@unbrowse/browser-linux-x64", integrity: `sha512-${Buffer.from("browser").toString("base64")}` } };
  writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
  const out = join(dir, "with-browser");
  await main(["release", "13.7.0", d, "--from", empty, "--out", out, ...opts]);
  assert.deepEqual(read(out, "targets.json").signed.releases["13.7.0"].browsers, m.browsers);
  const old = join(dir, "old");
  await main(["release", "13.5.0", dist(dir, "13.5.0"), "--from", empty, "--out", old, ...opts]);
  assert.equal(read(old, "targets.json").signed.releases["13.5.0"].browsers, undefined);
});

test("the canonical bytes sort every key and drop space, as the node's do", () => {
  assert.equal(canonical({ b: [1, { z: "é\n", a: null }], a: true }), '{"a":true,"b":[1,{"a":null,"z":"é\\n"}]}');
});

test("a release goes to canary, stable keeps its release, and the files are the node's fixture", async () => {
  const { dir, opts, empty } = await world();
  const first = join(dir, "first");
  await main(["release", "13.5.0", dist(dir, "13.5.0"), "--from", empty, "--out", first, ...opts]);
  assert.equal(read(first, "targets.json").signed.channels.stable, "13.5.0", "the first release is stable's");
  const second = join(dir, "second");
  await main(["release", "13.6.0", dist(dir, "13.6.0"), "--from", first, "--out", second, ...opts]);
  const t = read(second, "targets.json").signed;
  assert.deepEqual(t.channels, { stable: "13.5.0", canary: "13.6.0" });
  assert.equal(t.canary_share, 10);
  assert.deepEqual(Object.keys(t.releases).sort(), ["13.5.0", "13.6.0"]);
  assert.equal(read(second, "timestamp.json").signed.version, 2);
  assert.equal(read(second, "package.json").version, "1.0.2");
  for (const f of ["root/2.root.json", "targets.json", "timestamp.json"]) {
    const made = readFileSync(join(second, f));
    if (process.env.UNBROWSE_WRITE_FIXTURES) {
      mkdirSync(dirname(join(fixture, f)), { recursive: true });
      writeFileSync(join(fixture, f), made);
    }
    assert.deepEqual(made, readFileSync(join(fixture, f)), `${f} differs from the node's fixture: UNBROWSE_WRITE_FIXTURES=1 writes it again`);
  }
});

test("a targets or timestamp key the trusted root doesn't name is refused before anything is written", async () => {
  const { dir, opts, empty } = await world();
  process.env.UNBROWSE_TARGETS_KEY = pem(6);
  await assert.rejects(main(["release", "13.5.0", dist(dir, "13.5.0"), "--from", empty, "--out", join(dir, "x"), ...opts]), /isn't a targets key root 2 names/);
  process.env.UNBROWSE_TARGETS_KEY = pem(4);
  process.env.UNBROWSE_TIMESTAMP_KEY = pem(1);
  await assert.rejects(main(["release", "13.5.0", dist(dir, "13.5.0"), "--from", empty, "--out", join(dir, "x"), ...opts]), /isn't a timestamp key root 2 names/);
  assert.ok(stranger.id);
});

test("targets signatures refuse duplicate key material", async () => {
  const { dir, opts, empty } = await world();
  process.env.UNBROWSE_TARGETS_KEY_2 = pem(4);
  await assert.rejects(
    main(["release", "13.5.0", dist(dir, "13.5.0"), "--from", empty, "--out", join(dir, "duplicate-target-key"), ...opts]),
    /UNBROWSE_TARGETS_KEY must use distinct private keys/,
  );
  delete process.env.UNBROWSE_TARGETS_KEY_2;
});

test("refresh_without_a_targets_change_needs_only_the_timestamp_key", async () => {
  const { dir, opts, empty } = await world(`${targetsKey.id},${targetsKey2.id}:2`);
  process.env.UNBROWSE_TARGETS_KEY = pem(4);
  process.env.UNBROWSE_TARGETS_KEY_2 = pem(7);
  const first = join(dir, "first");
  await main(["release", "13.5.0", dist(dir, "13.5.0"), "--from", empty, "--out", first, ...opts]);
  delete process.env.UNBROWSE_TARGETS_KEY_2;
  const partial = join(dir, "partial");
  await main(["halt", "planned maintenance", "--from", first, "--out", partial, ...opts]);
  const signed = join(dir, "signed");
  delete process.env.UNBROWSE_TARGETS_KEY;
  process.env.UNBROWSE_TARGETS_KEY_2 = pem(7);
  await main(["co-sign", partial, "--action", "halt", "--value", "planned maintenance", "--from", first, "--out", signed, ...opts.slice(0, -2), "--now", String(NOW + 1)]);
  assert.ok(signedBy(read(signed, "targets.json"), { keys: [targetsKey.id, targetsKey2.id], threshold: 2 }));
  delete process.env.UNBROWSE_TARGETS_KEY;
  delete process.env.UNBROWSE_TARGETS_KEY_2;
  const refreshed = join(dir, "refreshed");
  await main(["refresh", "--from", signed, "--out", refreshed, ...opts]);
  assert.deepEqual(read(refreshed, "targets.json"), read(signed, "targets.json"));
  assert.equal(read(refreshed, "timestamp.json").signed.targets.sha256, createHash("sha256").update(readFileSync(join(refreshed, "targets.json"))).digest("hex"));
});

test("the_co_signer_refuses_targets_that_differ_from_the_change_it_recomputes", async () => {
  const { dir, opts, empty } = await world(`${targetsKey.id},${targetsKey2.id}:2`);
  process.env.UNBROWSE_TARGETS_KEY = pem(4);
  process.env.UNBROWSE_TARGETS_KEY_2 = pem(7);
  const base = join(dir, "base");
  await main(["release", "13.5.0", dist(dir, "13.5.0"), "--from", empty, "--out", base, ...opts]);
  delete process.env.UNBROWSE_TARGETS_KEY_2;
  const partial = join(dir, "partial");
  await main(["halt", "planned maintenance", "--from", base, "--out", partial, ...opts]);

  const targets = read(partial, "targets.json");
  targets.signed.halt = "attacker changed the requested halt";
  targets.signatures = signWith(targets.signed, [targetsKey]).signatures;
  const targetsBytes = Buffer.from(`${JSON.stringify(targets, null, 2)}\n`);
  writeFileSync(join(partial, "targets.json"), targetsBytes);
  const timestamp = read(partial, "timestamp.json");
  timestamp.signed.targets.sha256 = createHash("sha256").update(targetsBytes).digest("hex");
  writeFileSync(join(partial, "timestamp.json"), `${JSON.stringify(signWith(timestamp.signed, [timestampKey]), null, 2)}\n`);

  process.env.UNBROWSE_TARGETS_KEY_2 = pem(7);
  await assert.rejects(
    main(["co-sign", partial, "--action", "halt", "--value", "planned maintenance", "--from", base, "--out", join(dir, "rejected"), ...opts.slice(0, -2), "--now", String(NOW + 1)]),
    /partial targets differ from the independently recomputed requested change/,
  );
  delete process.env.UNBROWSE_TARGETS_KEY;
  delete process.env.UNBROWSE_TARGETS_KEY_2;
});

test("the_cosigner_verifies_release_inputs_with_the_documented_attestation_key", async () => {
  const { dir, opts, empty } = await world(`${targetsKey.id},${targetsKey2.id}:2`);
  process.env.UNBROWSE_TARGETS_KEY = pem(4);
  process.env.UNBROWSE_TARGETS_KEY_2 = pem(7);
  const base = join(dir, "base");
  await main(["release", "13.4.0", dist(dir, "13.4.0"), "--from", empty, "--out", base, ...opts]);

  const manifestDir = join(dir, "release-input");
  const inventoryDir = join(dir, "inventory");
  mkdirSync(manifestDir);
  mkdirSync(inventoryDir);
  const bytes = new Map([
    ["unbrowse-linux-x64-13.5.0.tgz", Buffer.from("platform package")],
    ["unbrowse-browser-linux-x64-13.5.0.tgz", Buffer.from("browser package")],
    ["unbrowse-typescript-13.5.0.tgz", Buffer.from("typescript package")],
    ["unbrowse-python-13.5.0-py3-none-any.whl", Buffer.from("python package")],
  ]);
  for (const [name, data] of bytes) writeFileSync(join(manifestDir, name), data);
  const integrity = (name) => `sha512-${createHash("sha512").update(bytes.get(name)).digest("base64")}`;
  const manifest = {
    version: "13.5.0",
    min_version: "13.0.0",
    platforms: { "linux-x64": { name: "@unbrowse/linux-x64", integrity: integrity("unbrowse-linux-x64-13.5.0.tgz") } },
    browsers: { "linux-x64": { name: "@unbrowse/browser-linux-x64", integrity: integrity("unbrowse-browser-linux-x64-13.5.0.tgz") } },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(manifestDir, "manifest.json"), manifestBytes);
  writeFileSync(join(manifestDir, "manifest.sig"), signBytes(null, manifestBytes, release.key).toString("hex"));
  const artifacts = Object.fromEntries([...bytes].map(([name, data]) => [name, createHash("sha256").update(data).digest("hex")]));
  writeFileSync(join(inventoryDir, "release-artifacts.json"), `${JSON.stringify(signWith({ _type: "release-artifacts", version: "13.5.0", artifacts }, [release]), null, 2)}\n`);

  delete process.env.UNBROWSE_TARGETS_KEY_2;
  const partial = join(dir, "partial-release");
  await main(["release", "13.5.0", manifestDir, "--from", base, "--out", partial, ...opts]);
  process.env.UNBROWSE_TARGETS_KEY_2 = pem(7);
  const result = join(dir, "release-cosigned");
  const validManifestSignature = readFileSync(join(manifestDir, "manifest.sig"), "utf8");
  writeFileSync(join(manifestDir, "manifest.sig"), signBytes(null, manifestBytes, stranger.key).toString("hex"));
  await assert.rejects(main([
    "co-sign", partial, "--action", "release", "--release-version", "13.5.0",
    "--manifest-dir", manifestDir, "--inventory-dir", inventoryDir, "--from", base,
    "--out", join(dir, "wrong-attestation"), ...opts.slice(0, -2), "--now", String(NOW + 1),
  ]), /release manifest version or signature is invalid/);
  writeFileSync(join(manifestDir, "manifest.sig"), validManifestSignature);
  await main([
    "co-sign", partial, "--action", "release", "--release-version", "13.5.0",
    "--manifest-dir", manifestDir, "--inventory-dir", inventoryDir, "--from", base,
    "--out", result, ...opts.slice(0, -2), "--now", String(NOW + 1),
  ]);
  assert.ok(signedBy(read(result, "targets.json"), { keys: [targetsKey.id, targetsKey2.id], threshold: 2 }));
  delete process.env.UNBROWSE_TARGETS_KEY;
  delete process.env.UNBROWSE_TARGETS_KEY_2;
});

test("root_check_requires_the_two_of_n_cosigner_on_trusted_main", () => {
  const dir = mkdtempSync(join(tmpdir(), "root-cosigner-check-"));
  const mainUpdates = join(dir, "updates.mjs");
  const root = builtinRoot(release.id, {
    root: [rootA.id, rootB.id],
    targets: [targetsKey.id, targetsKey2.id],
    timestamp: [timestampKey.id],
  });
  writeFileSync(mainUpdates, 'if (command === "root-check") {}');
  assert.throws(() => requireCoSignerOnMain(root, mainUpdates), /main's updates\.mjs has no co-sign command/);
  writeFileSync(mainUpdates, 'if (command === "co-sign") {}');
  assert.equal(requireCoSignerOnMain(root, mainUpdates), true);
  assert.equal(requireCoSignerOnMain(builtinRoot(release.id), undefined), true, "the single-key pre-transition root does not need a co-signer");
  rmSync(dir, { recursive: true, force: true });
});


test("root rotation requires distinct threshold root keys and disables release-key fallback", async () => {
  const { dir, opts, empty } = await world();
  const roots = opts[1];
  const file = join(roots, "bad.root.json");
  await assert.rejects(
    main(["root-rotate", file, "--root", `${release.id},${rootA.id}:2`, "--targets", `${targetsKey.id}:1`, "--timestamp", `${timestampKey.id}:1`, ...opts]),
    /exclude the built-in release key/,
  );

  process.env.UNBROWSE_RELEASE_KEY = pem(1);
  delete process.env.UNBROWSE_TARGETS_KEY;
  const output = join(dir, "fallback-forbidden");
  await assert.rejects(
    main(["release", "13.5.0", dist(dir, "13.5.0"), "--from", empty, "--out", output, ...opts]),
    /root 2 disables the release-key fallback/,
  );
  delete process.env.UNBROWSE_RELEASE_KEY;
  process.env.UNBROWSE_TARGETS_KEY = pem(4);
});

test("a root signed by too few keys is refused", async () => {
  const { dir, opts } = await world();
  const roots = opts[1];
  const r = read(roots, "2.root.json");
  r.signatures = r.signatures.filter((s) => s.keyid !== rootB.id);
  writeFileSync(join(roots, "2.root.json"), JSON.stringify(r));
  await assert.rejects(main(["refresh", "--from", dir, "--out", join(dir, "x"), ...opts]), /isn't signed by enough of its own keys/);
});

test("a halt stops both channels until it is lifted, and promotion and the share move only what they say", async () => {
  const { dir, opts, at: clock, empty } = await world();
  const step = async (name, args, from) => {
    await main([...args, "--from", from, "--out", join(dir, name), ...opts]);
    return join(dir, name);
  };
  let at = await step("a", ["release", "13.5.0", dist(dir, "13.5.0")], empty);
  at = await step("b", ["release", "13.6.0", dist(dir, "13.6.0")], at);
  at = await step("c", ["halt", "13.6.0", "loses", "calls"], at);
  assert.equal(read(at, "targets.json").signed.halt, "13.6.0 loses calls");
  // While halted, a day's refresh never promotes canary.
  await main(["refresh", "--from", at, "--out", join(dir, "d"), ...clock(NOW + PROMOTE_AFTER + 1)]);
  assert.equal(read(join(dir, "d"), "targets.json").signed.channels.stable, "13.5.0");
  at = await step("e", ["resume"], at);
  assert.equal(read(at, "targets.json").signed.halt, null);
  at = await step("f", ["share", "50"], at);
  assert.equal(read(at, "targets.json").signed.canary_share, 50);
  await assert.rejects(step("g", ["promote", "13.5.0"], at), /isn't canary's release/);
  at = await step("h", ["promote", "13.6.0"], at);
  const t = read(at, "targets.json").signed;
  assert.deepEqual(t.channels, { stable: "13.6.0", canary: null });
  assert.deepEqual(Object.keys(t.releases), ["13.6.0"], "only the releases a channel names are kept");
  assert.ok(signedBy(read(at, "targets.json"), { keys: [targetsKey.id], threshold: 1 }));
});

test("a halt and a release signed from the same metadata take the same version, and signing again keeps the halt", async () => {
  const { dir, opts, empty } = await world();
  const sign = async (name, from, ...args) => {
    await main([...args, "--from", from, "--out", join(dir, name), ...opts]);
    return join(dir, name);
  };
  const first = await sign("a", empty, "release", "13.5.0", dist(dir, "13.5.0"));
  const now = await sign("b", first, "release", "13.6.0", dist(dir, "13.6.0"));
  // Out of the release's queue a halt can be signed while a release is between signing and publishing. npm takes one
  // version once, so the two can't both land: that is what makes the separate queue safe.
  const release = await sign("c", now, "release", "13.7.0", dist(dir, "13.7.0"));
  const halt = await sign("d", now, "halt", "13.6.0 loses calls");
  assert.equal(read(release, "package.json").version, read(halt, "package.json").version);
  // The halt published first: the release, signed again on what npm has, can't lift it.
  const again = await sign("e", halt, "release", "13.7.0", dist(dir, "13.7.0"));
  assert.equal(read(again, "targets.json").signed.halt, "13.6.0 loses calls");
  assert.notEqual(read(again, "package.json").version, read(halt, "package.json").version);
});

test("the daily refresh signs a new timestamp, and promotes canary once it has run unhalted long enough", async () => {
  const { dir, opts, at: clock, empty } = await world();
  let at = join(dir, "a");
  await main(["release", "13.5.0", dist(dir, "13.5.0"), "--from", empty, "--out", at, ...opts]);
  await main(["release", "13.6.0", dist(dir, "13.6.0"), "--from", at, "--out", (at = join(dir, "b")), ...opts]);
  const soon = join(dir, "soon");
  await main(["refresh", "--from", at, "--out", soon, ...clock(NOW + 3600)]);
  assert.equal(read(soon, "targets.json").signed.channels.stable, "13.5.0");
  assert.deepEqual(readFileSync(join(soon, "targets.json")), readFileSync(join(at, "targets.json")), "the same targets, under a new timestamp");
  assert.equal(read(soon, "timestamp.json").signed.version, 3);
  const due = join(dir, "due");
  await main(["refresh", "--from", at, "--out", due, ...clock(NOW + PROMOTE_AFTER)]);
  assert.equal(read(due, "targets.json").signed.channels.stable, "13.6.0");
});

/** A run of steps, each on what the last one wrote, with the clock each names. */
async function rollout() {
  const { dir, at: clock, empty } = await world();
  let n = 0;
  let at = empty;
  const step = async (when, ...args) => {
    const out = join(dir, `step-${n++}`);
    await main([...args, "--from", at, "--out", out, ...clock(when)]);
    at = out;
    return read(out, "targets.json").signed;
  };
  return { dir, step };
}

const HOUR = 3600;
const DAY = 24 * HOUR;
// What the replay below promotes: one soaked release at a time, in the order they took canary.
const PROMOTED_IN_THE_REPLAY = ["0.2.0", "13.5.2", "13.7.3", "13.13.2"];

test("a halt stops the two-day clock, and a resume doesn't count the time it was halted", async () => {
  const { dir, step } = await rollout();
  await step(NOW, "release", "13.5.0", dist(dir, "13.5.0"));
  await step(NOW, "release", "13.6.0", dist(dir, "13.6.0"));
  await step(NOW + HOUR, "halt", "13.6.0 loses calls");
  await step(NOW + 3 * DAY, "resume");
  // One hour run, then three days halted: the release has run an hour, however long ago it was made.
  assert.equal((await step(NOW + 3 * DAY + 60, "refresh")).channels.stable, "13.5.0");
  assert.equal((await step(NOW + 3 * DAY + PROMOTE_AFTER - HOUR - 1, "refresh")).channels.stable, "13.5.0");
  assert.equal((await step(NOW + 3 * DAY + PROMOTE_AFTER - HOUR, "refresh")).channels.stable, "13.6.0");
});

test("a release made during a soak waits, and the soak goes on to promote what canary ran", async () => {
  const { dir, step } = await rollout();
  await step(NOW, "release", "13.5.0", dist(dir, "13.5.0"));
  await step(NOW, "release", "13.6.0", dist(dir, "13.6.0"));
  await step(NOW + DAY, "release", "13.7.0", dist(dir, "13.7.0"));
  const t = await step(NOW + DAY + HOUR, "release", "13.8.0", dist(dir, "13.8.0"));
  assert.deepEqual(t.channels, { stable: "13.5.0", canary: "13.6.0" }, "canary keeps the release it is soaking");
  assert.equal(t.waiting, "13.8.0", "only the newest waits");
  assert.equal(t.canary_since, NOW, "the clock isn't restarted");
  assert.deepEqual(Object.keys(t.releases).sort(), ["13.5.0", "13.6.0", "13.8.0"]);
  const next = await step(NOW + PROMOTE_AFTER, "refresh");
  assert.deepEqual(next.channels, { stable: "13.6.0", canary: "13.8.0" }, "the soaked release goes to stable and the newest takes canary");
  assert.equal(next.waiting, undefined);
  assert.equal(next.canary_since, NOW + PROMOTE_AFTER, "the new canary's clock starts now");
});

test("a release that was never canary's is refused promotion by hand", async () => {
  const { dir, step } = await rollout();
  await step(NOW, "release", "13.5.0", dist(dir, "13.5.0"));
  await step(NOW, "release", "13.6.0", dist(dir, "13.6.0"));
  await step(NOW, "release", "13.7.0", dist(dir, "13.7.0"));
  await assert.rejects(step(NOW, "promote", "13.7.0"), /isn't canary's release/);
  assert.deepEqual((await step(NOW, "promote", "13.6.0")).channels, { stable: "13.6.0", canary: "13.7.0" });
});

test("a halt puts the newest release on canary, so a fix already made is what a resume runs", async () => {
  const { dir, step } = await rollout();
  await step(NOW, "release", "13.5.0", dist(dir, "13.5.0"));
  await step(NOW, "release", "13.6.0", dist(dir, "13.6.0"));
  await step(NOW + DAY, "release", "13.7.0", dist(dir, "13.7.0"));
  const halted = await step(NOW + 36 * HOUR, "halt", "13.6.0 loses calls");
  assert.equal(halted.channels.canary, "13.7.0");
  assert.equal(halted.waiting, undefined);
  assert.deepEqual(Object.keys(halted.releases).sort(), ["13.5.0", "13.7.0"], "the halted release can't reach stable now");
  await step(NOW + 3 * DAY, "resume");
  // Its clock starts at the resume: nothing ran while the rollout was halted.
  assert.equal((await step(NOW + 3 * DAY + PROMOTE_AFTER - 1, "refresh")).channels.stable, "13.5.0");
  assert.equal((await step(NOW + 3 * DAY + PROMOTE_AFTER, "refresh")).channels.stable, "13.7.0");
});

test("a release made during a halt takes canary at once, and its clock starts at the resume", async () => {
  const { dir, step } = await rollout();
  await step(NOW, "release", "13.5.0", dist(dir, "13.5.0"));
  await step(NOW, "release", "13.6.0", dist(dir, "13.6.0"));
  await step(NOW + HOUR, "halt", "13.6.0 loses calls");
  const fix = await step(NOW + DAY, "release", "13.7.0", dist(dir, "13.7.0"));
  assert.deepEqual(fix.channels, { stable: "13.5.0", canary: "13.7.0" });
  assert.equal(fix.halt, "13.6.0 loses calls", "a release lifts no halt");
  await step(NOW + 2 * DAY, "resume");
  assert.equal((await step(NOW + 2 * DAY + PROMOTE_AFTER - 1, "refresh")).channels.stable, "13.5.0");
  assert.equal((await step(NOW + 2 * DAY + PROMOTE_AFTER, "refresh")).channels.stable, "13.7.0");
});

test("signing a release again changes nothing about its place in the rollout", async () => {
  const { dir, step } = await rollout();
  await step(NOW, "release", "13.5.0", dist(dir, "13.5.0"));
  await step(NOW, "release", "13.6.0", dist(dir, "13.6.0"));
  const again = await step(NOW + DAY, "release", "13.6.0", dist(dir, "13.6.0"));
  assert.equal(again.waiting, undefined);
  assert.equal(again.canary_since, NOW);
  const stable = await step(NOW + DAY, "release", "13.5.0", dist(dir, "13.5.0"));
  assert.deepEqual(stable.channels, { stable: "13.5.0", canary: "13.6.0" });
});

test("stable advances under the real release history, each release having run two days on canary", async () => {
  const tags = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "release-tags.txt"), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split(" "))
    .map(([at, tag]) => ({ at: Number(at), version: tag.slice(1) }));
  assert.equal(tags.length, 52);
  const { dir, step } = await rollout();
  const first = tags[0].at;
  const last = tags.at(-1).at;
  // The daily refresh, at updates.yml's 03:17 UTC.
  const events = [...tags];
  for (let d = Math.floor(first / DAY) * DAY + 3 * HOUR + 17 * 60; d <= last; d += DAY) if (d > first) events.push({ at: d });
  events.sort((a, b) => a.at - b.at);
  const onCanary = new Map();
  const promoted = [];
  let stable;
  for (const e of events) {
    const t = await (e.version ? step(e.at, "release", e.version, dist(dir, e.version)) : step(e.at, "refresh"));
    if (t.channels.canary && !onCanary.has(t.channels.canary)) onCanary.set(t.channels.canary, e.at);
    if (stable && t.channels.stable !== stable) {
      promoted.push(t.channels.stable);
      assert.ok(e.at - onCanary.get(t.channels.stable) >= PROMOTE_AFTER, `${t.channels.stable} reached stable after under two days on canary`);
    }
    stable = t.channels.stable;
  }
  assert.deepEqual(promoted, PROMOTED_IN_THE_REPLAY);
});

test("no run of releases, halts and resumes promotes a release with under two unhalted days on canary", async () => {
  // A fixed generator, so a failure is the same failure every run.
  let seed = 7;
  const rand = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const { dir, step } = await rollout();
  let now = NOW;
  let patch = 0;
  let t = await step(now, "release", "13.5.0", dist(dir, "13.5.0"));
  const ran = new Map();
  for (let i = 0; i < 300; i++) {
    const was = t;
    const after = now + (1 + rand(30)) * HOUR;
    if (was.channels.canary && !was.halt) ran.set(was.channels.canary, (ran.get(was.channels.canary) ?? 0) + (after - now));
    now = after;
    const kind = rand(10);
    if (kind < 2) {
      const v = `13.6.${patch++}`;
      t = await step(now, "release", v, dist(dir, v));
    } else if (kind < 4) t = await step(now, "halt", "stop");
    else if (kind < 6) t = await step(now, "resume");
    else t = await step(now, "refresh");
    if (t.channels.stable !== was.channels.stable) {
      assert.ok(ran.get(t.channels.stable) >= PROMOTE_AFTER, `${t.channels.stable} ran ${ran.get(t.channels.stable)}s unhalted`);
    }
    assert.ok(!t.halt || t.waiting === undefined, "nothing waits behind a halt");
  }
  assert.notEqual(t.channels.stable, "13.5.0", "the run promoted something");
});

test("a minimum above what stable runs holds until stable runs it", async () => {
  const { dir, step } = await rollout();
  await step(NOW, "release", "13.5.0", dist(dir, "13.5.0"));
  const raised = await step(NOW + DAY, "release", "13.6.0", dist(dir, "13.6.0", "13.6.0"));
  assert.deepEqual(raised.channels, { stable: "13.5.0", canary: "13.6.0" });
  assert.equal(raised.min_version, "13.0.0", "a stable node isn't put below the minimum by a release it can't run yet");
  const still = await step(NOW + DAY + HOUR, "release", "13.7.0", dist(dir, "13.7.0", "13.6.0"));
  assert.equal(still.min_version, "13.0.0");
  const reached = await step(NOW + DAY + PROMOTE_AFTER, "refresh");
  assert.equal(reached.channels.stable, "13.6.0");
  assert.equal(reached.min_version, "13.6.0", "it applies the moment stable reaches it");
});

test("the minimum never stands above stable, a first release that asks for more included", async () => {
  const { dir, step } = await rollout();
  assert.equal((await step(NOW, "release", "13.5.0", dist(dir, "13.5.0", "13.6.0"))).min_version, "13.5.0");
});

test("the root check stays quiet until a root's last month, then fails and says what to sign", async () => {
  const { dir } = await world();
  const none = join(dir, "no-roots");
  mkdirSync(none);
  await main(["root-check", "--roots", none, "--release-key", release.id, "--now", String(NOW)]);
  const expires = NOW + 365 * 86400;
  assert.match(rootNotice({ version: 2, expires }, expires - ROOT_WARN + 1), /root 2 expires in 30 days: sign root 3 offline/);
  assert.match(rootNotice({ version: 2, expires }, expires + 1), /root 2 has expired/);
});

test("the root built in never expires, so nothing is said of it", async () => {
  const { dir } = await world();
  const none = join(dir, "no-roots");
  mkdirSync(none);
  await main(["root-check", "--roots", none, "--release-key", release.id, "--now", String(NOW + 100 * 365 * 86400)]);
});

test("a root's notice is a rule of its expiry and the clock alone", () => {
  assert.equal(rootNotice({ version: 1 }, NOW), null);
  assert.equal(rootNotice({ version: 4, expires: NOW + ROOT_WARN }, NOW), null);
  assert.match(rootNotice({ version: 4, expires: NOW + 86400 }, NOW), /^root 4 expires in 1 days?:/);
});

test("the_published_root_2_names_the_builtin_offline_roles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "root2-check-"));
  const offline = { root: [rootA.id, rootB.id], targets: [targetsKey.id, targetsKey2.id], timestamp: [timestampKey.id] };
  assert.equal(checkPublishedRoot2(dir, release.id, { root: [], targets: [], timestamp: [] }), false);
  writeFileSync(join(dir, "2.root.json"), " \n");
  assert.equal(checkPublishedRoot2(dir, release.id, { root: [], targets: [], timestamp: [] }), false);
  rmSync(join(dir, "2.root.json"));
  await assert.rejects(async () => checkPublishedRoot2(dir, release.id, offline), /must be filled together/);
  const roles = builtinRoot(release.id, offline).roles;
  writeFileSync(join(dir, "2.root.json"), JSON.stringify({ signed: { _type: "root", version: 2, roles } }));
  await assert.rejects(main(["root-check", "--roots", dir, "--release-key", release.id, "--now", String(NOW)]), /must be filled together/);
  assert.equal(checkPublishedRoot2(dir, release.id, offline), true);
  const reordered = structuredClone(roles);
  for (const role of Object.values(reordered)) role.keys.reverse();
  writeFileSync(join(dir, "2.root.json"), JSON.stringify({ signed: { _type: "root", version: 2, roles: reordered } }));
  assert.equal(checkPublishedRoot2(dir, release.id, offline), true, "key array ordering does not change the role's key set");
  const mismatch = structuredClone(roles);
  mismatch.targets.threshold = 1;
  writeFileSync(join(dir, "2.root.json"), JSON.stringify({ signed: { _type: "root", version: 2, roles: mismatch } }));
  assert.throws(() => checkPublishedRoot2(dir, release.id, offline), /do not exactly match/);
  assert.throws(() => checkPublishedRoot2(dir, release.id, { root: [], targets: [], timestamp: [] }), /must be filled together/);
});

test("a_release_refuses_to_sign_while_root_2_and_the_constants_disagree", async () => {
  const { dir, empty } = await world();
  const roots = join(repo, "unbrowse-node", "updates", "root");
  const file = join(roots, "2.root.json");
  const hadFile = existsSync(file);
  const prior = hadFile ? readFileSync(file) : null;
  mkdirSync(roots, { recursive: true });
  writeFileSync(file, JSON.stringify({ signed: { _type: "root", version: 2, roles: {} } }));
  try {
    await assert.rejects(
      main(["release", "13.5.0", dist(dir, "13.5.0"), "--from", empty, "--release-key", release.id, "--out", join(dir, "rejected"), "--now", String(NOW)]),
      /root\/2\.root\.json/,
    );
  } finally {
    if (hadFile) writeFileSync(file, prior);
    else {
      rmSync(file, { force: true });
      try { rmSync(roots); } catch { /* A pre-existing root chain may keep the folder nonempty. */ }
    }
  }
});


test("versions are in semantic versioning's order, prereleases below their release", () => {
  const order = ["13.18.1", "13.19.0-rc.2", "13.19.0-rc.10", "13.19.0-staging.3", "13.19.0", "13.19.1-rc.1", "13.19.1", "13.20.0-rc.1"];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) assert.equal(newer(order[i], order[j]), i > j, `${order[i]} against ${order[j]}`);
  }
  assert.equal(newer("13.19.0-rc.1.1", "13.19.0-rc.1"), true);
  assert.equal(newer("13.19.0-rc.a", "13.19.0-rc.9"), true, "an identifier of letters is above a number");
});

test("a release candidate runs on canary, gives canary up to anything newer, and never reaches stable", async () => {
  const { dir, at: clock, empty } = await world();
  let from = empty;
  const step = async (name, args, when = NOW) => {
    await main([...args, "--from", from, "--out", join(dir, name), ...clock(when)]);
    from = join(dir, name);
    return read(from, "targets.json").signed;
  };
  const release = (v, when) => step(`r-${v}`, ["release", v, dist(dir, v)], when);
  await release("13.18.1");
  let t = await release("13.19.0-rc.1");
  assert.deepEqual(t.channels, { stable: "13.18.1", canary: "13.19.0-rc.1" });
  t = await release("13.19.0-rc.2", NOW + 60);
  assert.equal(t.channels.canary, "13.19.0-rc.2", "a newer candidate takes canary at once: the first's clock counts toward nothing");
  // However long it runs, the daily refresh doesn't give a candidate to stable, and nor does a promotion by hand.
  t = await step("refresh", ["refresh"], NOW + 10 * PROMOTE_AFTER);
  assert.deepEqual(t.channels, { stable: "13.18.1", canary: "13.19.0-rc.2" });
  await assert.rejects(main(["promote", "13.19.0-rc.2", "--from", from, "--out", join(dir, "x"), ...clock(NOW)]), /release candidate/);
  // The release tagged on main takes canary from the candidate at once, and stable after its own soak.
  const shipped = NOW + 11 * PROMOTE_AFTER;
  t = await release("13.19.0", shipped);
  assert.equal(t.channels.canary, "13.19.0");
  assert.equal(t.waiting, undefined);
  // A candidate made while the release soaks waits behind it, and the release's clock keeps running.
  t = await release("13.20.0-rc.1", shipped + 60);
  assert.deepEqual([t.channels.canary, t.waiting], ["13.19.0", "13.20.0-rc.1"]);
  // A fix released meanwhile isn't kept from the queue by the candidate, which gives way to it.
  t = await release("13.19.1", shipped + 120);
  assert.deepEqual([t.channels.canary, t.waiting], ["13.19.0", "13.19.1"]);
  t = await release("13.20.0-rc.2", shipped + 180);
  assert.equal(t.waiting, "13.19.1", "a candidate never takes a release's place in the queue");
  t = await step("promoted", ["refresh"], shipped + PROMOTE_AFTER);
  assert.deepEqual(t.channels, { stable: "13.19.0", canary: "13.19.1" });
});

test("stable's first release is never a candidate", async () => {
  const { dir, opts, empty } = await world();
  await assert.rejects(main(["release", "13.19.0-rc.1", dist(dir, "13.19.0-rc.1"), "--from", empty, "--out", join(dir, "x"), ...opts]), /release candidate/);
});
