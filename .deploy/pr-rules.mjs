#!/usr/bin/env node
// The rules a change must meet before anyone spends time reviewing it, the same in every repo:
//   - its title says what kind of change it is (feat: fix: docs: …), because the title becomes the squash commit, and
//     the commits decide the next version and write the release notes (release.mjs);
//   - a release/* branch takes fixes only;
//   - a fix carries a test: a bug with no test comes back in the next release;
//   - it is small enough to review. A 20,000-line change "reviewed" in 21 seconds was not reviewed.
//
//   node pr-rules.mjs --base origin/staging [--head HEAD] [--target staging] [--title "fix: …"] [--body "…"]
//                     [--max-lines 800] [--manifest .deploy/manifest.json] [--head-ref release/1.4]
// (--head-ref, else GITHUB_HEAD_REF: a release/* branch into main is the train's own pull request and is let through.)
//
// Title and body come from --title/--body, else PR_TITLE/PR_BODY, else the head commit. The target branch is --target,
// else GITHUB_BASE_REF, else the base ref's name. Two declared exceptions, each a line in the body with a reason of
// 15+ characters:   No-Test: <why this fix cannot have one>     Large-Change: <why it cannot be split>
// The manifest may set { "pr": { "maxLines": 800, "ignore": ["docs/generated/"], "tests": ["\\.test\\."] } }.
// Ends with a success-only marker:  PR_RULES_OK type=… lines=… tests=…      Any broken rule: PR_RULES_FAIL, exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TYPES = ["feat", "fix", "refactor", "build", "ci", "chore", "docs", "style", "perf", "test", "revert"];
const TITLE = new RegExp(`^(${TYPES.join("|")})(\\([^)]+\\))?(!)?: \\S.*`);
const TESTS = ["\\.test\\.", "\\.spec\\.", "(^|/)tests?/", "(^|/)__tests__/", "_test\\.(go|py|rs)$"];
// Files nobody reads line by line: they do not count towards a change's size.
// (The train's own scripts in .deploy/ are copied whole from the skill and checked against it by doctor.mjs.)
const UNREAD = ["(^|/)\\.deploy/[^/]+\\.(mjs|sh)$", "(^|/)package-lock\\.json$", "(^|/)bun\\.lockb?$", "(^|/)yarn\\.lock$", "(^|/)pnpm-lock\\.yaml$", "(^|/)Cargo\\.lock$", "\\.snap$", "(^|/)(dist|vendor|node_modules)/", "\\.min\\.(js|css)$"];

/** What kind of change a title declares: { type, scope, breaking } or null when it declares none. */
export function parseTitle(title) {
  const m = TITLE.exec(String(title ?? "").trim());
  return m ? { type: m[1], scope: m[2]?.slice(1, -1) ?? "", breaking: !!m[3] } : null;
}

/** A declared exception in the body ("No-Test: reason"): the reason, or "" when absent or too short to be one. */
export function declared(body, key) {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "mi").exec(String(body ?? ""));
  return m && m[1].trim().length >= 15 ? m[1].trim() : "";
}

/** Lines changed that a person would read, from `git diff --numstat` text. Binary files count as nothing. */
export function sizeOf(numstat, ignore = []) {
  const skip = [...UNREAD, ...ignore].map((p) => new RegExp(p));
  let lines = 0; const files = [], read = [];
  for (const row of String(numstat ?? "").split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row);
    if (!m) continue;
    files.push(m[3]);
    if (m[1] !== "-" && !skip.some((re) => re.test(m[3]))) { lines += Number(m[1]) + Number(m[2]); read.push(m[3]); }
  }
  // `read`: the files that count, which are the ones a reviewer is asked about.
  return { lines, files, read };
}

/** Every rule the change breaks ([] when none), and what was measured. Pure, so it is tested without a repository. */
export function verdict({ title, body = "", target = "", numstat = "", maxLines = 800, ignore = [], tests = TESTS }) {
  const bad = [], t = parseTitle(title), { lines, files } = sizeOf(numstat, ignore);
  const testFiles = files.filter((f) => tests.some((p) => new RegExp(p).test(f)));
  if (!t) bad.push(`the title ${JSON.stringify(String(title ?? "").slice(0, 80))} does not say what kind of change this is: start it with one of ${TYPES.join(": ")}: (it becomes the commit, and the commits write the release notes)`);
  if (t && /^release\//.test(target) && t.type !== "fix") bad.push(`${target} takes fixes only (a release candidate gets no new work): this is "${t.type}:". Put it on staging`);
  if (t?.type === "fix" && !testFiles.length && !declared(body, "No-Test")) bad.push("a fix carries a test that fails without it: none of the changed files is a test (or say why in the description: `No-Test: <reason>`)");
  if (lines > maxLines && !declared(body, "Large-Change")) bad.push(`${lines} changed lines is over the ${maxLines} a person can review: split it (or say why it cannot be in the description: \`Large-Change: <reason>\`)`);
  if (!files.length) bad.push("nothing changed against the base");
  return { bad, type: t?.type ?? "", lines, tests: testFiles.length, files: files.length };
}

function main() {
  const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const root = resolve(arg("root", process.cwd())), base = arg("base"), head = arg("head", "HEAD");
  if (!base) { console.error("usage: pr-rules.mjs --base <ref> [--head HEAD] [--target branch] [--title t] [--body b] [--max-lines 800]"); process.exit(2); }
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  const diff = git("diff", "--numstat", `${base}...${head}`);
  if (diff.status) { console.log(`PR_RULES_FAIL cannot compare ${base}...${head}: ${diff.stderr.trim().split("\n").at(-1)}`); process.exit(1); }
  const manifestPath = join(root, arg("manifest", ".deploy/manifest.json")), pr = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).pr ?? {} : {};
  const title = arg("title", process.env.PR_TITLE) || git("log", "-1", "--format=%s", head).stdout.trim();
  const body = arg("body", process.env.PR_BODY) ?? git("log", "-1", "--format=%b", head).stdout;
  // The branch the change is for: the base without its remote's name ("origin/release/1.4" is release/1.4; a local "release/1.4" is itself).
  const remotes = git("remote").stdout.split("\n").filter(Boolean), bare = base.replace(/^refs\/(remotes|heads)\//, "");
  const target = arg("target", process.env.GITHUB_BASE_REF || (remotes.includes(bare.split("/")[0]) ? bare.slice(bare.indexOf("/") + 1) : bare));
  // A release branch into main is the train's own pull request: every change in it was held to these rules one by one
  // on its way into staging or the release branch, and main-source-guard holds the rest.
  const headRef = arg("head-ref", process.env.GITHUB_HEAD_REF || ""), mainName = (existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).branches?.main : "") || "main";
  if (target === mainName && /^release\//.test(headRef)) { console.log(`PR_RULES_OK release ${headRef} into ${mainName}: its changes were held to the rules one by one`); return; }
  const v = verdict({ title, body, target, numstat: diff.stdout, maxLines: Number(arg("max-lines", pr.maxLines ?? 800)), ignore: pr.ignore ?? [], tests: pr.tests ?? TESTS });
  if (v.bad.length) { console.log(`PR_RULES_FAIL ${v.bad.length}:\n  ${v.bad.join("\n  ")}`); process.exit(1); }
  console.log(`PR_RULES_OK type=${v.type} target=${target} files=${v.files} lines=${v.lines} tests=${v.tests}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
