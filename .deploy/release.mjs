#!/usr/bin/env node
// The release train's git steps, the same in every repo (staging -> release/X.Y -> main, one tagged commit per release).
//
//   node release.mjs next                      the next version: v1.5.0 after v1.4.x (v0.1.0 when there is no tag yet)
//   node release.mjs released <sha>            exit 0 when <sha> is already in a release (nothing to promote)
//   node release.mjs cut <sha>                 create release/X.Y at <sha> (the commit that soaked on staging) and push it
//   node release.mjs record <release/X.Y>      put that branch's tree on main as one commit, tag it vX.Y.Z, push both
//   node release.mjs notes <vX.Y.Z | a..b | pending> [--out file] [--intro file]
//                                              what that release changed for the people using it, from the titles of
//                                              the changes in it (RELEASE_NOTES_OK …)
//
// The titles decide the number too: a change marked breaking (`feat!:`, `fix!:`) since the last release makes the next
// one a new major version (once past 1.0; before that, breaking changes are what a 0.x minor is for).
//
// `record` makes main's tree exactly the release branch's tree: main is a log of what shipped, and what shipped is what
// was tested, so the release branch always wins and there is never a conflict to resolve by hand.
import { spawnSync } from "node:child_process";

const git = (...args) => { const r = spawnSync("git", args, { encoding: "utf8" }); if (r.status) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`); return r.stdout.trim(); };
const tryGit = (...args) => { try { return git(...args); } catch { return null; } };
const remote = process.env.RELEASE_REMOTE ?? "origin", main = process.env.RELEASE_MAIN ?? "main";
const [cmd, a] = process.argv.slice(2);
const byVersion = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

const tags = () => git("tag", "--list", "v*").split("\n").map((t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t)).filter(Boolean).map((m) => m.slice(1).map(Number)).sort(byVersion);
/** The next minor after the newest tag or release branch (a release cut but not shipped yet still holds its number). */
/** Every release line there is, oldest first: the shipped ones (tags) and the ones cut and not shipped yet (branches). */
function lines() {
  const cut = (tryGit("branch", "-r", "--list", `${remote}/release/*`) ?? "").split("\n").map((b) => /release\/(\d+)\.(\d+)$/.exec(b.trim())).filter(Boolean).map((m) => [Number(m[1]), Number(m[2]), 0]);
  return [...tags(), ...cut].sort(byVersion);
}
function next(sha) {
  const last = lines().at(-1);
  if (!last) return [0, 1, 0];
  // Breaking since the newest release line (cut or shipped): a new major version. "Since" is from where this commit and
  // that line part ways, so a breaking change that is already in a release that was cut is not counted a second time.
  const from = sha ? partedFrom(last, sha) : null;
  const since = sha ? (tryGit("log", "--format=%s", ...(from ? [`${from}..${sha}`] : [sha])) ?? "").split("\n") : [];
  return last[0] > 0 && since.some((t) => /^[a-z]+(\([^)]+\))?!: /.test(t)) ? [last[0] + 1, 0, 0] : [last[0], last[1] + 1, 0];
}
/** Where a commit and the newest release line (cut or shipped, `last`) part ways: what is new in the commit starts there. */
function partedFrom(last, sha) {
  const line = tryGit("rev-parse", "--verify", "--quiet", `${remote}/release/${last[0]}.${last[1]}^{commit}`), tag = tryGit("rev-parse", "--verify", "--quiet", `v${last.join(".")}^{commit}`);
  const tip = line ?? (tag ? recordedTip(tag) ?? tag : null);
  return tip ? tryGit("merge-base", tip, sha) : null;
}
/** The release-branch commit a release on main was made from (written into its message by `record`). */
function recordedTip(commit) {
  const m = / at ([0-9a-f]{7,40})\)$/.exec(tryGit("log", "-1", "--format=%s", commit) ?? "");
  return m ? tryGit("rev-parse", "--verify", "--quiet", `${m[1]}^{commit}`) : null;
}
const KINDS = [["feat", "New"], ["fix", "Fixed"], ["perf", "Faster"]];
/** Release notes from change titles: what people using it will notice first, the rest counted and not listed. */
function notesFrom(titles, heading, intro) {
  const parsed = titles.filter(Boolean).map((t) => { const m = /^([a-z]+)(?:\(([^)]+)\))?(!)?: (.+)$/.exec(t); return m ? { type: m[1], scope: m[2], breaking: !!m[3], text: m[4] } : { type: "", text: t }; });
  const line = (c) => `- ${c.scope ? `**${c.scope}:** ` : ""}${c.text.replace(/ \(from release\/[\d.]+\)$/, "")}`, out = [`## ${heading}`, ""];
  if (intro?.trim()) out.push(intro.trim(), "");
  const breaking = parsed.filter((c) => c.breaking);
  if (breaking.length) out.push("### Breaking", ...breaking.map(line), "");
  for (const [type, title] of KINDS) { const list = parsed.filter((c) => c.type === type && !c.breaking); if (list.length) out.push(`### ${title}`, ...list.map(line), ""); }
  const untyped = parsed.filter((c) => !c.type), shown = new Set(KINDS.map(([t]) => t)), rest = parsed.filter((c) => c.type && !shown.has(c.type) && !c.breaking);
  if (untyped.length) out.push("### Other changes", ...untyped.map(line), "");
  if (rest.length) { const by = {}; for (const c of rest) by[c.type] = (by[c.type] ?? 0) + 1; out.push(`Also ${rest.length} change${rest.length > 1 ? "s" : ""} with nothing to notice (${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(", ")}).`, ""); }
  return { text: out.join("\n"), counts: { breaking: breaking.length, feat: parsed.filter((c) => c.type === "feat").length, fix: parsed.filter((c) => c.type === "fix").length, untyped: untyped.length, all: parsed.length } };
}

try {
  tryGit("fetch", "--quiet", "--prune", "--tags", remote);
  if (cmd === "next") console.log(`v${next(a ? git("rev-parse", a) : undefined).join(".")}`);
  else if (cmd === "released") {
    // In a release already: on a release branch, or its tree is the tree of a tagged release.
    const sha = git("rev-parse", a), tree = git("rev-parse", `${sha}^{tree}`);
    const inBranch = (tryGit("branch", "-r", "--contains", sha, "--list", `${remote}/release/*`) ?? "").trim();
    const asTag = git("tag", "--list", "v*").split("\n").filter(Boolean).find((t) => tryGit("rev-parse", `${t}^{tree}`) === tree);
    if (inBranch || asTag) { console.log(`RELEASED ${sha.slice(0, 7)} ${inBranch || asTag}`); process.exit(0); }
    console.log(`NOT_RELEASED ${sha.slice(0, 7)}`);
    process.exit(1);
  } else if (cmd === "cut") {
    const sha = git("rev-parse", a), [x, y] = next(sha), branch = `release/${x}.${y}`;
    git("push", remote, `${sha}:refs/heads/${branch}`);
    console.log(`RELEASE_CUT ${branch} ${sha.slice(0, 7)}`);
  } else if (cmd === "record") {
    const m = /release\/(\d+)\.(\d+)$/.exec(a ?? "");
    if (!m) throw new Error("record takes a release/X.Y branch");
    const tip = git("rev-parse", `${remote}/release/${m[1]}.${m[2]}`), tree = git("rev-parse", `${tip}^{tree}`);
    const shipped = tags().filter((t) => t[0] === Number(m[1]) && t[1] === Number(m[2])).at(-1);
    const version = `v${m[1]}.${m[2]}.${shipped ? shipped[2] + 1 : 0}`;
    // A fix to an older line than the newest shipped would put the older release back on main (and into production).
    const newest = tags().at(-1);
    if (newest && byVersion([Number(m[1]), Number(m[2]), 0], [newest[0], newest[1], 0]) < 0 && !process.argv.includes("--older-line")) {
      throw new Error(`v${newest.join(".")} is already shipped and is newer than release/${m[1]}.${m[2]}: fix the newest line, or pass --older-line to ship the old one on purpose`);
    }
    const parent = tryGit("rev-parse", "--verify", "--quiet", `${remote}/${main}`);
    if (parent && git("rev-parse", `${parent}^{tree}`) === tree) throw new Error(`${main} already holds this tree: nothing new to ship`);
    const commit = git("commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `release ${version} (release/${m[1]}.${m[2]} at ${tip.slice(0, 7)})`);
    git("tag", "-a", version, commit, "-m", version);
    git("push", remote, `${commit}:refs/heads/${main}`, `refs/tags/${version}`);
    console.log(`RELEASE_RECORDED ${version} ${commit.slice(0, 7)} tree=${tree.slice(0, 7)}`);
  } else if (cmd === "notes") {
    const argv = process.argv.slice(2), opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
    let range = a ?? "", heading = range;
    const v = /^v(\d+)\.(\d+)\.(\d+)$/.exec(range);
    if (v) {
      // A release on main is one commit: its changes are the release branch's, from where the release before it stood.
      const tip = recordedTip(git("rev-parse", `${range}^{commit}`)), me = v.slice(1).map(Number), before = tags().filter((t) => byVersion(t, me) < 0).at(-1);
      if (!tip) throw new Error(`${range} was not made by \`release.mjs record\`: give a range (a..b) instead`);
      const from = before ? recordedTip(git("rev-parse", `v${before.join(".")}^{commit}`)) : null;
      heading = `${range} (${git("log", "-1", "--format=%cs", `${range}^{commit}`)})`; range = from ? `${from}..${tip}` : tip;
    } else if (range === "pending") {
      // What the next release would say: everything on this commit since the newest release.
      // Already cut? Then this is that release (a cut branch holds its number in `next`), and what is new in it starts
      // at the release shipped before it. Not cut: the next number, and what is new starts where this commit and the
      // newest release line part ways (a release cut and not shipped has no tag yet, and its changes are not this one's).
      const head = git("rev-parse", "HEAD"), cut = /release\/(\d+)\.(\d+)$/m.exec(tryGit("branch", "-r", "--contains", "HEAD", "--list", `${remote}/release/*`) ?? "");
      const shipped = cut ? tags().filter((t) => t[0] === Number(cut[1]) && t[1] === Number(cut[2])).at(-1) : null, newest = cut ? tags().at(-1) : lines().at(-1);
      const tagged = cut && newest ? git("rev-parse", `v${newest.join(".")}^{commit}`) : null, from = cut ? (tagged ? recordedTip(tagged) ?? tagged : null) : newest ? partedFrom(newest, head) : null;
      heading = `${cut ? `v${cut[1]}.${cut[2]}.${shipped ? shipped[2] + 1 : 0}` : `v${next(head).join(".")}`} (not released yet)`; range = from ? `${from}..HEAD` : "HEAD";
    } else if (!range.includes("..")) throw new Error("notes takes a version (vX.Y.Z), a range (a..b) or `pending`");
    const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
    const n = notesFrom(git("log", "--no-merges", "--reverse", "--format=%s", range).split("\n"), heading, opt("intro") && existsSync(opt("intro")) ? readFileSync(opt("intro"), "utf8") : "");
    if (!n.counts.all) throw new Error(`no changes in ${range}: nothing to write notes about`);
    if (opt("out")) writeFileSync(opt("out"), `${n.text}\n`); else console.log(n.text);
    console.log(`RELEASE_NOTES_OK ${a} changes=${n.counts.all} breaking=${n.counts.breaking} new=${n.counts.feat} fixed=${n.counts.fix}${n.counts.untyped ? ` untitled=${n.counts.untyped}` : ""}`);
  } else { console.error("usage: release.mjs next [sha] | released <sha> | cut <sha> | record <release/X.Y> | notes <vX.Y.Z | a..b> [--out file]"); process.exit(2); }
} catch (e) { console.error(`RELEASE_FAIL ${String(e?.message ?? e)}`); process.exit(1); }
