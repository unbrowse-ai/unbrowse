#!/usr/bin/env node
// How much of the code the unit tests run, as a number that may only go up, and whether the lines this change adds are
// run by a test. Reads lcov (bun test --coverage --coverage-reporter=lcov, vitest --coverage, c8, pytest-cov, …).
//
//   node line-coverage.mjs --lcov coverage/lcov.info [--lcov more.info] [--baseline .deploy/line-coverage.json]
//                          [--base origin/staging] [--min-diff 80] [--run "bun test --coverage --coverage-reporter=lcov"]
//                          [--ignore "scripts/"] [--update]
//
// Two verdicts:
//   the ratchet  total line coverage may not fall more than 0.1 points under the recorded baseline. There is no baseline
//                until one is measured: the first run is `--update`, which writes the number down. A floor nobody
//                measured is a guess. `--update` afterwards records a gain and never a loss.
//   the change   (with --base) of the lines this change adds to source files, the share a test runs. A source file the
//                change adds that no test even loads counts as not run at all.
//                Run it where the tests run (a package folder inside a repository is fine: the comparison is of that
//                folder, with paths as the coverage report has them).
// Ends with a success-only marker:  LINES_OK total=…% baseline=…% changed=…% (n/m)     Else LINES_FAIL, exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/;
const NOT_SOURCE = /(\.test\.|\.spec\.|\.d\.ts$|(^|\/)(tests?|__tests__|node_modules|dist|vendor|coverage)\/|\.config\.)/;

/** lcov text → Map(file → Map(line → times run)). Paths are made relative to `root` so they match git's. */
export function parseLcov(text, root = "") {
  const files = new Map(); let cur = null;
  for (const row of String(text ?? "").split("\n")) {
    if (row.startsWith("SF:")) { const p = row.slice(3).trim(), rel = root && isAbsolute(p) ? relative(root, p) : p.replace(/^\.\//, ""); cur = files.get(rel) ?? new Map(); files.set(rel, cur); }
    else if (row.startsWith("DA:") && cur) { const [line, hits] = row.slice(3).split(","); cur.set(Number(line), Math.max(cur.get(Number(line)) ?? 0, Number(hits))); }
  }
  return files;
}

/** { found, hit, pct } over every file (optionally leaving some out). */
export function totals(files, ignore = []) {
  const skip = ignore.map((p) => new RegExp(p)); let found = 0, hit = 0;
  for (const [file, lines] of files) { if (skip.some((re) => re.test(file))) continue; for (const n of lines.values()) { found++; if (n > 0) hit++; } }
  return { found, hit, pct: found ? (100 * hit) / found : 0 };
}

/** `git diff -U0` text → Map(file → [added line numbers]). */
export function addedLines(diff) {
  const out = new Map(); let file = null;
  for (const row of String(diff ?? "").split("\n")) {
    if (row.startsWith("+++ ")) { file = row === "+++ /dev/null" ? null : row.slice(4).replace(/^b\//, ""); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (!m || !file) continue;
    const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]), list = out.get(file) ?? [];
    for (let i = 0; i < count; i++) list.push(start + i);
    if (list.length) out.set(file, list);
  }
  return out;
}

/** Of the lines a change adds to source files, which a test runs. Lines lcov does not count (comments, braces) are left out. */
export function changed(files, added, ignore = []) {
  const skip = ignore.map((p) => new RegExp(p)); let found = 0, hit = 0; const missed = [];
  for (const [file, lines] of added) {
    if (!SOURCE.test(file) || NOT_SOURCE.test(file) || skip.some((re) => re.test(file))) continue;
    const cov = files.get(file);
    if (!cov) { found += lines.length; missed.push(`${file}: no test loads it (${lines.length} new lines)`); continue; }
    const not = lines.filter((n) => cov.has(n) && cov.get(n) === 0);
    found += lines.filter((n) => cov.has(n)).length; hit += lines.filter((n) => cov.get(n) > 0).length;
    if (not.length) missed.push(`${file}: lines ${not.slice(0, 12).join(", ")}${not.length > 12 ? ` and ${not.length - 12} more` : ""}`);
  }
  return { found, hit, pct: found ? (100 * hit) / found : 100, missed };
}

/** Why the total may not stand ("" when it may): no baseline, or under it. */
export function ratchet(pct, baseline, slack = 0.1) {
  if (typeof baseline?.total !== "number") return "there is no recorded baseline yet: measure one with --update (a floor nobody measured is a guess)";
  return pct < baseline.total - slack ? `line coverage fell from ${baseline.total.toFixed(2)}% to ${pct.toFixed(2)}%: the code this change adds or uncovers needs a test (--update records a gain, never a loss)` : "";
}

function main() {
  const argv = process.argv.slice(2), all = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : [])), arg = (n, d) => all(n)[0] ?? d;
  const root = resolve(arg("root", process.cwd())), lcovs = all("lcov"), ignore = all("ignore");
  if (!lcovs.length) { console.error("usage: line-coverage.mjs --lcov <lcov.info> [--baseline file] [--base ref] [--min-diff 80] [--run cmd] [--update]"); process.exit(2); }
  if (arg("run")) {
    const r = spawnSync("sh", ["-c", arg("run")], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status) { console.log(`LINES_FAIL the tests did not pass, so nothing was measured:\n${`${r.stdout}${r.stderr}`.slice(-2000)}`); process.exit(1); }
  }
  const missing = lcovs.filter((f) => !existsSync(join(root, f)));
  if (missing.length) { console.log(`LINES_FAIL no coverage report at ${missing.join(", ")}: run the tests with an lcov reporter first (or pass --run)`); process.exit(1); }
  const files = new Map();
  for (const f of lcovs) for (const [k, v] of parseLcov(readFileSync(join(root, f), "utf8"), root)) files.set(k, v);
  const t = totals(files, ignore);
  if (!t.found) { console.log("LINES_FAIL the coverage report counts no lines at all"); process.exit(1); }
  const baseFile = join(root, arg("baseline", ".deploy/line-coverage.json")), baseline = existsSync(baseFile) ? JSON.parse(readFileSync(baseFile, "utf8")) : null;
  const bad = [];
  if (argv.includes("--update")) {
    const total = Math.max(Number(t.pct.toFixed(2)), baseline?.total ?? 0);
    writeFileSync(baseFile, `${JSON.stringify({ total, lines: t.found, at: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);
    console.log(`baseline ${baseline ? `${baseline.total}% -> ` : ""}${total}% written to ${relative(root, baseFile)}`);
  } else { const why = ratchet(t.pct, baseline); if (why) bad.push(why); }
  let ch = null;
  if (arg("base")) {
    const d = spawnSync("git", ["diff", "-U0", "--no-color", "--relative", `${arg("base")}...HEAD`], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });
    if (d.status) bad.push(`cannot compare with ${arg("base")}: ${d.stderr.trim().split("\n").at(-1)}`);
    else {
      ch = changed(files, addedLines(d.stdout), ignore);
      const min = Number(arg("min-diff", "80"));
      if (ch.pct < min) bad.push(`tests run ${ch.pct.toFixed(1)}% of the lines this change adds (${ch.hit}/${ch.found}); the floor is ${min}%:\n    ${ch.missed.slice(0, 15).join("\n    ")}`);
    }
  }
  if (bad.length) { console.log(`LINES_FAIL ${bad.length}:\n  ${bad.join("\n  ")}`); process.exit(1); }
  const recorded = existsSync(baseFile) ? JSON.parse(readFileSync(baseFile, "utf8")).total : t.pct;
  console.log(`LINES_OK total=${t.pct.toFixed(2)}% baseline=${recorded.toFixed(2)}% files=${files.size}${ch ? ` changed=${ch.pct.toFixed(1)}% (${ch.hit}/${ch.found})` : ""}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
