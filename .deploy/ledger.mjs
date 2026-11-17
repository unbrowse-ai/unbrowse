#!/usr/bin/env node
// The record of every deploy: which code, which Worker versions, which bundle, did its gate pass, was it rolled back.
// Four questions are answered from it and from nothing else:
//
//   node ledger.mjs record --env staging --outcome ok|failed|rolled_back [--gate 5/5]
//        Written by deploy.mjs after every deploy. Kept in .deploy/.ledger.jsonl and, where `gh` can reach the repo
//        (--repo, GITHUB_REPOSITORY, or "repo": "owner/name" in the manifest), as a GitHub deployment, so a CI run,
//        a laptop and a second checkout read the same history. Without one, each checkout has its own.
//   node ledger.mjs artifact --env preprod                       hash each Worker's bundle and write it down
//   node ledger.mjs artifact --env production --same-as preprod  ARTIFACT_OK only when production would ship exactly
//        the bundle that preprod tested. Every environment builds again, so without this what was gated is not
//        provably what ships.
//   node ledger.mjs artifact --env <env> --auto                  what a workflow runs for every environment: the last
//        environment gated before production (preprod where the manifest has one, otherwise staging) writes its bundle
//        down, production is held to that one, and any other environment has nothing to do (ARTIFACT_SKIP).
//   node ledger.mjs drift --env production [--adopt]             DRIFT_OK only when every Worker runs the version the
//        last recorded deploy (or rollback) left there. Anything else was put there by hand. --adopt records what is
//        live now as the starting point, once, for a repo that joins the train with Workers already deployed.
//   node ledger.mjs previous --env production                    the versions production ran before its latest deploy,
//        as JSON (what a rollback goes back to when the machine doing it did not do the deploy)
//   node ledger.mjs stats [--days 30] [--env production]         deploys per week, the share that failed or were rolled
//        back, how long a failure took to put right, and how long a commit waited to ship.
//
// Markers: LEDGER_OK, ARTIFACT_OK, DRIFT_OK, LEDGER_STATS. Failures: ARTIFACT_FAIL, DRIFT_FAIL, LEDGER_FAIL, exit 1.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonc } from "./deploy.mjs";

/** One id for a bundle: its files (name and bytes), source maps left out since they carry paths, not behaviour. */
export function digestOf(entries) {
  const h = createHash("sha256");
  for (const [name, bytes] of [...entries].filter(([n]) => !n.endsWith(".map") && !/README/i.test(n)).sort(([a], [b]) => (a < b ? -1 : 1))) h.update(`${name}\n`).update(bytes).update("\n");
  return h.digest("hex").slice(0, 32);
}

/** The last environment a release is gated in before production: preprod where the manifest has one, otherwise staging. */
export function testedEnv(m) { return (m?.workers ?? []).some((w) => w.envs?.preprod) ? "preprod" : "staging"; }

/** Why two environments' bundles are not the same ([] when they are). Keys are the manifest's Worker names. */
export function sameArtifact(tested, shipping, from, to) {
  const bad = [];
  for (const [w, d] of Object.entries(shipping)) {
    if (!tested?.[w]) bad.push(`${w}: there is no record of ${from} building it from this code`);
    else if (tested[w] !== d) bad.push(`${w}: ${to} would ship bundle ${d.slice(0, 12)} but ${from} tested ${tested[w].slice(0, 12)} (a build-time value that differs by environment, or a different dependency install)`);
  }
  return bad;
}

/** Workers running a version the last recorded deploy did not leave there. `live` and `record.workers` are { name: version }. */
export function driftOf(live, record) {
  if (!record) return Object.keys(live).map((n) => `${n}: no deploy of this environment is on the ledger (--adopt records what is live as the start)`);
  return Object.entries(live).filter(([n, v]) => record.workers?.[n] !== v)
    .map(([n, v]) => `${n} runs version ${String(v).slice(0, 8)}, but the last recorded deploy (${record.at}, ${record.outcome}) left ${String(record.workers?.[n] ?? "nothing").slice(0, 8)}: it was changed outside the train`);
}

/**
 * What an environment ran before its latest deploy: the Workers of the newest record that left it on other versions and
 * was not itself taken back. A deploy that was followed by a rollback is not something to return to, and an environment
 * whose last record is a rollback is already on its previous version ({}: there is nothing further to go back to).
 */
export function previousOf(records, env) {
  const mine = records.filter((r) => r.env === env && r.outcome !== "drill"), last = mine.at(-1), same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
  if (!last || last.outcome === "rolled_back") return {};
  return mine.slice(0, -1).filter((r, i) => (r.outcome === "rolled_back" || (["ok", "adopted"].includes(r.outcome) && mine[i + 1]?.outcome !== "rolled_back")) && !same(r.workers, last.workers)).at(-1)?.workers ?? {};
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
/** The four numbers a team steers by, from the records alone. Pure. */
export function stats(records, nowMs, days = 30, env = "production") {
  const mine = records.filter((r) => r.env === env && !["adopted", "drill"].includes(r.outcome)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const inWindow = mine.filter((r) => nowMs - Date.parse(r.at) <= days * 86_400_000), failed = inWindow.filter((r) => r.outcome !== "ok");
  const restores = [], open = [];
  for (const f of failed) { const next = mine.find((r) => r.outcome === "ok" && Date.parse(r.at) > Date.parse(f.at)); if (next) restores.push((Date.parse(next.at) - Date.parse(f.at)) / 60_000); else open.push(f.at); }
  const leads = inWindow.filter((r) => r.outcome === "ok" && r.committed_at).map((r) => (Date.parse(r.at) - Date.parse(r.committed_at)) / 3600_000);
  return { deploys: inWindow.length, failed: failed.length, failureRate: inWindow.length ? failed.length / inWindow.length : null, restoreMin: median(restores), unrestored: open.length, perWeek: inWindow.length / (days / 7), leadHours: median(leads) };
}

// ---------- the store: a local file, and GitHub deployments where the repo can be reached ----------

const sh = (bin, args, opts = {}) => { const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts }); return { code: r.status ?? 1, out: `${r.stdout ?? ""}`, err: `${r.stderr ?? ""}` }; };
const gh = (args, opts) => sh(process.env.GH_BIN ?? "gh", args, opts);
/** `gh api --paginate` prints one JSON array per page, end to end: all of them as one list. */
export function pages(text) { const t = String(text ?? "").trim(); try { return JSON.parse(t); } catch { return JSON.parse(t.replace(/\]\s*\[/g, ",")); } }
/** The records a manifest pinned to a Cloudflare account counts as its own: those that account's deploys wrote. Without
 *  a pin, all of them (a repo with one account). Version ids are per account: another account's are no rollback target. */
export function ofAccount(records, account = "") { return account ? records.filter((r) => r.account === account) : records; }
export function load(root, repo) {
  const file = join(root, ".deploy/.ledger.jsonl"), recs = new Map();
  if (existsSync(file)) for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean)) { try { const r = JSON.parse(l); recs.set(r.id, r); } catch { /* a torn line */ } }
  if (repo) {
    // Only the train's own records (task release-train), and every page of them: GitHub makes a deployment of its own
    // for each job that names an environment, which would push ours out of any one page within a day.
    const r = gh(["api", "--paginate", `repos/${repo}/deployments?task=release-train&per_page=100`]);
    if (r.code === 0) { try { for (const d of pages(r.out)) { const p = typeof d.payload === "string" ? JSON.parse(d.payload || "{}") : d.payload; if (p?.train && p.id) recs.set(p.id, p); } } catch { /* not a list: nothing to add */ } }
  }
  return [...recs.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
export function save(root, repo, rec) {
  mkdirSync(join(root, ".deploy"), { recursive: true });
  appendFileSync(join(root, ".deploy/.ledger.jsonl"), `${JSON.stringify(rec)}\n`);
  if (!repo) return "file";
  const made = gh(["api", `repos/${repo}/deployments`, "-X", "POST", "--input", "-"], { input: JSON.stringify({ ref: rec.sha, environment: rec.env, task: "release-train", auto_merge: false, required_contexts: [], description: `${rec.outcome} ${rec.gate ?? ""}`.trim(), payload: rec }) });
  let id = null; try { id = JSON.parse(made.out).id; } catch { /* refused */ }
  if (made.code || !id) return `file (GitHub refused it: ${(made.err || made.out).trim().split("\n").at(-1).slice(0, 120)})`;
  gh(["api", `repos/${repo}/deployments/${id}/statuses`, "-X", "POST", "-f", `state=${rec.outcome === "failed" ? "failure" : rec.outcome === "rolled_back" ? "inactive" : "success"}`]);
  return "file+github";
}

function main() {
  const argv = process.argv.slice(2), cmd = argv[0], arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const root = resolve(arg("root", process.cwd())), env = arg("env");
  const git = (...a) => sh("git", a, { cwd: root }).out.trim(), wrangler = (args) => sh("npx", ["--no-install", "wrangler", ...args], { cwd: root });
  const manifestPath = resolve(root, arg("manifest", ".deploy/manifest.json")), m = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { workers: [] };
  const account = String(m.account ?? ""), mark = account ? { account } : {}, records = () => ofAccount(load(root, repo), account);
  // One ledger for every checkout and for CI: GitHub's deployments of the repo named by --repo, by CI, or by the
  // manifest ("repo": "owner/name"). With none of them the ledger is this checkout's file alone.
  const repo = process.env.LEDGER_GITHUB === "off" ? "" : arg("repo", process.env.GITHUB_REPOSITORY || m.repo || "");
  const workers = (m.workers ?? []).map((w) => ({ key: w.name, config: w.envs?.[env]?.config, build: w.build })).filter((w) => w.config && existsSync(join(root, w.config)));
  const tree = git("rev-parse", "HEAD^{tree}"), artFile = join(root, ".deploy/.artifacts.json"), arts = existsSync(artFile) ? JSON.parse(readFileSync(artFile, "utf8")) : {};
  const live = () => Object.fromEntries(workers.map((w) => { const d = wrangler(["deployments", "status", "-c", w.config, "--json"]); let v = ""; try { v = JSON.parse(d.out.slice(d.out.indexOf("{"))).versions?.[0]?.version_id ?? ""; } catch { /* not deployed yet */ } return [parseJsonc(readFileSync(join(root, w.config), "utf8")).name, v]; }));
  const needEnv = () => { if (!env || !workers.length) { console.error(`usage: ledger.mjs ${cmd} --env <environment the manifest has Workers for>`); process.exit(2); } };

  if (cmd === "record") {
    needEnv();
    // A rollback drill leaves the environment as it was: it is on the ledger (so it is not drift) but it is no deploy,
    // and never stands in for one in a sign-off, a bundle check or the numbers.
    const outcome = arg("gate", "").startsWith("drill") ? "drill" : arg("outcome", "ok");
    if (!["ok", "failed", "rolled_back", "adopted", "drill"].includes(outcome)) { console.error("--outcome is ok, failed or rolled_back"); process.exit(2); }
    const at = new Date().toISOString(), sha = git("rev-parse", "HEAD");
    const rec = { train: 1, id: `${env}-${at}`, env, at, sha, tree, ref: process.env.GITHUB_REF_NAME || git("rev-parse", "--abbrev-ref", "HEAD"), committed_at: git("show", "-s", "--format=%cI", "HEAD"), outcome, gate: arg("gate", ""), workers: live(), digests: arts[tree]?.[env] ?? {}, by: process.env.GITHUB_ACTOR || "local", ...mark };
    console.log(`LEDGER_OK env=${env} outcome=${outcome} sha=${sha.slice(0, 7)} workers=${Object.keys(rec.workers).length} store=${save(root, repo, rec)}`);
  } else if (cmd === "artifact") {
    const tested = testedEnv(m), auto = argv.includes("--auto");
    if (auto && env !== tested && env !== "production") { console.log(`ARTIFACT_SKIP env=${env}: production is held to the bundle ${tested} tests, not this one`); return; }
    needEnv();
    const mine = {};
    for (const w of workers) {
      // What the Worker needs built or installed first (the manifest's `build`), exactly as the deploy does it.
      if (w.build) { const b = sh("sh", ["-c", w.build], { cwd: root }); if (b.code) { console.log(`ARTIFACT_FAIL ${w.key}: its build step failed:\n${`${b.out}${b.err}`.slice(-1200)}`); process.exit(1); } }
      const out = mkdtempSync(join(tmpdir(), "rt-bundle-")), r = wrangler(["deploy", "--dry-run", "--outdir", out, "-c", w.config]);
      const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)])), files = r.code ? [] : walk(out);
      if (!files.length) { console.log(`ARTIFACT_FAIL ${w.key}: the bundle could not be built for ${env}:\n${`${r.out}${r.err}`.slice(-1200)}`); process.exit(1); }
      mine[w.key] = digestOf(files.map((f) => [relative(out, f), readFileSync(f)]));
    }
    (arts[tree] ??= {})[env] = mine;
    writeFileSync(artFile, `${JSON.stringify(Object.fromEntries(Object.entries(arts).slice(-20)), null, 1)}\n`);
    const from = arg("same-as") ?? (auto && env === "production" ? tested : undefined);
    // A repo whose environments are built differently on purpose says so, with the reason, and is told every time.
    const differs = typeof m.artifact?.differs === "string" && m.artifact.differs.trim().length >= 15 ? m.artifact.differs.trim() : "";
    if (from && differs) { console.log(`ARTIFACT_WAIVED env=${env}: not held to ${from}'s bundle (${differs}). What is gated there is not provably what ships here`); return; }
    if (from) {
      const tested = arts[tree]?.[from] ?? records().filter((r) => r.env === from && r.tree === tree && r.outcome === "ok").at(-1)?.digests;
      const bad = sameArtifact(tested, mine, from, env);
      if (bad.length) { console.log(`ARTIFACT_FAIL ${bad.length}:\n  ${bad.join("\n  ")}`); process.exit(1); }
    }
    console.log(`ARTIFACT_OK env=${env} workers=${workers.length}${from ? ` same_as=${from}` : ""} ${Object.entries(mine).map(([k, d]) => `${k}=${d.slice(0, 12)}`).join(" ")}`);
  } else if (cmd === "drift") {
    needEnv();
    const now = live(), last = records().filter((r) => r.env === env).at(-1);
    if (argv.includes("--adopt") && !last) { const at = new Date().toISOString(); console.log(`LEDGER_OK env=${env} outcome=adopted workers=${Object.keys(now).length} store=${save(root, repo, { train: 1, id: `${env}-${at}`, env, at, sha: git("rev-parse", "HEAD"), tree, outcome: "adopted", workers: now, digests: {}, by: process.env.GITHUB_ACTOR || "local", ...mark })}`); return; }
    const bad = driftOf(now, last);
    if (bad.length) { console.log(`DRIFT_FAIL env=${env} ${bad.length}:\n  ${bad.join("\n  ")}`); process.exit(1); }
    console.log(`DRIFT_OK env=${env} workers=${Object.keys(now).length} as_of=${last.at}`);
  } else if (cmd === "previous") {
    needEnv();
    const prev = previousOf(records(), env);
    if (!Object.keys(prev).length) { console.log(`LEDGER_FAIL env=${env}: no earlier good deploy with other versions is on the ledger`); process.exit(1); }
    console.log(`LEDGER_PREVIOUS env=${env} ${JSON.stringify(prev)}`);
  } else if (cmd === "stats") {
    const days = Number(arg("days", "30")), e = env ?? "production", s = stats(records(), Date.now(), days, e), n = (x, f = 1) => (x === null ? "none" : x.toFixed(f));
    console.log(`LEDGER_STATS env=${e} days=${days} deploys=${s.deploys} failed=${s.failed} change_failure_rate=${s.failureRate === null ? "none" : `${(100 * s.failureRate).toFixed(1)}%`} restore_median_min=${n(s.restoreMin, 0)} unrestored=${s.unrestored} per_week=${n(s.perWeek)} lead_median_h=${n(s.leadHours)}`);
  } else { console.error("usage: ledger.mjs record|artifact|drift|previous|stats --env <env> [...]"); process.exit(2); }
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
