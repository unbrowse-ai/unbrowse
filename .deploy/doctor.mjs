#!/usr/bin/env node
// Is this repo able to ride the release train at all? Asked before any push, so a missing secret or an unprotected
// branch is found now and not at the last step of a pipeline that already ran for ten minutes.
//
//   node doctor.mjs [--repo owner/name] [--fix] [--local] [--skill <the skill's folder>]
//
// Looks at the checkout (manifest, the train's scripts and workflows, .gitignore, the branching rules in the guide, the
// flag registry) and, through `gh`, at the repository (the four environments and their secrets, the default branch, the
// merge settings, branch protection). --local skips the repository. --fix does what a command can do: copies missing
// scripts and workflows from the skill, replaces a script that is not the skill's current version, adds the ignore lines, creates environments, sets squash-only merging, the
// default branch and branch protection. It never invents a secret: those are listed as needing a person.
// Ends with a success-only marker:  DOCTOR_OK checks=… fixed=…        Else DOCTOR_FAIL with every finding, exit 1.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Every script the train is made of. They are copied whole and never edited in a repo: they call each other.
export const SCRIPTS = ["deploy.mjs", "soak.mjs", "release.mjs", "ledger.mjs", "pr-rules.mjs", "line-coverage.mjs", "flake.mjs", "migration.mjs", "signoff.mjs", "review.mjs", "fix.mjs", "workflow-lint.mjs", "doctor.mjs",
  "mcp-audit.mjs", "mcp-compat.mjs", "mcp-coverage.mjs", "http-smoke.mjs", "sim.mjs", "connections.mjs", "changelog.mjs", "traffic.mjs", "vibestack.mjs"];
export const WORKFLOWS = ["ci.yml", "deploy.yml", "promote.yml", "main-source-guard.yml", "preview-cleanup.yml", "watch.yml", "autofix.yml"];
const IGNORES = [".wrangler.preview.*", ".deploy/.*"];
const ENVS = ["preview", "staging", "preprod", "production"];

/**
 * Keys a JSON text names twice in one object (with the path to it). JSON.parse keeps the last and says nothing, so two
 * branches that each add "watch" merge without a conflict and one of them is silently gone.
 */
export function duplicateKeys(text) {
  const out = [], stack = []; let i = 0; const s = String(text ?? "");
  const str = () => { let j = i + 1; while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1; const v = s.slice(i + 1, j); i = j + 1; return v; };
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { const v = str(), top = stack.at(-1); let k = i; while (/\s/.test(s[k] ?? "")) k++; if (top?.keys && s[k] === ":") { if (top.keys.has(v)) out.push([...stack.map((f) => f.name).filter(Boolean), v].join(".")); top.keys.add(v); top.last = v; } continue; }
    if (c === "{") stack.push({ keys: new Set(), name: stack.at(-1)?.last ?? "" });
    else if (c === "[") stack.push({ name: stack.at(-1)?.last ?? "" });
    else if (c === "}" || c === "]") stack.pop();
    i++;
  }
  return out;
}

/**
 * Every finding about a repo, from what was read of it. Pure: `state` is plain data.
 * A finding is { ok, text, fix?: { kind, ... }, person?: true } — `fix` is something --fix can do, `person` is something
 * only a person can (a secret, a decision).
 */
export function diagnose(s) {
  const out = [], add = (ok, text, extra = {}) => out.push({ ok: !!ok, text, ...extra }), m = s.manifest;
  add(m, "the manifest .deploy/manifest.json exists and parses", { person: true });
  for (const k of s.duplicates ?? []) add(false, `the manifest names "${k}" once (it is there twice, and JSON keeps only the last: a merge of two branches does this without a conflict)`, { person: true });
  const used = ENVS.filter((e) => e === "preview" || (m?.workers ?? []).some((w) => w.envs?.[e]));
  if (m) {
    const layers = new Set((m.checks ?? []).map((c) => c.layer));
    add(layers.has("unit") && (layers.has("static") || layers.has("types")), "the manifest's checks include types or lint (layer static) and unit tests (layer unit)", { person: true });
    for (const e of used) add((m.gates?.[e] ?? m.gates?.default ?? []).length, `the manifest has a gate for ${e}: a deploy nothing tests is not a deploy`, { person: true });
    if (used.includes("production")) add((Array.isArray(m.watch?.production) ? m.watch.production : m.watch?.production?.run ?? []).length, "the manifest watches production after a deploy (watch.production)", { person: true });
  }
  for (const f of SCRIPTS) add(s.scripts.includes(f), `.deploy/${f} is here`, { fix: { kind: "copy", from: `scripts/${f}`, to: `.deploy/${f}` } });
  for (const f of s.stale ?? []) add(false, `.deploy/${f} is the skill's current version (this copy is older or was edited here)`, { fix: { kind: "copy", from: `scripts/${f}`, to: `.deploy/${f}` } });
  for (const f of WORKFLOWS) add(s.workflows.includes(f), `.github/workflows/${f} is here`, { fix: { kind: "copy", from: `assets/workflows/${f}`, to: `.github/workflows/${f}` } });
  for (const line of IGNORES) add(s.gitignore.split("\n").map((l) => l.trim()).includes(line), `.gitignore has ${line}`, { fix: { kind: "ignore", line } });
  add(/Branching rules/i.test(s.guide), "the repo's CLAUDE.md states the branching rules (the block in references/branching.md)", { person: true });
  for (const [name, f] of Object.entries(s.flags ?? {})) {
    add(f?.owner && /^\d{4}-\d{2}-\d{2}$/.test(f?.expires ?? ""), `the flag "${name}" has an owner and an expiry date (.deploy/flags.json)`, { person: true });
    if (/^\d{4}-\d{2}-\d{2}$/.test(f?.expires ?? "")) add(f.expires >= s.today, `the flag "${name}" has not outlived its date (${f.expires}): remove the flag and the path it no longer guards`, { person: true });
  }
  if (!s.repo) return out;
  const r = s.repo, api = `repos/${r.full_name}`;
  for (const e of used) {
    add(s.environments.includes(e), `the GitHub environment ${e} exists`, { fix: { kind: "gh", args: ["api", `${api}/environments/${e}`, "-X", "PUT"] } });
    for (const sec of [...(m?.doctor?.secrets ?? ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])]) add((s.secrets[e] ?? []).includes(sec) || s.secrets.repo.includes(sec), `the secret ${sec} is set for ${e}`, { person: true });
  }
  if (m?.sims || s.workflows.includes("autofix.yml")) add(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"].some((k) => s.secrets.repo.includes(k) || ENVS.some((e) => (s.secrets[e] ?? []).includes(k))), "an agent credential (CLAUDE_CODE_OAUTH_TOKEN) is set: simulated people, the reviewer and the fixer run on it", { person: true });
  add(r.default_branch === "staging", `the default branch is staging (it is ${r.default_branch})`, s.branches.includes("staging") ? { fix: { kind: "gh", args: ["api", api, "-X", "PATCH", "-f", "default_branch=staging"] } } : { person: true });
  add(r.allow_squash_merge && !r.allow_merge_commit && !r.allow_rebase_merge, "merging is squash only (one commit per change, so a release's notes are its changes)", { fix: { kind: "gh", args: ["api", api, "-X", "PATCH", "-F", "allow_squash_merge=true", "-F", "allow_merge_commit=false", "-F", "allow_rebase_merge=false"] } });
  for (const b of ["staging", "main"].filter((x) => s.branches.includes(x))) {
    const p = s.protection[b], need = b === "main" ? ["checks", "guard"] : ["checks"], have = p?.required_status_checks?.contexts ?? (p?.required_status_checks?.checks ?? []).map((c) => c.context);
    const body = { required_status_checks: { strict: false, contexts: need }, enforce_admins: false, required_pull_request_reviews: { required_approving_review_count: 0 }, restrictions: null, allow_force_pushes: false, allow_deletions: false };
    add(p && p.required_pull_request_reviews && need.every((c) => have.includes(c)) && !p.allow_force_pushes?.enabled, `${b} is protected: pull requests only, the checks ${need.join(" and ")} required, no force pushes`, { fix: { kind: "gh", args: ["api", `${api}/branches/${b}/protection`, "-X", "PUT", "--input", "-"], input: JSON.stringify(body) } });
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; }, has = (n) => argv.includes(`--${n}`);
  // The skill this script belongs to: beside it when run from the skill, otherwise (a repo's copy in .deploy/) where
  // skills are installed, or wherever RELEASE_TRAIN_SKILL says.
  const beside = join(dirname(fileURLToPath(import.meta.url)), ".."), installed = join(process.env.HOME ?? "", ".claude", "skills", "cf-release-train");
  const root = resolve(arg("root", process.cwd())), skill = resolve(arg("skill", process.env.RELEASE_TRAIN_SKILL || (existsSync(join(beside, "assets", "workflows")) ? beside : installed)));
  const gh = (args, input) => { const r = spawnSync(process.env.GH_BIN ?? "gh", args, { cwd: root, encoding: "utf8", input }); return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" }; };
  const json = (args, dflt) => { const r = gh(args); try { return r.code ? dflt : JSON.parse(r.out); } catch { return dflt; } };
  const read = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : ""), ls = (d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)) : []);
  const look = () => {
    let manifest = null; try { manifest = JSON.parse(read(".deploy/manifest.json")); } catch { /* missing or broken: a finding */ }
    let flags = null; try { flags = JSON.parse(read(".deploy/flags.json") || "null"); } catch { flags = { "(unreadable .deploy/flags.json)": {} }; }
    const stale = SCRIPTS.filter((f) => existsSync(join(root, ".deploy", f)) && existsSync(join(skill, "scripts", f)) && read(`.deploy/${f}`) !== readFileSync(join(skill, "scripts", f), "utf8"));
    const s = { manifest, flags, stale, duplicates: duplicateKeys(read(".deploy/manifest.json")), scripts: ls(".deploy"), workflows: ls(".github/workflows"), gitignore: read(".gitignore"), guide: read("CLAUDE.md") || read("AGENTS.md"), today: new Date().toISOString().slice(0, 10), repo: null };
    if (has("local")) return s;
    const name = arg("repo", process.env.GITHUB_REPOSITORY || gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).out.trim());
    const repo = name ? json(["api", `repos/${name}`], null) : null;
    if (!repo?.full_name) return { ...s, unreachable: name || "(no repository: pass --repo owner/name, or --local to check the checkout alone)" };
    const names = (path) => (json(["api", path], {}).secrets ?? []).map((x) => x.name);
    const environments = (json(["api", `repos/${name}/environments`], {}).environments ?? []).map((e) => e.name);
    const branches = json(["api", `repos/${name}/branches?per_page=100`], []).map((b) => b.name);
    return { ...s, repo, environments, branches, secrets: { repo: names(`repos/${name}/actions/secrets`), ...Object.fromEntries(environments.map((e) => [e, names(`repos/${name}/environments/${e}/secrets`)])) },
      protection: Object.fromEntries(["staging", "main"].filter((b) => branches.includes(b)).map((b) => [b, json(["api", `repos/${name}/branches/${b}/protection`], null)])) };
  };
  let state = look(), fixed = 0;
  if (state.unreachable) { console.log(`DOCTOR_FAIL the repository ${state.unreachable} cannot be read with gh: nothing about it was checked`); process.exit(1); }
  if (has("fix")) {
    for (const f of diagnose(state).filter((x) => !x.ok && x.fix)) {
      const x = f.fix; let ok = false;
      if (x.kind === "copy" && existsSync(join(skill, x.from))) { mkdirSync(dirname(join(root, x.to)), { recursive: true }); copyFileSync(join(skill, x.from), join(root, x.to)); ok = true; }
      else if (x.kind === "ignore") { appendFileSync(join(root, ".gitignore"), `${read(".gitignore").endsWith("\n") || !read(".gitignore") ? "" : "\n"}${x.line}\n`); ok = true; }
      else if (x.kind === "gh") ok = gh(x.args, x.input).code === 0;
      console.log(`${ok ? "fixed" : "could not fix"}: ${f.text}`);
      if (ok) fixed++;
    }
    state = look();
  }
  const found = diagnose(state), bad = found.filter((f) => !f.ok);
  for (const f of found) console.log(`${f.ok ? "ok  " : "FAIL"} ${f.text}${f.ok ? "" : f.person ? "  (needs a person)" : "  (--fix does this)"}`);
  if (bad.length) { console.log(`DOCTOR_FAIL ${bad.length} of ${found.length}: ${bad.filter((f) => f.person).length} need a person, ${bad.filter((f) => !f.person).length} --fix can do`); process.exit(1); }
  console.log(`DOCTOR_OK checks=${found.length} fixed=${fixed}${state.repo ? ` repo=${state.repo.full_name}` : " (checkout only)"}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
