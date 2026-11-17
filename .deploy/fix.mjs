#!/usr/bin/env node
// When a check fails, propose the fix instead of waiting for someone to notice: an agent is given the failure and the
// checkout, its change is tested by re-running the very check that failed, and what passes is offered as a pull request
// into the branch that broke. It is bounded so that it cannot make things worse:
//
//   - it never merges, and never commits to the branch that failed: the fix is its own branch (autofix/…) and a PR;
//   - it may not make a check pass by weakening it. A change that deletes or skips a test, removes more assertions than
//     it adds, adds a sleep, a retry or a longer timeout to a test, or touches a workflow, the manifest, a baseline, a
//     snapshot, a lockfile or the train's own scripts is thrown away;
//   - a failure of the machine and not of the code (out of memory or disk, no network, a missing program, a rate limit)
//     is reported and not "fixed", and costs no attempt;
//   - at most three proposals per branch, never two for the same failure, and never a fix of a fix.
//
//   node fix.mjs --from-checks | --check "<name in the manifest>" | --cmd "<command>"   [--push] [--pr] [--max 3]
//                [--describe <file>]   (the branch, the title and the words for the pull request, as JSON: for a job
//                                       that makes the fix without the right to push, and hands it to one that has it)
//
// The fixer is headless Claude Code (CLAUDE_CODE_OAUTH_TOKEN in CI) with Read, Edit, Write, Grep and Glob in the
// checkout and no shell: this script runs the check, not the agent. FIX_AGENT_CMD swaps it for any command (it gets
// FIX_BRIEF). Outcomes, one per run:
//   FIX_NONE      the check passes                                   exit 0
//   FIX_PROPOSED  branch=… [pr=…]  the check passes on that branch   exit 0
//   FIX_SKIP      not the code's fault, or not this script's to fix  exit 3
//   FIX_GAVE_UP   the bounds above were reached                      exit 1
//   FIX_FAILED    the agent's change did not make the check pass, or was refused; nothing was kept   exit 1
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { failingTests } from "./flake.mjs";

const TEST = /(\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)__tests__\/|_test\.(go|py|rs)$)/;
const PROTECTED = [[/^\.github\//, "a workflow"], [/^\.deploy\/manifest\.json$/, "the manifest (its checks and gates)"], [/^\.deploy\/[^/]+\.json$/, "a baseline or waiver file"], [/^\.deploy\/[^/]+\.(mjs|sh)$/, "the train's own scripts"],
  [/(\.snap$|(^|\/)__snapshots__\/)/, "a snapshot"], [/(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/, "a lockfile"]];
const ENVIRONMENT = [[/ENOSPC|No space left on device/i, "the disk is full"], [/out of memory|heap out of memory|\bOOM\b|Killed\s*$/im, "the machine ran out of memory"], [/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network is unreachable|Could not resolve host/i, "the network failed"],
  [/command not found|: not found$|ENOENT.*spawn/im, "a program the check needs is not installed"], [/\b429\b|rate limit/i, "a service refused for rate"], [/A request to the Cloudflare API .*failed/i, "Cloudflare's API failed"]];

/** Why a failure is the machine's and not the code's ("" when it is the code's). */
export function environmental(out) { return ENVIRONMENT.find(([re]) => re.test(String(out ?? "")))?.[1] ?? ""; }

/** One id for "this failure": the tests that failed, or the last line that looks like an error with its numbers removed. */
export function signature(out) {
  const names = failingTests(out), last = String(out ?? "").split("\n").map((l) => l.trim()).filter((l) => /error|fail|expected|cannot|unexpected/i.test(l)).at(-1) ?? String(out ?? "").trim().split("\n").at(-1) ?? "";
  return createHash("sha1").update(names.length ? names.sort().join("\n") : last.replace(/\d+/g, "N")).digest("hex").slice(0, 8);
}

/**
 * Every way a change makes a check pass by weakening it ([] when it is an honest fix). Pure.
 * `files` is [{ path, status: "M"|"A"|"D"|… }]; `patch` is `git diff` text of the change.
 */
export function weakened(files, patch) {
  const bad = [];
  if (!files.length) return ["the agent changed nothing"];
  for (const f of files) { const p = PROTECTED.find(([re]) => re.test(f.path)); if (p) bad.push(`it changed ${f.path}: ${p[1]} is not the fixer's to touch`); if (f.status === "D" && TEST.test(f.path)) bad.push(`it deleted the test ${f.path}`); }
  let file = "", plus = 0, minus = 0;
  const close = () => { if (file && TEST.test(file) && minus > plus) bad.push(`${file}: it removed ${minus} assertion(s) and added ${plus}`); plus = minus = 0; };
  for (const row of String(patch ?? "").split("\n")) {
    if (row.startsWith("diff --git ")) { close(); file = / b\/(.+)$/.exec(row)?.[1] ?? ""; continue; }
    if (!TEST.test(file) || /^(\+\+\+|---)/.test(row)) continue;
    const text = row.slice(1);
    if (row.startsWith("+")) {
      if (/\b(assert|expect|should)\b/.test(text)) plus++;
      if (/\.(skip|only|todo)\(|\b(xit|xdescribe|xtest)\(|@pytest\.mark\.(skip|xfail)|\bt\.Skip\(/.test(text)) bad.push(`${file}: it skips a test (${text.trim().slice(0, 70)})`);
      if (/\b(sleep|setTimeout|retries|retry|timeout)\b/i.test(text)) bad.push(`${file}: it adds a wait, a retry or a longer timeout to a test, which hides the fault (${text.trim().slice(0, 70)})`);
    } else if (row.startsWith("-") && /\b(assert|expect|should)\b/.test(text)) minus++;
  }
  close();
  return bad;
}

/** What the agent is told. */
export function brief({ name, cmd, out, round }) {
  return `A check failed on this repository and you are asked to fix the code so that it passes. ${round > 1 ? "Your first change did not make it pass; its output now is below." : ""}

The check: ${name}
The command: ${cmd}

What it printed (the end of it):
${String(out).slice(-3500)}

Rules. Find the cause in the code under test and fix that. You have Read, Edit, Write, Grep and Glob; the check is run for you afterwards. Your change is thrown away if it deletes or skips a test, removes assertions, adds a sleep, a retry or a longer timeout to a test, or edits anything under .github/, .deploy/, a snapshot or a lockfile. If the test itself is wrong, or the cause is outside this repository, change nothing and say why in one sentence.`;
}

function main() {
  const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; }, has = (n) => argv.includes(`--${n}`);
  const root = resolve(arg("root", process.cwd())), end = (line, code) => { console.log(line); process.exit(code); };
  const git = (...a) => { const r = spawnSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }); return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() }; };
  // The check is the branch's own code: it runs without the credentials this job holds (tokens to push, to deploy, to run the agent).
  const plain = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/TOKEN|SECRET|PASSWORD|API_KEY|_KEY$|CREDENTIAL/i.test(k)));
  const run = (cmd) => { const r = spawnSync("sh", ["-c", cmd], { cwd: root, encoding: "utf8", env: plain, maxBuffer: 256 << 20, timeout: Number(arg("timeout-s", "1800")) * 1000 }); return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };
  const m = existsSync(join(root, ".deploy/manifest.json")) ? JSON.parse(readFileSync(join(root, ".deploy/manifest.json"), "utf8")) : {};
  let checks = [];
  if (arg("cmd")) checks = [{ name: arg("check", arg("cmd")), cmd: arg("cmd") }];
  else if (arg("check")) checks = (m.checks ?? []).filter((c) => (c.name ?? c.cmd) === arg("check"));
  else if (has("from-checks")) checks = m.checks ?? [];
  if (!checks.length) { console.error("usage: fix.mjs --from-checks | --check <name in the manifest> | --cmd <command>  [--push] [--pr] [--max 3]"); process.exit(2); }
  if (git("status", "--porcelain").out) end("FIX_SKIP the checkout has changes that are not committed: the fixer only works from a clean commit, so that what it proposes is only its own", 3);
  // What merely running a check writes into the checkout (a flake ledger, a coverage report) is not part of any fix:
  // it is put back after every run.
  const settle = () => { const dirty = git("status", "--porcelain").out.split("\n").filter(Boolean); if (dirty.length) { git("checkout", "-q", "--", "."); git("clean", "-fdq"); } return dirty.length; };
  let failing = null, first = null;
  for (const c of checks) { const r = run(c.cmd); settle(); if (r.code !== 0 || (c.marker && !r.out.includes(c.marker))) { failing = { name: c.name ?? c.cmd, cmd: c.cmd, marker: c.marker }; first = r; break; } }
  if (!failing) end(`FIX_NONE ${checks.length} check(s) pass: there is nothing to fix`, 0);
  const passes = (r) => r.code === 0 && (!failing.marker || r.out.includes(failing.marker));
  const why = environmental(first.out);
  if (why) end(`FIX_SKIP "${failing.name}" failed because ${why}, not because of the code: nothing to fix here, and no attempt was spent\n${first.out.slice(-600)}`, 3);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").out, head = git("rev-parse", "--short", "HEAD").out;
  if (branch.startsWith("autofix/")) end(`FIX_SKIP ${branch} is itself a proposed fix: a fix is never fixed by the fixer`, 3);
  const slug = branch.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40), sig = signature(first.out), mine = `autofix/${slug}-${sig}`, remote = arg("remote", "origin");
  // Earlier proposals: local branches, the remote's branches as this checkout fetched them (a job with no credentials
  // cannot ask the remote), and the remote itself where it can be asked.
  const tried = [...new Set([...git("for-each-ref", "--format=%(refname:short)", `refs/heads/autofix/${slug}-*`).out.split("\n"),
    ...git("for-each-ref", "--format=%(refname:lstrip=3)", `refs/remotes/${remote}/autofix/${slug}-*`).out.split("\n"),
    ...git("ls-remote", "--heads", remote, `autofix/${slug}-*`).out.split("\n").map((l) => l.split("refs/heads/")[1])].filter(Boolean))];
  if (tried.includes(mine)) end(`FIX_GAVE_UP a fix for this same failure of "${failing.name}" was already proposed (${mine}): the same failure twice is for a person`, 1);
  const max = Number(arg("max", "3"));
  if (tried.length >= max) end(`FIX_GAVE_UP ${tried.length} fixes were already proposed for ${branch} (the limit is ${max}): ${tried.join(", ")}`, 1);

  git("switch", "-q", "-c", mine);
  const undo = (line) => { git("checkout", "-q", "--", "."); git("clean", "-fdq"); git("switch", "-q", branch); git("branch", "-D", "-q", mine); end(line, 1); };
  const custom = process.env.FIX_AGENT_CMD, env = { ...process.env }; for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) if (!m.fix?.allowApiKey) delete env[k];
  let out = first.out, said = "";
  for (let round = 1; round <= 2; round++) {
    const text = brief({ ...failing, out, round });
    const a = custom ? spawnSync("sh", ["-c", custom], { cwd: root, encoding: "utf8", env: { ...process.env, FIX_BRIEF: text, FIX_ROUND: String(round) }, maxBuffer: 1 << 26 })
      : spawnSync(m.fix?.bin ?? "claude", ["-p", text, "--restricted", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--tools", "Read,Edit,Write,Grep,Glob", "--permission-mode", "acceptEdits", "--disable-slash-commands",
          "--no-session-persistence", "--output-format", "json", ...(m.fix?.model ? ["--model", m.fix.model] : [])], { cwd: root, encoding: "utf8", env, maxBuffer: 1 << 26, timeout: 1_800_000 });
    try { said = String(JSON.parse(String(a.stdout).trim().split("\n").at(-1)).result ?? "").slice(0, 300); } catch { said = String(a.stdout ?? "").trim().split("\n").at(-1)?.slice(0, 300) ?? ""; }
    git("add", "-A");
    const files = git("diff", "--cached", "--name-status").out.split("\n").filter(Boolean).map((l) => { const [status, ...p] = l.split("\t"); return { status: status[0], path: p.at(-1) }; });
    const bad = weakened(files, git("diff", "--cached").out);
    if (bad.length) { git("reset", "-q"); undo(`FIX_FAILED the proposed change for "${failing.name}" was refused and nothing was kept:\n  ${bad.join("\n  ")}${said ? `\n  the agent said: ${said}` : ""}`); }
    // The agent's change is committed for the test, so that what the check itself writes can be told from it and put back.
    git("-c", "user.name=release-train", "-c", "user.email=release-train@users.noreply.github.com", "commit", "-q", "-m", "wip");
    const again = run(failing.cmd); settle(); git("reset", "-q", "--soft", "HEAD~1");
    if (passes(again)) {
      git("-c", "user.name=release-train", "-c", "user.email=release-train@users.noreply.github.com", "commit", "-q", "-m", `fix: ${failing.name} passes again (proposed by the release train)`, "-m", `The check \`${failing.cmd}\` failed on ${branch} at ${head}. This change makes it pass; it weakens no test, baseline or workflow.\n\n${said}`.trim());
      let pr = "";
      const body = `The check **${failing.name}** (\`${failing.cmd}\`) failed on \`${branch}\` at ${head}.\n\nThis proposes a fix. It was tested by re-running that check, which now passes, and it was refused unless it left every test, baseline, snapshot and workflow alone. It is a proposal: a person merges it or closes it.\n\n${files.some((f) => TEST.test(f.path)) ? "" : "No-Test: the check that failed is the test of this change; it passes again without being touched\n\n"}${said ? `What the fixer said: ${said}\n\n` : ""}What the check printed:\n\`\`\`\n${first.out.slice(-1500)}\n\`\`\``;
      // For a job that proposes without the right to push: what to call the pull request and what to say in it.
      if (arg("describe")) writeFileSync(arg("describe"), `${JSON.stringify({ branch: mine, base: branch, title: `fix: ${failing.name} passes again`, body })}\n`);
      if (has("push")) {
        const p = git("push", "-q", remote, mine);
        if (p.code) { git("switch", "-q", branch); end(`FIX_FAILED the fix is on the local branch ${mine} but could not be pushed: ${p.err.split("\n").at(-1)}`, 1); }
        if (has("pr")) {
          const g = spawnSync(process.env.GH_BIN ?? "gh", ["pr", "create", "--base", branch, "--head", mine, "--title", `fix: ${failing.name} passes again`, "--body", body], { cwd: root, encoding: "utf8" });
          pr = g.status === 0 ? ` pr=${g.stdout.trim().split("\n").at(-1)}` : ` pr=not-opened (${(g.stderr || g.stdout).trim().split("\n").at(-1).slice(0, 100)})`;
        }
      }
      git("switch", "-q", branch);
      end(`FIX_PROPOSED branch=${mine} check="${failing.name}" files=${files.length} rounds=${round}${has("push") ? "" : " (local: not pushed)"}${pr}`, 0);
    }
    out = again.out;
    if (round === 2) { git("reset", "-q"); undo(`FIX_FAILED "${failing.name}" still fails after the agent's change (2 rounds): nothing was kept\n${again.out.slice(-800)}`); }
  }
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
