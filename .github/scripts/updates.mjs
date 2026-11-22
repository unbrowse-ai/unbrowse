// Writes the update metadata nodes check before they update (unbrowse-node/app/src/update.rs): TUF's three roles, each
// a file of its own, signed over its canonical bytes (every object's keys in order, no space).
//
//   root/<N>.root.json  who signs each role and how many must: made and signed offline by the owner (root-new,
//                       root-sign), kept in unbrowse-node/updates/root, never signed in CI
//   targets.json        each release a channel names, the channels (stable, canary), the canary share and any halt:
//                       signed with UNBROWSE_TARGETS_KEY (else UNBROWSE_RELEASE_KEY)
//   timestamp.json      the targets current now, for a week: signed with UNBROWSE_TIMESTAMP_KEY (else the release key)
//
// Each command but the root ones reads the metadata published now (npm's @unbrowse/updates, or --from), changes it,
// signs it, checks every signature against the root nodes will trust (the one built into update.rs, followed through
// the roots in unbrowse-node/updates/root), and writes the package to publish into --out. A key the trusted root doesn't
// name for its role fails the command, so a release never publishes metadata its nodes would refuse. Node's own crypto
// and the system's tar only: nothing else runs beside the keys.
//
// The rollout: canary runs one release at a time. Once it has run PROMOTE_AFTER unhalted, the daily refresh gives it to
// stable, and the newest release made meanwhile (`waiting`, the only one kept) takes canary and starts a clock of its
// own. So stable moves at most every two days, and what reaches it really ran on canary. The clock can't restart at
// each release, or a run of releases would promote nothing.
//
// A release candidate (X.Y.Z-rc.N, from a release/X.Y branch) runs on canary too, but never reaches stable: it holds
// canary only until something newer comes, which takes canary at once, since its clock counts toward nothing. A
// release (vX.Y.Z on main) never waits behind one: it queues against the releases ahead of it alone, and a candidate
// doesn't take its place in the queue. Nor can canary keep moving while older releases age into stable: a node checks every six hours,
// so a release that held canary for an hour may have run on no node at all. The price is that a fix waits its turn, which
// a halt ends: nodes fetch nothing while halted, so the newest release takes canary at once, and the release halted
// never reaches stable once one has replaced it. A halt stops the clock and its resume doesn't count the time.
//
// `min_version` is one rule for every node but stable is what most run, so a minimum above stable would hold them off
// the network with no release to go to. A release's minimum (`min_wanted` until then) applies once stable reaches it.
//
//   node updates.mjs release <version> <dist> --out <dir>   a release: canary runs it, or it waits for canary's soak
//   node updates.mjs promote <version> --out <dir>          stable runs <version>, which canary ran
//   node updates.mjs share <percent> --out <dir>            the share of nodes that pick no channel which run canary
//   node updates.mjs halt <reason> --out <dir>              stops every rollout, on both channels
//   node updates.mjs resume --out <dir>                     lifts the halt
//   node updates.mjs refresh --out <dir>                    a new timestamp; canary goes to stable once it has run
//                                                           PROMOTE_AFTER unhalted
//   node updates.mjs root-rotate <file> --root <hex,…:n> --targets <hex,…:n> --timestamp <hex,…:n> [--days 365]
//                                                           the next root, unsigned (offline, the owner)
//   node updates.mjs root-sign <file> <key.pem>             adds one key's signature to it (offline, each key holder)
//   node updates.mjs root-check                             fails once the trusted root is within ROOT_WARN of expiring
//
// Options: --from <dir> reads the metadata now from a folder instead of npm (UNBROWSE_REGISTRY, else npmjs.org);
// --roots <dir> and --release-key <hex> stand in for the repository's roots and update.rs's key (the tests' keys);
// --now <seconds> stands in for the clock.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAY = 86400;
export const TIMESTAMP_LIFE = 7 * DAY;
export const TARGETS_LIFE = 365 * DAY;
export const PROMOTE_AFTER = 2 * DAY;
export const DEFAULT_SHARE = 10;
// Long enough to bring the root keys' holders together offline.
export const ROOT_WARN = 30 * DAY;
export const PACKAGE = "@unbrowse/updates";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The bytes a file's signatures are over. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error(`metadata holds whole numbers only, not ${v}`);
  return JSON.stringify(v);
}

const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

/** A key from a PEM (as the secrets hold it), with its public half in hex: its id. */
export function privateKey(pem) {
  const key = typeof pem === "string" ? createPrivateKey(pem) : pem;
  if (key.asymmetricKeyType !== "ed25519") throw new Error("a metadata key is Ed25519");
  return { key, id: createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("hex") };
}

/** A test key from a fixed seed, as update.rs's tests make theirs. Never a release key. */
export function testKey(seed) {
  return privateKey(createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, seed)]), format: "der", type: "pkcs8" }));
}

function verifyBy(id, bytes, sig) {
  try {
    const pub = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(id, "hex")]), format: "der", type: "spki" });
    return verify(null, bytes, pub, Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

/** Whether enough of a role's keys signed a file, each counted once. */
export function signedBy(file, role) {
  const bytes = Buffer.from(canonical(file.signed));
  const good = new Set();
  for (const s of file.signatures) {
    const id = s.keyid.toLowerCase();
    if (role.keys.some((k) => k.toLowerCase() === id) && !good.has(id) && verifyBy(id, bytes, s.sig)) good.add(id);
  }
  return role.threshold > 0 && good.size >= role.threshold;
}

export function signWith(signed, keys) {
  const bytes = Buffer.from(canonical(signed));
  return { signed, signatures: keys.map((k) => ({ keyid: k.id, sig: sign(null, bytes, k.key).toString("hex") })) };
}

/** Pretty, as the files are published: the signatures cover the canonical bytes, not these. */
const text = (file) => `${JSON.stringify(file, null, 2)}\n`;

export function builtinRoot(releaseKey, offline = {}) {
  if (offline.root?.length) {
    if (offline.root.length < 2 || offline.targets?.length < 2 || !offline.timestamp?.length) throw new Error("offline root, targets (2-of-N), and timestamp keys must all be configured");
    return { _type: "root", version: 2, expires: 4102444800, roles: {
      root: { keys: offline.root, threshold: 2 }, targets: { keys: offline.targets, threshold: 2 }, timestamp: { keys: offline.timestamp, threshold: 1 },
    } };
  }
  const one = { keys: [releaseKey], threshold: 1 };
  return { _type: "root", version: 1, roles: { root: one, targets: one, timestamp: one } };
}

/** The root nodes trust: the built-in one, followed through `roots` (a folder of <N>.root.json) as a node follows it. */
export function trustedRoot(releaseKey, roots, now, offline = {}) {
  let root = builtinRoot(releaseKey, offline);
  for (let n = root.version + 1; existsSync(join(roots, `${n}.root.json`)); n++) {
    const file = JSON.parse(readFileSync(join(roots, `${n}.root.json`), "utf8"));
    const next = file.signed;
    if (next._type !== "root" || next.version !== n) throw new Error(`${n}.root.json isn't root ${n}`);
    if (!signedBy(file, root.roles.root)) throw new Error(`root ${n} isn't signed by enough of root ${n - 1}'s keys`);
    if (!signedBy(file, next.roles.root)) throw new Error(`root ${n} isn't signed by enough of its own keys`);
    root = next;
  }
  if (root.expires !== undefined && root.expires <= now) throw new Error(`root ${root.version} has expired: the owner must sign root ${root.version + 1}`);
  return root;
}

/** Keep the legacy transition root and the new binary's built-in root identical. */
export function checkPublishedRoot2(roots, releaseKey, offline) {
  const file = join(roots, "2.root.json");
  const hasOffline = [offline.root, offline.targets, offline.timestamp].some((keys) => keys?.length);
  const hasFile = existsSync(file) && readFileSync(file, "utf8").trim().length > 0;
  if (!hasOffline && !hasFile) return false;
  if (!hasOffline || !hasFile) throw new Error("offline root keys and root/2.root.json must be filled together");
  const published = JSON.parse(readFileSync(file, "utf8")).signed;
  const expected = builtinRoot(releaseKey, offline);
  const actualRoles = published?.roles;
  const expectedRoles = expected.roles;
  const roleNames = ["root", "targets", "timestamp"];
  const rolesMatch = actualRoles && Object.keys(actualRoles).sort().join(",") === roleNames.join(",") && roleNames.every((name) => {
    const actual = actualRoles[name];
    const wanted = expectedRoles[name];
    if (!actual || actual.threshold !== wanted.threshold || !Array.isArray(actual.keys) || new Set(actual.keys.map((id) => id.toLowerCase())).size !== actual.keys.length) return false;
    return canonical(actual.keys.map((id) => id.toLowerCase()).sort()) === canonical(wanted.keys.map((id) => id.toLowerCase()).sort());
  });
  if (published?._type !== "root" || published.version !== 2 || !rolesMatch) {
    throw new Error("root/2.root.json roles do not exactly match the built-in offline root roles");
  }
  return true;
}

/** A 2-of-N targets role can only make progress when the verifier already on the co-signer's trusted ref. */
export function requireCoSignerOnMain(root, mainUpdates) {
  if (root.roles.targets.threshold < 2) return true;
  if (!mainUpdates) throw new Error("targets threshold is 2 or more; check out trusted main and pass --main-updates before enabling co-signing");
  const source = readFileSync(mainUpdates, "utf8");
  if (!/if\s*\(\s*command\s*===\s*[\"']co-sign[\"']\s*\)/.test(source)) {
    throw new Error("targets threshold is 2 or more, but main's updates.mjs has no co-sign command; co-signed changes fail closed until the verifier reaches main");
  }
  return true;
}

/** What to tell the owner of a root near its end, else null. An expired root fails every node's check, and signing the
 *  next takes the offline keys. The root built in has no expiry. */
export function rootNotice(root, now) {
  if (root.expires === undefined || root.expires - now >= ROOT_WARN) return null;
  const next = `sign root ${root.version + 1} offline and commit it (docs/OPERATIONS.md §2)`;
  if (root.expires <= now) return `root ${root.version} has expired, and every node refuses the update metadata: ${next}`;
  return `root ${root.version} expires in ${Math.ceil((root.expires - now) / DAY)} days: ${next}`;
}

/** update.rs's RELEASE_KEY. */
function releaseKeyIn(source) {
  const key = /^const RELEASE_KEY: &str = "([0-9a-f]{64})";$/m.exec(readFileSync(source, "utf8"))?.[1];
  if (!key) throw new Error(`no RELEASE_KEY in ${source}`);
  return key;
}

/** The metadata published now: its targets and timestamp, or none before the first. */
async function current(from) {
  let dir = from;
  if (!dir) {
    const reg = (process.env.UNBROWSE_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
    const meta = await fetch(`${reg}/${PACKAGE.replace("/", "%2f")}/latest`);
    if (meta.status === 404) return null;
    if (!meta.ok) throw new Error(`${PACKAGE}: ${meta.status}`);
    const { dist } = await meta.json();
    const tgz = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer());
    if (`sha512-${createHash("sha512").update(tgz).digest("base64")}` !== dist.integrity) throw new Error(`${PACKAGE}'s tarball isn't the one npm names`);
    dir = mkdtempSync(join(tmpdir(), "updates-"));
    writeFileSync(join(dir, "p.tgz"), tgz);
    execFileSync("tar", ["-xzf", join(dir, "p.tgz"), "-C", dir]);
    dir = join(dir, "package");
  }
  if (!existsSync(join(dir, "targets.json"))) return null;
  return { targets: JSON.parse(readFileSync(join(dir, "targets.json"), "utf8")), timestamp: JSON.parse(readFileSync(join(dir, "timestamp.json"), "utf8")) };
}

function key(name, root) {
  const fallbackAllowed = root.version === 1;
  const pem = process.env[name] || (fallbackAllowed ? process.env.UNBROWSE_RELEASE_KEY : undefined);
  if (!pem) throw new Error(`${name} must be set${fallbackAllowed ? " (or UNBROWSE_RELEASE_KEY before root 2)" : `; root ${root.version} disables the release-key fallback`}`);
  return privateKey(pem);
}

function roleKeys(name, role, root, { allowPartial = false } = {}) {
  const roleName = name.includes("TARGETS") ? "targets" : "timestamp";
  const values = [process.env[name], ...Array.from({ length: 15 }, (_, i) => process.env[`${name}_${i + 2}`])].filter(Boolean);
  if (!values.length && root.version === 1 && process.env.UNBROWSE_RELEASE_KEY) values.push(process.env.UNBROWSE_RELEASE_KEY);
  if (!values.length && root.version > 1) throw new Error(`root ${root.version} disables the release-key fallback; set ${name}`);
  const keys = values.map(privateKey);
  if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new Error(`${name} must use distinct private keys`);
  if (keys.length < (allowPartial ? 1 : role.threshold)) throw new Error(`${name} needs ${allowPartial ? "at least one" : role.threshold} private keys for root ${root.version}`);
  for (const key of keys) if (!role.keys.includes(key.id)) throw new Error(`${name} key ${key.id} isn't a ${roleName} key root ${root.version} names`);
  return keys;
}

function offlineRoleKeys(source) {
  const text = readFileSync(source, "utf8");
  const parse = (name) => {
    const match = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\];`).exec(text);
    return match ? [...match[1].matchAll(/"([0-9a-f]{64})"/g)].map((item) => item[1]) : [];
  };
  return { root: parse("OFFLINE_ROOT_KEYS"), targets: parse("OFFLINE_TARGETS_KEYS"), timestamp: parse("OFFLINE_TIMESTAMP_KEYS") };
}

/** Semantic versioning's order, as the node's semver crate has it: 13.19.0-rc.2 < 13.19.0-rc.10 < 13.19.0. */
export function newer(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split("+")[0].split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i];
  if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined || q === undefined) return q === undefined;
    if (p === q) continue;
    const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (m && n) return Number(p) > Number(q);
    if (m !== n) return n;
    return p > q;
  }
  return false;
}

/** A release candidate (or any prerelease): it runs on canary, never on stable. */
export const candidate = (v) => Boolean(v) && v.split("+")[0].includes("-");

/** Where a new release goes: `waiting` when it is newer than what it queues behind. A release queues behind the
 *  releases ahead of it alone; a candidate behind everything, and never takes a release's place. */
export function queue(t, version) {
  if (!candidate(version)) {
    const ahead = [t.waiting, t.channels.canary].filter((v) => v && !candidate(v));
    if (newer(version, t.channels.stable) && ahead.every((v) => newer(version, v))) t.waiting = version;
  } else if (!(t.waiting && !candidate(t.waiting)) && newer(version, t.waiting ?? t.channels.canary ?? t.channels.stable)) {
    t.waiting = version;
  }
}

/** How long canary's release has run unhalted. `canary_since` is when it would have started had it never been halted. */
export function soaked(t, now) {
  if (!t.channels.canary || t.canary_since == null) return 0;
  return (t.halt ? (t.halted_at ?? now) : now) - t.canary_since;
}

/** Whether the daily refresh gives canary's release to stable. */
export const promotionDue = (t, now) => !t.halt && !candidate(t.channels.canary) && soaked(t, now) >= PROMOTE_AFTER;

/** What every change to the targets answers to: the rollout at the top of this file. `halted` is whether they were. */
function settle(t, halted, now) {
  if (t.halt && !halted) t.halted_at = now;
  if (!t.halt && halted) {
    if (t.canary_since != null) t.canary_since += now - (t.halted_at ?? now);
    delete t.halted_at;
  }
  if (t.channels.canary && !newer(t.channels.canary, t.channels.stable)) t.channels.canary = null;
  if (!t.channels.canary) t.canary_since = null;
  if (t.waiting && (t.halt || !t.channels.canary || candidate(t.channels.canary))) {
    t.channels.canary = t.waiting;
    t.canary_since = now;
    if (t.halt) t.halted_at = now;
    delete t.waiting;
  }
  if (t.min_wanted && !newer(t.min_wanted, t.channels.stable)) {
    t.min_version = t.min_wanted;
    delete t.min_wanted;
  }
  if (newer(t.min_version, t.channels.stable)) t.min_version = t.channels.stable;
}

/** Targets changed by `change`, from those published now (checked under the trusted root). */
export function nextTargets(now, was, change) {
  const t = structuredClone(was?.signed ?? { _type: "targets", version: 0, releases: {}, channels: { stable: null, canary: null }, canary_share: DEFAULT_SHARE, halt: null });
  const halted = Boolean(t.halt);
  change(t);
  t.version += 1;
  t.expires = now + TARGETS_LIFE;
  if (!t.channels.stable) throw new Error("there's no release for stable yet");
  settle(t, halted, now);
  // Only the releases a channel names or will: a node never needs another.
  const kept = [t.channels.stable, t.channels.canary, t.waiting].filter(Boolean);
  t.releases = Object.fromEntries(Object.entries(t.releases).filter(([v]) => kept.includes(v)));
  for (const v of kept) if (!t.releases[v]) throw new Error(`there's no release ${v} to run`);
  return t;
}

/** Recompute a requested targets transition from the last published signed targets and trusted command inputs. */
export function changedTargets(command, args, was, now, releaseManifest) {
  let targets;
  let changed = true;
  switch (command) {
    case "release": {
      const [version] = args;
      const m = releaseManifest;
      if (!version || m?.version !== version) throw new Error(`release manifest is for ${m?.version}, not ${version}`);
      targets = nextTargets(now, was?.targets, (t) => {
        t.min_version ??= m.min_version;
        t.min_wanted = m.min_version;
        t.releases[version] = { platforms: m.platforms, ...(m.browsers && Object.keys(m.browsers).length && { browsers: m.browsers }) };
        if (!t.channels.stable) {
          if (candidate(version)) throw new Error(`${version} is a release candidate: stable's first release is a release`);
          t.channels.stable = version;
        } else queue(t, version);
      });
      break;
    }
    case "promote": {
      const [version] = args;
      targets = nextTargets(now, was?.targets, (t) => {
        if (version !== t.channels.canary) throw new Error(`${version} isn't canary's release (${t.channels.canary})`);
        if (candidate(version)) throw new Error(`${version} is a release candidate: stable runs only a release tagged on main`);
        t.channels.stable = version;
      });
      break;
    }
    case "share": {
      const share = Number(args[0]);
      if (!(Number.isInteger(share) && share >= 0 && share <= 100)) throw new Error("the share is a whole percent, 0 to 100");
      targets = nextTargets(now, was?.targets, (t) => void (t.canary_share = share));
      break;
    }
    case "halt": {
      const reason = args.join(" ").trim();
      if (!reason) throw new Error("say why the rollout halts");
      targets = nextTargets(now, was?.targets, (t) => void (t.halt = reason));
      break;
    }
    case "resume":
      targets = nextTargets(now, was?.targets, (t) => void (t.halt = null));
      break;
    case "refresh": {
      if (!was) throw new Error(`${PACKAGE} isn't published yet: a release publishes it first`);
      const t = was.targets.signed;
      const due = promotionDue(t, now);
      targets = due ? nextTargets(now, was.targets, (n) => void (n.channels.stable = n.channels.canary)) : t;
      if (!due && t.expires - now < 30 * DAY) targets = nextTargets(now, was.targets, () => {});
      else if (!due) changed = false;
      break;
    }
    default:
      throw new Error(`unsupported targets change ${command}`);
  }
  return { targets, changed };
}

/** Writes the package: the roots, the targets and a timestamp naming them, checked under `root` before anything else. */
function write(out, root, roots, targetsFile, timestampVersion, now, keys, { allowPartialTargets = false } = {}) {
  const t = text(targetsFile);
  const ts = signWith(
    { _type: "timestamp", version: timestampVersion, expires: now + TIMESTAMP_LIFE, targets: { version: targetsFile.signed.version, sha256: createHash("sha256").update(t).digest("hex") } },
    keys.timestamp,
  );
  if (allowPartialTargets ? !targetsFile.signatures.some((s) => root.roles.targets.keys.some((id) => id.toLowerCase() === s.keyid.toLowerCase()) && verifyBy(s.keyid.toLowerCase(), Buffer.from(canonical(targetsFile.signed)), s.sig)) : !signedBy(targetsFile, root.roles.targets)) throw new Error(`UNBROWSE_TARGETS_KEY signatures don't meet the targets threshold root ${root.version} names`);
  if (!signedBy(ts, root.roles.timestamp)) throw new Error(`UNBROWSE_TIMESTAMP_KEY (${keys.timestamp.id}) isn't a timestamp key root ${root.version} names`);
  writeSignedPackage(out, roots, JSON.parse(t), ts);
  return { targets: JSON.parse(t), timestamp: ts };
}

function writeSignedPackage(out, roots, targets, timestamp) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "root"), { recursive: true });
  for (const f of existsSync(roots) ? readdirSync(roots).filter((f) => /^\d+\.root\.json$/.test(f)) : []) copyFileSync(join(roots, f), join(out, "root", f));
  writeFileSync(join(out, "targets.json"), text(targets));
  writeFileSync(join(out, "timestamp.json"), text(timestamp));
  const repository = process.env.GITHUB_REPOSITORY && { type: "git", url: `git+${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}.git` };
  const pkg = {
    name: PACKAGE,
    version: `1.0.${timestamp.signed.version}`,
    description: "Unbrowse's signed update metadata: the roots, the releases each channel runs, and a timestamp. Nodes read it to update.",
    license: "Apache-2.0",
    ...(repository && { repository }),
    files: ["root", "targets.json", "timestamp.json"],
  };
  writeFileSync(join(out, "package.json"), text(pkg));
}

function verifyReleaseInputs(manifestDir, inventoryDir, version, releaseKey) {
  if (!manifestDir || !inventoryDir || !version) throw new Error("release co-signing needs a version, signed manifest and signed artifact inventory");
  const manifestBytes = readFileSync(join(manifestDir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const manifestSignature = readFileSync(join(manifestDir, "manifest.sig"), "utf8").trim();
  if (manifest.version !== version || !verifyBy(releaseKey, manifestBytes, manifestSignature)) throw new Error("release manifest version or signature is invalid");
  if (typeof manifest.min_version !== "string" || !manifest.platforms || !manifest.browsers) throw new Error("release manifest is missing versions or package maps");

  const inventory = JSON.parse(readFileSync(join(inventoryDir, "release-artifacts.json"), "utf8"));
  const releaseRole = { keys: [releaseKey], threshold: 1 };
  if (inventory.signed?._type !== "release-artifacts" || inventory.signed.version !== version || !signedBy(inventory, releaseRole)) throw new Error("release artifact inventory version or signature is invalid");
  const expected = inventory.signed.artifacts;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error("release artifact inventory is malformed");
  const packages = readdirSync(manifestDir).filter((name) => name.endsWith(".tgz") || name.endsWith(".whl")).sort();
  const expectedNames = Object.keys(expected).sort();
  if (canonical(packages) !== canonical(expectedNames)) throw new Error("release package set differs from the signed artifact inventory");
  for (const [name, digest] of Object.entries(expected)) {
    if (!/^[0-9a-f]{64}$/.test(digest) || createHash("sha256").update(readFileSync(join(manifestDir, name))).digest("hex") !== digest) {
      throw new Error(`${name} differs from the signed artifact inventory`);
    }
  }

  const checkMap = (map, prefix) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error(`release manifest ${prefix} package map is invalid`);
    for (const [platform, packageInfo] of Object.entries(map)) {
      if (packageInfo.name !== `@unbrowse/${prefix}${platform}` || !packageInfo.integrity?.startsWith("sha512-")) throw new Error(`release manifest package ${platform} is malformed`);
      const name = `unbrowse-${prefix}${platform}-${version}.tgz`;
      const actual = `sha512-${createHash("sha512").update(readFileSync(join(manifestDir, name))).digest("base64")}`;
      if (actual !== packageInfo.integrity) throw new Error(`${name} differs from the signed release manifest`);
    }
  };
  checkMap(manifest.platforms, "");
  checkMap(manifest.browsers, "browser-");
  return manifest;
}

function verifyRootCopy(input, roots) {
  const folder = join(input, "root");
  const expected = existsSync(roots) ? readdirSync(roots).filter((name) => /^\d+\.root\.json$/.test(name)).sort() : [];
  const actual = existsSync(folder) ? readdirSync(folder).filter((name) => /^\d+\.root\.json$/.test(name)).sort() : [];
  if (canonical(actual) !== canonical(expected)) throw new Error("partial metadata root chain differs from the trusted checkout");
  for (const name of expected) {
    if (!readFileSync(join(folder, name)).equals(readFileSync(join(roots, name)))) throw new Error(`${name} differs from the trusted checkout`);
  }
}

function appendTargetsSummary(path, command, was, targetsFile) {
  if (!path) return;
  const previous = was ? was.targets.signed : null;
  const compact = JSON.stringify(targetsFile.signed).replace(/[<>&`]/g, (char) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "`": "\\u0060" })[char]);
  const summary = [
    "### Targets change awaiting co-signature",
    "",
    `Requested action: ${JSON.stringify(command)}`,
    `Prior targets version: ${previous?.version ?? "none"}`,
    `Proposed targets version: ${targetsFile.signed.version}`,
    `Stable: ${JSON.stringify(previous?.channels?.stable ?? null)} → ${JSON.stringify(targetsFile.signed.channels.stable)}`,
    `Canary: ${JSON.stringify(previous?.channels?.canary ?? null)} → ${JSON.stringify(targetsFile.signed.channels.canary)}`,
    `Minimum version: ${JSON.stringify(previous?.min_version ?? null)} → ${JSON.stringify(targetsFile.signed.min_version)}`,
    `Halt: ${JSON.stringify(previous?.halt ?? null)} → ${JSON.stringify(targetsFile.signed.halt)}`,
    `Targets expiry: ${targetsFile.signed.expires}`,
    "",
    "Recomputed signed targets payload (compact JSON):",
    "",
    "```json",
    compact,
    "```",
    "",
  ].join("\n");
  writeFileSync(path, summary, { flag: "a" });
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

/** A role from `hex,hex,…:threshold`. */
function role(spec) {
  const [keys, threshold] = (spec ?? "").split(":");
  const r = { keys: keys.split(",").filter(Boolean).map((k) => k.toLowerCase()), threshold: Number(threshold) };
  if (!r.keys.length || !r.keys.every((k) => /^[0-9a-f]{64}$/.test(k)) || !(r.threshold >= 1 && r.threshold <= r.keys.length)) {
    throw new Error(`a role is <hex key>,…:<how many must sign>, not ${spec}`);
  }
  return r;
}

export async function main(argv) {
  const args = [...argv];
  const out = option(args, "--out");
  const from = option(args, "--from");
  const githubOutput = option(args, "--github-output") ?? process.env.GITHUB_OUTPUT;
  const githubSummary = option(args, "--github-summary") ?? process.env.GITHUB_STEP_SUMMARY;
  const action = option(args, "--action");
  const value = option(args, "--value");
  const releaseVersion = option(args, "--release-version");
  const manifestDir = option(args, "--manifest-dir");
  const inventoryDir = option(args, "--inventory-dir");
  const mainUpdates = option(args, "--main-updates");
  const roots = option(args, "--roots") ?? join(repo, "unbrowse-node", "updates", "root");
  const releaseKey = option(args, "--release-key") ?? releaseKeyIn(join(repo, "unbrowse-node", "app", "src", "update.rs"));
  const now = Number(option(args, "--now") ?? Math.floor(Date.now() / 1000));
  const [command, ...rest] = args;

  if (command === "root-new" || command === "root-rotate") {
    const [file] = rest;
    const days = Number(option(rest, "--days") ?? 365);
    const roles = { root: role(option(rest, "--root")), targets: role(option(rest, "--targets")), timestamp: role(option(rest, "--timestamp")) };
    const offline = offlineRoleKeys(join(repo, "unbrowse-node", "app", "src", "update.rs"));
    const was = trustedRoot(releaseKey, roots, 0, offline);
    if (roles.root.threshold < 2) throw new Error("a rotated root needs at least two offline root keys");
    const roleSets = [roles.root.keys, roles.targets.keys, roles.timestamp.keys];
    if (roleSets.some((set) => set.includes(releaseKey))) throw new Error("root 2 and its online roles must exclude the built-in release key");
    if (roleSets[0].some((id) => roleSets[1].includes(id) || roleSets[2].includes(id)) || roleSets[1].some((id) => roleSets[2].includes(id))) {
      throw new Error("root, targets and timestamp roles must use distinct keys");
    }
    writeFileSync(file, text({ signed: { _type: "root", version: was.version + 1, expires: now + days * DAY, roles }, signatures: [] }));
    console.log(`root ${was.version + 1} in ${file}: sign it offline with ${was.roles.root.threshold} of root ${was.version}'s keys, then ${roles.root.threshold} of its new root keys (root-sign)`);
    return;
  }
  if (command === "root-sign") {
    const [file, pem] = rest;
    const k = privateKey(readFileSync(pem, "utf8"));
    const f = JSON.parse(readFileSync(file, "utf8"));
    if (f.signed?._type !== "root") throw new Error(`${file} isn't a root`);
    const mine = signWith(f.signed, [k]).signatures[0];
    f.signatures = [...f.signatures.filter((s) => s.keyid !== k.id), mine];
    writeFileSync(file, text(f));
    console.log(`signed root ${f.signed.version} with ${k.id}`);
    return;
  }

  if (command === "root-check") {
    // From 0, so a root already expired reaches the notice rather than trustedRoot's refusal.
    const offline = offlineRoleKeys(join(repo, "unbrowse-node", "app", "src", "update.rs"));
    checkPublishedRoot2(roots, releaseKey, offline);
    const root = trustedRoot(releaseKey, roots, 0, offline);
    requireCoSignerOnMain(root, mainUpdates);
    const notice = rootNotice(root, now);
    if (notice) {
      console.log(`::error::${notice}`);
      throw new Error(notice);
    }
    console.log(`root ${root.version} ${root.expires === undefined ? "never expires" : `has ${Math.floor((root.expires - now) / DAY)} days left`}`);
    return;
  }

  if (command === "co-sign") {
    const [input] = rest;
    const offline = offlineRoleKeys(join(repo, "unbrowse-node", "app", "src", "update.rs"));
    checkPublishedRoot2(join(repo, "unbrowse-node", "updates", "root"), releaseKey, offline);
    const root = trustedRoot(releaseKey, roots, now, offline);
    if (!input || !out || !action) throw new Error("usage: updates.mjs co-sign <partial-package> --action <command> --out <dir>");
    const targetsFile = JSON.parse(readFileSync(join(input, "targets.json"), "utf8"));
    const signer = [key("UNBROWSE_TARGETS_KEY_2", root)];
    if (!root.roles.targets.keys.some((id) => id.toLowerCase() === signer[0].id.toLowerCase())) throw new Error("UNBROWSE_TARGETS_KEY_2 isn't a targets key named by the trusted root");
    const priorTimestamp = JSON.parse(readFileSync(join(input, "timestamp.json"), "utf8"));
    const priorTargetsBytes = readFileSync(join(input, "targets.json"));
    if (!signedBy(priorTimestamp, root.roles.timestamp) || priorTimestamp.signed.targets?.sha256 !== createHash("sha256").update(priorTargetsBytes).digest("hex")) {
      throw new Error("partial metadata timestamp is not valid under the trusted root");
    }
    if (targetsFile.signed?._type !== "targets" || priorTimestamp.signed.targets.version !== targetsFile.signed.version || priorTimestamp.signed.expires <= now) {
      throw new Error("partial targets and timestamp versions or expiry are invalid");
    }
    verifyRootCopy(input, roots);

    const was = await current(from);
    if (was && (!signedBy(was.targets, root.roles.targets) || !signedBy(was.timestamp, root.roles.timestamp) ||
      was.timestamp.signed.targets?.version !== was.targets.signed.version ||
      was.timestamp.signed.targets?.sha256 !== createHash("sha256").update(text(was.targets)).digest("hex"))) {
      throw new Error(`${PACKAGE} now isn't valid current metadata under root ${root.version}`);
    }
    const signedAt = priorTimestamp.signed.expires - TIMESTAMP_LIFE;
    if (!Number.isSafeInteger(signedAt) || signedAt <= 0 || signedAt > now || now - signedAt > TIMESTAMP_LIFE) throw new Error("partial metadata timestamp was signed outside its allowed time window");
    const manifest = action === "release" ? verifyReleaseInputs(manifestDir, inventoryDir, releaseVersion, releaseKey) : undefined;
    if (action !== "release" && (manifestDir || inventoryDir || releaseVersion)) throw new Error("release inventory inputs are only valid for a release action");
    const actionArgs = action === "release" ? [releaseVersion] : value === undefined ? [] : [value];
    const recomputed = changedTargets(action, actionArgs, was, signedAt, manifest);
    if (!recomputed.changed) throw new Error("the requested command does not change targets and cannot need a co-signature");
    if (canonical(targetsFile.signed) !== canonical(recomputed.targets)) throw new Error("partial targets differ from the independently recomputed requested change");

    const valid = new Set();
    for (const signature of targetsFile.signatures ?? []) {
      const id = signature.keyid.toLowerCase();
      if (!root.roles.targets.keys.some((keyId) => keyId.toLowerCase() === id) || valid.has(id) || !verifyBy(id, Buffer.from(canonical(targetsFile.signed)), signature.sig)) {
        throw new Error("partial targets contain an invalid, duplicate or untrusted signature");
      }
      valid.add(id);
    }
    if (valid.size !== root.roles.targets.threshold - 1) throw new Error("partial targets do not contain exactly the signatures expected before co-signing");
    for (const k of signer) {
      if (valid.has(k.id.toLowerCase())) throw new Error("the co-signer must be distinct from the first targets signer");
      targetsFile.signatures.push(...signWith(targetsFile.signed, [k]).signatures);
      valid.add(k.id.toLowerCase());
    }
    if (!signedBy(targetsFile, root.roles.targets)) throw new Error(`co-signature does not meet the targets threshold root ${root.version} names`);
    const timestampKey = key("UNBROWSE_TIMESTAMP_KEY", root);
    const timestamp = signWith({ ...priorTimestamp.signed, expires: now + TIMESTAMP_LIFE, targets: { version: targetsFile.signed.version, sha256: createHash("sha256").update(text(targetsFile)).digest("hex") } }, [timestampKey]);
    if (!signedBy(timestamp, root.roles.timestamp)) throw new Error("UNBROWSE_TIMESTAMP_KEY isn't a timestamp key named by the trusted root");
    writeSignedPackage(out, roots, targetsFile, timestamp);
    console.log(`co-signed targets ${targetsFile.signed.version} with ${[...valid].join(", ")}`);
    return;
  }

  if (!out) throw new Error("--out <dir> says where the package goes");
  const offline = offlineRoleKeys(join(repo, "unbrowse-node", "app", "src", "update.rs"));
  checkPublishedRoot2(join(repo, "unbrowse-node", "updates", "root"), releaseKey, offline);
  const root = trustedRoot(releaseKey, roots, now, offline);
  const was = await current(from);
  if (was) {
    if (!signedBy(was.targets, root.roles.targets) || !signedBy(was.timestamp, root.roles.timestamp) ||
      was.timestamp.signed.targets?.version !== was.targets.signed.version ||
      was.timestamp.signed.targets?.sha256 !== createHash("sha256").update(text(was.targets)).digest("hex")) {
      throw new Error(`${PACKAGE} now isn't signed by the keys root ${root.version} names: nodes would refuse what follows it`);
    }
  }
  // Stable's first release is a release, so a candidate that comes before any (13.0.0-rc.N on `next` ahead of 13.0.0)
  // changes no metadata: it ships to npm without @unbrowse/updates, and its nodes read no channel until the release.
  if (command === "release" && candidate(rest[0]) && !was?.targets.signed.channels?.stable) {
    if (githubOutput) writeFileSync(githubOutput, "targets_changed=false\ncosign_required=false\npublished=false\n", { flag: "a" });
    console.log(`${PACKAGE}: ${rest[0]} is a release candidate and stable has no release yet, so no update metadata is published`);
    return;
  }
  const keys = { timestamp: [key("UNBROWSE_TIMESTAMP_KEY", root)] };
  const tsVersion = (was?.timestamp.signed.version ?? 0) + 1;
  const changeArgs = command === "release" ? rest.slice(0, 1) : rest;
  const releaseManifest = command === "release" ? JSON.parse(readFileSync(join(rest[1], "manifest.json"), "utf8")) : undefined;
  const { targets, changed: targetsChanged } = changedTargets(command, changeArgs, was, now, releaseManifest);
  const targetFile = targetsChanged ? signWith(targets, roleKeys("UNBROWSE_TARGETS_KEY", root.roles.targets, root, { allowPartial: true })) : was.targets;
  const done = write(out, root, roots, targetFile, tsVersion, now, keys, { allowPartialTargets: targetsChanged });
  const cosignRequired = targetsChanged && !signedBy(targetFile, root.roles.targets);
  if (githubOutput) writeFileSync(githubOutput, `targets_changed=${targetsChanged}\ncosign_required=${cosignRequired}\npublished=true\n`, { flag: "a" });
  if (targetsChanged) appendTargetsSummary(githubSummary, command, was, targetFile);
  const c = done.targets.signed.channels;
  console.log(
    `${PACKAGE} 1.0.${tsVersion}: stable ${c.stable}, canary ${c.canary ?? "none"} (${done.targets.signed.canary_share}%)${done.targets.signed.waiting ? `, ${done.targets.signed.waiting} waiting` : ""}${done.targets.signed.halt ? `, halted: ${done.targets.signed.halt}` : ""}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`updates: ${e.message}`);
    process.exit(1);
  });
}
