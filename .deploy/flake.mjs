#!/usr/bin/env node
// Runs a test command so that a test which fails only sometimes is named, written down and counted, instead of being
// re-run by hand until it goes green. A flaky test that nobody can name teaches everyone to ignore red.
//
//   node flake.mjs [--retries 2] [--max-flakes 3] [--window-days 14] [--ledger .deploy/flakes.json]
//                  [--quarantine .deploy/quarantine.json] [--run-timeout-s 300] -- <the test command>
//
// The command is run; if it fails, the tests that failed are read from what it printed (bun, node --test, vitest, jest,
// pytest, go, TAP) and it is run again, up to --retries more times.
//   failed every time           a real failure. FLAKES_FAIL, unless every such test is quarantined (below).
//   failed, then passed         flaky. Written to the ledger with the date and commit. The run passes, but a test that
//                               has flaked --max-flakes times within --window-days fails it from then on: fix the test
//                               or quarantine it.
//   failed with nothing named   a crash, a syntax error. Never retried into a pass: FLAKES_FAIL.
//   no answer in --run-timeout-s  a run that hangs is stopped and named for what it is ("hung: <command>"), so it is
//                               retried and counted like any flaky test instead of holding the pipeline for an hour
//                               and leaving nothing to read.
// A re-run is how a flake is caught and counted here, never how it is cured: sleeps, longer timeouts and retries inside
// a test hide the fault. Quarantine is a written, dated decision with an issue to fix it, not a skip:
//   { "<test name>": { "reason": "15+ characters", "issue": "https://… or #123", "until": "YYYY-MM-DD" } }
// A quarantined test may fail without failing the run until its date (at most 30 days away); after it, the run fails.
// Ends with a success-only marker:  FLAKES_OK runs=… flaky=… quarantined=…      Else FLAKES_FAIL, exit 1.
//
//   node flake.mjs prove [--runs 20] -- <the command that runs the once-flaky test>
// One green run proves nothing about a test that failed one time in five. A fix is proven by the command passing --runs
// times in a row (at least 20; use three times the runs it took to see it fail once):  FLAKE_FIXED runs=…
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PATTERNS = [
  /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/, // bun
  /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/, // node --test
  /^not ok \d+ - (.+?)(?: # .*)?$/, // TAP
  /^\s*(?:×|✕|✗) (.+?)(?: [\d.]+ ?m?s)?$/, // vitest, jest
  /^\s*FAIL\s+(\S.*?>.+)$/, // vitest: FAIL file > suite > test
  /^FAILED (\S+::\S+)/, // pytest
  /^--- FAIL: (\S+)/, // go
];

/** The names of the tests a run's output says failed (in order, once each). */
export function failingTests(out) {
  const names = [];
  for (const row of String(out ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    for (const re of PATTERNS) { const m = re.exec(row); if (m) { const n = m[1].trim(); if (n && !names.includes(n)) names.push(n); break; } }
  }
  return names;
}

/** Problems with a quarantine file's entries on a given day: no reason, no date, a date too far off, a date gone by. */
export function quarantineProblems(q, today) {
  const bad = [], day = (s) => Date.parse(`${s}T00:00:00Z`);
  for (const [name, e] of Object.entries(q ?? {})) {
    if (!String(e?.issue ?? "").trim()) bad.push(`quarantined "${name}" names no issue ("issue": a link or #number): a quarantine nobody is assigned to fix is a deleted test`);
    if (String(e?.reason ?? "").trim().length < 15) bad.push(`quarantined "${name}" has no reason (15+ characters): say what is known and who is fixing it`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e?.until ?? "")) bad.push(`quarantined "${name}" has no end date ("until": "YYYY-MM-DD"): a quarantine with no end is a deleted test`);
    else if (day(e.until) < day(today)) bad.push(`the quarantine of "${name}" ended on ${e.until}: fix the test or remove it, with its reason, in a change of its own`);
    else if (day(e.until) - day(today) > 30 * 86_400_000) bad.push(`the quarantine of "${name}" runs to ${e.until}, more than 30 days away: set a nearer date`);
  }
  return bad;
}

/**
 * The verdict on a series of runs. `runs` is [{ code, failed: [names] }] in order. Pure.
 * Returns { bad: [reasons], flaky: [names], real: [names], quarantined: [names that failed under quarantine] }.
 */
export function judge({ runs, ledger = [], quarantine = {}, today, maxFlakes = 3, windowDays = 14 }) {
  const bad = quarantineProblems(quarantine, today), last = runs.at(-1), q = (n) => n in quarantine;
  const everFailed = [...new Set(runs.flatMap((r) => r.failed))];
  const unnamed = runs.find((r) => r.code !== 0 && !r.failed.length);
  const real = last.code === 0 ? [] : last.failed.filter((n) => !q(n));
  const flaky = everFailed.filter((n) => !last.failed.includes(n) || last.code === 0);
  if (unnamed) bad.push("a run failed and no failing test could be named (a crash, a timeout or an error outside any test): that is never retried into a pass");
  else if (real.length) bad.push(`${real.length} test(s) failed every time (${runs.length} run(s)): ${real.slice(0, 10).join("; ")}`);
  const since = Date.parse(`${today}T00:00:00Z`) - windowDays * 86_400_000;
  for (const n of flaky.filter((x) => !q(x))) {
    const times = ledger.filter((e) => e.name === n && Date.parse(`${e.at}T00:00:00Z`) >= since).length + 1;
    if (times >= maxFlakes) bad.push(`"${n}" has now failed-then-passed ${times} times in ${windowDays} days: fix it, or quarantine it with a reason and an end date`);
  }
  return { bad, flaky, real, quarantined: everFailed.filter(q) };
}

/** `prove`: the command must pass `runs` times in a row; the first failure ends it. */
function prove(argv) {
  const cut = argv.indexOf("--"), opts = cut >= 0 ? argv.slice(0, cut) : argv, command = cut >= 0 ? argv.slice(cut + 1) : [], i = opts.indexOf("--runs"), runs = Math.max(20, Number(i >= 0 ? opts[i + 1] : 20));
  if (!command.length) { console.error("usage: flake.mjs prove [--runs 20] -- <test command>"); process.exit(2); }
  for (let n = 1; n <= runs; n++) {
    const r = spawnSync(command.length === 1 ? "sh" : command[0], command.length === 1 ? ["-c", command[0]] : command.slice(1), { encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, FLAKE_RUN: String(n) } });
    if (r.status !== 0) { console.log(`${`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-2000)}\nFLAKE_NOT_FIXED failed on run ${n} of ${runs}: ${failingTests(`${r.stdout}${r.stderr}`).join("; ") || "no test named"}`); process.exit(1); }
  }
  console.log(`FLAKE_FIXED runs=${runs} in a row`);
}

function main() {
  if (process.argv[2] === "prove") return prove(process.argv.slice(3));
  const argv = process.argv.slice(2), cut = argv.indexOf("--"), opts = cut >= 0 ? argv.slice(0, cut) : argv, command = cut >= 0 ? argv.slice(cut + 1) : [];
  const arg = (n, d) => { const i = opts.indexOf(`--${n}`); return i >= 0 ? opts[i + 1] : d; };
  if (!command.length) { console.error("usage: flake.mjs [--retries 2] [--max-flakes 3] [--window-days 14] [--ledger f] [--quarantine f] -- <test command>"); process.exit(2); }
  const root = resolve(arg("root", process.cwd())), ledgerFile = join(root, arg("ledger", ".deploy/flakes.json")), qFile = join(root, arg("quarantine", ".deploy/quarantine.json"));
  const read = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d), ledger = read(ledgerFile, []), quarantine = read(qFile, {});
  const today = process.env.FLAKE_TODAY ?? new Date().toISOString().slice(0, 10), retries = Number(arg("retries", "2")), runs = [];
  for (let i = 0; i <= retries; i++) {
    const limit = Number(arg("run-timeout-s", "0")), r = spawnSync(command.length === 1 ? "sh" : command[0], command.length === 1 ? ["-c", command[0]] : command.slice(1), { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, ...(limit ? { timeout: limit * 1000, killSignal: "SIGKILL" } : {}) });
    const hung = r.error?.code === "ETIMEDOUT", out = `${r.stdout ?? ""}${r.stderr ?? ""}${hung ? `\n(stopped: no answer in ${limit} s)\n` : ""}`, code = r.status ?? 1;
    const failed = code === 0 ? [] : hung ? [`hung: ${command.join(" ").slice(0, 80)}`] : failingTests(out);
    runs.push({ code, failed, out });
    process.stdout.write(i === 0 || code !== 0 ? out : out.split("\n").slice(-6).join("\n"));
    // Stop when it passes, when nothing can be named, or when the only failures left are quarantined.
    if (code === 0 || !failed.length || failed.every((n) => n in quarantine)) break;
    if (i < retries) console.log(`\n--- ${failed.length} test(s) failed; run ${i + 2} of at most ${retries + 1} ---`);
  }
  const v = judge({ runs, ledger, quarantine, today, maxFlakes: Number(arg("max-flakes", "3")), windowDays: Number(arg("window-days", "14")) });
  if (v.flaky.length) {
    const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "";
    mkdirSync(dirname(ledgerFile), { recursive: true });
    writeFileSync(ledgerFile, `${JSON.stringify([...ledger, ...v.flaky.map((name) => ({ name, at: today, sha }))], null, 2)}\n`);
    for (const n of v.flaky) console.log(`flaky: "${n}" failed, then passed on a re-run (written to ${arg("ledger", ".deploy/flakes.json")})`);
  }
  for (const n of v.quarantined) console.log(`quarantined until ${quarantine[n].until}: "${n}" failed (${quarantine[n].reason})`);
  if (v.bad.length) { console.log(`FLAKES_FAIL ${v.bad.length}:\n  ${v.bad.join("\n  ")}`); process.exit(1); }
  console.log(`FLAKES_OK runs=${runs.length} flaky=${v.flaky.length} quarantined=${v.quarantined.length}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
