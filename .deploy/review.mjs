#!/usr/bin/env node
// A review by someone who did not write the change: a fresh agent with read-only tools and no memory of the work. It
// is held to what a real review is. It must say something about every changed file, or it did not read the change (a
// "review" that passed 20,000 lines in 21 seconds reviewed nothing); a finding counts only with the concrete way it
// goes wrong; and a change too large to review is refused before any agent is asked.
//
//   node review.mjs --base origin/staging [--max-lines 800] [--out .deploy/.review.json] [--model <id>]
//
// The reviewer is headless Claude Code on the login it has (CLAUDE_CODE_OAUTH_TOKEN in CI), allowed to Read, Grep and
// Glob in the checkout and nothing else. REVIEW_AGENT_CMD swaps it for any command that reads REVIEW_PROMPT and prints
// the answer as JSON. The manifest may set { "pr": { "maxLines": 800, "ignore": [...] }, "review": { "model": "…" } }.
// Ends with a success-only marker:  REVIEW_OK files=… findings=… serious=0     Else REVIEW_FAIL, exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sizeOf } from "./pr-rules.mjs";

export const SCHEMA = { type: "object", required: ["files", "findings"], properties: {
  files: { type: "array", items: { type: "object", required: ["path", "note"], properties: { path: { type: "string" }, note: { type: "string" } } } },
  findings: { type: "array", items: { type: "object", required: ["file", "severity", "summary", "failure_scenario"], properties: { file: { type: "string" }, line: { type: "integer" }, severity: { enum: ["high", "medium", "low"] }, summary: { type: "string" }, failure_scenario: { type: "string" } } } } } };

/** What the reviewer is asked. The diff is given; the rest of the code is there to be read. */
export function prompt(diff, files) {
  return `You are reviewing a change you did not write, before it merges. The diff is below; the repository is your working directory and you may Read, Grep and Glob it. Read the code around each change before judging it.

Answer with JSON only:
- "files": one entry for EVERY changed file (${files.length}: ${files.join(", ")}), with "note": one or two sentences on what changed there and whether it is right. An entry you cannot write means you have not read that file: read it.
- "findings": defects only, each with the file, the line, a one-sentence "summary", and "failure_scenario": the concrete input or state and the wrong result it produces. No scenario, no finding. Do not report style, naming or missing comments.
  severity "high": wrong results, lost or leaked data, a broken caller, a security hole. "medium": wrong in an edge case. "low": worth fixing, breaks nothing.
An empty "findings" list is a fine answer when the change is right.

${diff}`;
}

/** The agent's answer out of whatever it printed (Claude Code's JSON envelope, a fenced block, or the bare object). */
export function parseAnswer(stdout) {
  const last = String(stdout ?? "").trim().split("\n").at(-1) ?? "", unfence = (s) => JSON.parse(String(s).replace(/^```(?:json)?\s*|\s*```$/g, ""));
  for (const read of [() => { const j = JSON.parse(last); return j.structured_output ?? (j.files ? j : unfence(j.result)); }, () => unfence(String(stdout).trim())]) { try { const a = read(); if (Array.isArray(a?.files)) return a; } catch { /* next */ } }
  return null;
}

/** Is this a review, and does it let the change through? Pure. */
export function judgeReview(answer, files) {
  const bad = [];
  if (!answer) return { bad: ["the reviewer's answer was not the JSON asked for: nothing was reviewed"], serious: [], findings: [] };
  const noted = new Map(answer.files.map((f) => [String(f.path).replace(/^\.\//, ""), String(f.note ?? "").trim()]));
  const unread = files.filter((f) => (noted.get(f) ?? "").length < 15);
  if (unread.length) bad.push(`not a review: it says nothing about ${unread.length} of the ${files.length} changed files (${unread.slice(0, 8).join(", ")})`);
  const findings = (answer.findings ?? []).filter((f) => files.includes(String(f.file).replace(/^\.\//, "")) && String(f.failure_scenario ?? "").trim().length >= 15);
  const serious = findings.filter((f) => f.severity === "high");
  if (serious.length) bad.push(`${serious.length} serious finding(s):\n    ${serious.map((f) => `${f.file}${f.line ? `:${f.line}` : ""}  ${f.summary}\n      how it goes wrong: ${f.failure_scenario}`).join("\n    ")}`);
  return { bad, serious, findings };
}

function main() {
  const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const root = resolve(arg("root", process.cwd())), base = arg("base");
  if (!base) { console.error("usage: review.mjs --base <ref> [--max-lines 800] [--out file] [--model id]"); process.exit(2); }
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });
  const stat = git("diff", "--numstat", `${base}...HEAD`);
  if (stat.status) { console.log(`REVIEW_FAIL cannot compare with ${base}: ${stat.stderr.trim().split("\n").at(-1)}`); process.exit(1); }
  const m = existsSync(join(root, ".deploy/manifest.json")) ? JSON.parse(readFileSync(join(root, ".deploy/manifest.json"), "utf8")) : {};
  // The files a person would read: lockfiles, snapshots, vendored code and the train's own copied scripts are left out,
  // as they are left out of the change's size.
  const max = Number(arg("max-lines", m.pr?.maxLines ?? 800)), size = sizeOf(stat.stdout, m.pr?.ignore ?? []), files = size.read;
  if (!files.length) { console.log(`REVIEW_OK files=0 findings=0 serious=0 (${size.files.length ? "nothing a person reads changed" : "nothing changed"})`); return; }
  if (size.lines > max && !argv.includes("--any-size")) { console.log(`REVIEW_FAIL ${size.lines} changed lines in ${files.length} files is more than a reviewer can hold (${max}): split the change, then each part is reviewed`); process.exit(1); }
  const text = prompt(git("diff", "--no-color", `${base}...HEAD`, "--", ...files).stdout.slice(0, 600_000), files), custom = process.env.REVIEW_AGENT_CMD, model = arg("model", m.review?.model);
  const env = { ...process.env }; for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) if (!m.review?.allowApiKey) delete env[k];
  const t0 = Date.now(), r = custom ? spawnSync("sh", ["-c", custom], { cwd: root, encoding: "utf8", env: { ...process.env, REVIEW_PROMPT: text }, maxBuffer: 1 << 26 })
    // The prompt goes in on standard input: a diff is longer than one command-line argument may be.
    : spawnSync(m.review?.bin ?? "claude", ["-p", "--restricted", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--tools", "Read,Grep,Glob", "--disable-slash-commands", "--no-session-persistence",
        "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA), ...(model ? ["--model", model] : [])], { cwd: root, encoding: "utf8", env, input: text, maxBuffer: 1 << 26, timeout: 1_200_000 });
  const answer = parseAnswer(r.stdout), v = judgeReview(answer, files), secs = Math.round((Date.now() - t0) / 1000);
  if (arg("out")) writeFileSync(join(root, arg("out")), `${JSON.stringify({ base, files, seconds: secs, answer, serious: v.serious.length }, null, 1)}\n`);
  for (const f of v.findings.filter((x) => x.severity !== "high")) console.log(`${f.severity}: ${f.file}${f.line ? `:${f.line}` : ""}  ${f.summary}`);
  if (v.bad.length) { console.log(`REVIEW_FAIL ${v.bad.length}:\n  ${v.bad.join("\n  ")}${answer ? "" : `\n${String(r.stdout || r.stderr || r.error?.message).slice(-400)}`}`); process.exit(1); }
  console.log(`REVIEW_OK files=${files.length} lines=${size.lines} findings=${v.findings.length} serious=0 seconds=${secs}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
