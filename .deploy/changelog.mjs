#!/usr/bin/env node
// What a release changes, in words for the people who use the product. Printed to stdout, for an `after.<env>` command
// to send wherever the team reads (a channel, a person).
//
//   node changelog.mjs [--notes .deploy/release-notes/next.md] [--from <commit>] [--to <commit>] [--title "…"] [--max 12]
//
// --notes: a note someone wrote for this release. It is used as it is when the file changed since the last release
//   (a note left over from an earlier release is never sent twice). Write one whenever the commit subjects would not
//   mean much to the reader.
// Otherwise the note is built from commit subjects between the last release and this one (RELEASE_PREVIOUS and
// RELEASE_COMMIT, which deploy.mjs gives an `after` command; --from/--to override), submodules included: `feat` is New,
// `fix` is Fixed, `perf` is Faster; chores, tests, CI and docs are left out, and so is anything scoped to the pipeline
// itself (`fix(gate): …`, `fix(ci): …`); each line loses its prefix.
// With nothing to say it prints nothing and exits 3, so a release with only internal changes sends no message.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HEADS = { feat: "New", fix: "Fixed", perf: "Faster" };
const INTERNAL = /^(ci|gate|gates|test|tests|build|deps|vendor|harness|dev|release|deploy)$/i;
/** Commit subjects → the note's lines, grouped. Pure. */
export function noteFrom(subjects, { title = "", max = 12 } = {}) {
  const groups = { New: [], Fixed: [], Faster: [] }, seen = new Set();
  for (const s of subjects) {
    const m = /^(feat|fix|perf)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(String(s).trim());
    // A fix to the pipeline, the gates or the tests is not something a user of the product notices.
    if (!m || INTERNAL.test(m[2] ?? "")) continue;
    m.splice(2, 1);
    const text = m[2].trim().replace(/\s*\(#\d+\)$/, ""), line = text[0].toUpperCase() + text.slice(1);
    if (seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    groups[HEADS[m[1]]].push(line);
  }
  const total = Object.values(groups).flat().length;
  if (!total) return "";
  const out = title ? [title, ""] : [];
  let left = max;
  for (const [head, lines] of Object.entries(groups)) {
    if (!lines.length || left <= 0) continue;
    out.push(`${head}:`, ...lines.slice(0, left).map((l) => `• ${l}`));
    left -= lines.length;
  }
  if (total > max) out.push(`…and ${total - max} more.`);
  return out.join("\n");
}
/** Subjects between two commits, with the commits of every submodule whose pin moved. */
export function subjectsBetween(from, to, cwd = process.cwd()) {
  const git = (...a) => spawnSync("git", a, { cwd, encoding: "utf8" }).stdout ?? "";
  const own = git("log", "--no-merges", "--format=%s", `${from}..${to}`).split("\n").filter(Boolean);
  // `--submodule=log` lists a moved submodule's commits as "  > subject" lines.
  const inside = git("diff", "--submodule=log", from, to).split("\n").filter((l) => /^ {2}> /.test(l)).map((l) => l.slice(4));
  return [...inside, ...own];
}

function main() {
  const argv = process.argv.slice(2), arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
  const from = arg("from", process.env.RELEASE_PREVIOUS ?? ""), to = arg("to", process.env.RELEASE_COMMIT || "HEAD"), notes = arg("notes");
  const changed = (file) => !from || spawnSync("git", ["diff", "--quiet", from, to, "--", file]).status !== 0;
  if (notes && existsSync(notes) && readFileSync(notes, "utf8").trim() && changed(notes)) { console.log(readFileSync(notes, "utf8").trim()); return; }
  if (!from) { console.error("changelog: no earlier release to compare with (RELEASE_PREVIOUS or --from), and no note written for this one"); process.exit(3); }
  const text = noteFrom(subjectsBetween(from, to), { title: arg("title", ""), max: Number(arg("max", "12")) });
  if (!text) { console.error("changelog: nothing a user would notice between the two releases"); process.exit(3); }
  console.log(text);
}
// Run as a command (through a symlinked path too), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
