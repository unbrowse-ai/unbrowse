#!/usr/bin/env node
// A rollback does not undo a migration. A new Durable Object migration (or a new SQL migration file) is the one kind
// of change the release train cannot take back, so it needs a written, rehearsed plan before it merges, and a migration
// that already shipped may never be edited.
//
//   node migration.mjs --base origin/staging [--manifest .deploy/manifest.json] [--plans .deploy/migrations]
//                      [--sql "migrations/,drizzle/"]
//
// Compares every Worker config the manifest names (and every file under the --sql folders) with the base ref.
//   a migration that existed at the base and is now different or gone   MIGRATION_FAIL (history was rewritten)
//   a new migration tag or SQL file                                      needs <plans>/<tag or file name>.md with four
//                                                                        sections, each with something in it:
//       ## Backup         where the data as it was is kept, and the command that takes that copy
//       ## Rehearsal      the run on a copy of production's data (a snapshot-seeded preview), with the marker it printed
//       ## Compatibility  why the code before this change still runs against the data after it (old and new overlap)
//       ## Rollback       what is done if it goes wrong, since rolling the code back will not undo it
// Ends with a success-only marker:  MIGRATION_OK none   or   MIGRATION_OK new=… planned=…     Else MIGRATION_FAIL, exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonc } from "./deploy.mjs";

export const SECTIONS = ["Backup", "Rehearsal", "Compatibility", "Rollback"];

/** New and rewritten migrations between two versions of one config's `migrations` list. Pure. */
export function compare(before = [], after = []) {
  const was = new Map(before.map((m) => [m.tag, JSON.stringify(m)])), now = new Map(after.map((m) => [m.tag, JSON.stringify(m)]));
  return {
    added: [...now.keys()].filter((t) => !was.has(t)),
    rewritten: [...was.keys()].filter((t) => !now.has(t) || now.get(t) !== was.get(t)),
  };
}

/** What a plan lacks: the sections with nothing (20+ characters) under them. [] when it is whole. */
export function planProblems(text) {
  const missing = [];
  for (const s of SECTIONS) {
    const m = new RegExp(`^##\\s+${s}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "mi").exec(String(text ?? ""));
    if (!m || m[1].replace(/<!--[\s\S]*?-->/g, "").trim().length < 20) missing.push(s);
  }
  return missing;
}

function main() {
  const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const root = resolve(arg("root", process.cwd())), base = arg("base");
  if (!base) { console.error("usage: migration.mjs --base <ref> [--manifest .deploy/manifest.json] [--plans .deploy/migrations] [--sql dir,dir]"); process.exit(2); }
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  if (git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).status) { console.log(`MIGRATION_FAIL cannot read the base ${base}: fetch it first`); process.exit(1); }
  const manifestPath = join(root, arg("manifest", ".deploy/manifest.json")), m = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  const configs = [...new Set((m.workers ?? []).flatMap((w) => Object.values(w.envs ?? {}).map((e) => e?.config).filter(Boolean)))];
  const plans = arg("plans", ".deploy/migrations"), bad = [], added = [];
  for (const c of configs) {
    if (!existsSync(join(root, c))) continue;
    const old = git("show", `${base}:${c}`), before = old.status ? [] : parseJsonc(old.stdout).migrations ?? [], after = parseJsonc(readFileSync(join(root, c), "utf8")).migrations ?? [];
    const d = compare(before, after);
    for (const t of d.rewritten) bad.push(`${c}: the migration "${t}" existed at ${base} and was changed or removed. A migration that has run is history: add a new one`);
    for (const t of d.added) added.push({ name: t, where: c });
  }
  const sql = String(arg("sql", m.migrations?.sql?.join(",") ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
  if (sql.length) {
    for (const row of git("diff", "--name-status", `${base}...HEAD`, "--", ...sql).stdout.split("\n").filter(Boolean)) {
      const [status, file] = row.split("\t");
      if (status === "A") added.push({ name: file.split("/").at(-1).replace(/\.[^.]+$/, ""), where: file });
      else bad.push(`${file}: a migration file that existed at ${base} was ${status === "D" ? "removed" : "edited"}. Add a new file instead`);
    }
  }
  let planned = 0;
  for (const a of added) {
    const file = join(root, plans, `${a.name}.md`);
    if (!existsSync(file)) { bad.push(`${a.where}: the new migration "${a.name}" has no plan. Write ${plans}/${a.name}.md with: ${SECTIONS.map((s) => `## ${s}`).join(", ")}`); continue; }
    const missing = planProblems(readFileSync(file, "utf8"));
    if (missing.length) bad.push(`${plans}/${a.name}.md says nothing under: ${missing.join(", ")}`); else planned++;
  }
  if (bad.length) { console.log(`MIGRATION_FAIL ${bad.length}:\n  ${bad.join("\n  ")}`); process.exit(1); }
  console.log(added.length ? `MIGRATION_OK new=${added.length} planned=${planned} (${added.map((a) => a.name).join(", ")})` : `MIGRATION_OK none configs=${configs.length}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
