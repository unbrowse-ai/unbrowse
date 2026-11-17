#!/usr/bin/env node
// A vibestack project on the train (github.com/lekt9/vibestack: stories and rules in one Markdown spec, Quint under
// each rule, Dafny proofs, generated code in gen/). Its spec decides what a deploy must hold, so the train asks it:
//
//   node vibestack.mjs detect          is this one: VIBESTACK specs=… stories=… rules=… cli=… (exit 1 if not)
//   node vibestack.mjs check [--env e] [--worker w]
//        the project's `spec check`, judged for the train. Every stage but review must pass (a rule Dafny did not
//        prove fails the proof stage), and nothing may be recorded in spec/lock.json as unproved (`accept unproved`).
//        Review that waits on its owner (`pnpm accept`) passes before a deploy and on preview and staging, and fails
//        for preprod and production (`--env`, or DEPLOY_ENV, which a gate and a `before` command get).
//        --worker w: conformance on the deployed Worker. DEPLOY_URL is DEPLOY_URL_<W>, so the traces stage walks the
//        deployed thing, and it must pass.
//        VIBESTACK_OK env=… stages=a/b rules=n unproved=0 review=clear|pending:n [url=…]
//   node vibestack.mjs train [--check] a simulated person per story: the project's `spec train` (sim.mjs fabricate
//                                      --from-spec runs this)
//
// deploy.mjs coverage asks `vibestackCoverage` too: every story has a simulated person, every spec with rules is a
// surface's and its rules are proved by a check, every pre-production environment walks conformance on the deployed
// Worker, and preprod and production check review before anything deploys.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE = ["preprod", "production"];
const CHECK = /vibestack\.mjs\s+check\b/;

/** How the project runs its `spec` command: the template's own tools, or the package's bin. null: not vibestack. */
export function specCli(root) {
  if (existsSync(join(root, "vibestack", "spec.ts"))) return { bin: "node", args: ["vibestack/spec.ts"], shown: "node vibestack/spec.ts" };
  const bin = join(root, "node_modules", ".bin", "spec");
  return existsSync(bin) ? { bin, args: [], shown: "node_modules/.bin/spec" } : null;
}

/** The stories and rules of one spec file. A story is a `Story:` heading; a rule is a heading under a story with Quint
 *  under it (one checkable sentence, as `spec check` counts them, spec/lock.json keys them: "Story: … / <rule>"). */
export function parseSpec(file, text) {
  const stories = [], rules = [];
  let story = "", heading = "", fence = null; // fence: the open code block, { mark, quint }
  for (const line of text.split("\n")) {
    const f = /^(`{3,}|~{3,})\s*(\w*)/.exec(line);
    if (f && !fence) { fence = { mark: f[1], quint: f[2] === "quint" }; continue; }
    if (f && line.startsWith(fence.mark) && !f[2]) { fence = null; continue; }
    if (fence) {
      if (fence.quint && story && heading && line.trim() && !rules.some((r) => r.title === heading && r.story === story)) rules.push({ file, story, title: heading });
      continue;
    }
    const h = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (!h) continue;
    if (/^Story:/.test(h[2])) { story = h[2]; heading = ""; stories.push({ file, title: story, cite: `${file}, "${story}"` }); }
    else heading = h[2];
  }
  return { stories, rules };
}

/** Every spec of the project's tree (spec/**.md), with its stories and rules. */
export function specTree(root) {
  const files = [], walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) files.push(relative(root, p).split("\\").join("/"));
    }
  };
  walk(join(root, "spec"));
  const specs = files.sort().map((file) => ({ file, ...parseSpec(file, readFileSync(join(root, file), "utf8")) }));
  return { specs, stories: specs.flatMap((s) => s.stories), rules: specs.flatMap((s) => s.rules) };
}

/** A vibestack project: spec/index.md and the tools to check it. Returns { cli, tree } or null. */
export function detect(root) {
  const cli = existsSync(join(root, "spec", "index.md")) ? specCli(root) : null;
  return cli ? { cli, tree: specTree(root) } : null;
}

/** `app` as the variable its address is in: DEPLOY_URL_APP (the name deploy.mjs gives a gate). */
export const urlVariable = (worker) => `DEPLOY_URL_${worker.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/**
 * The train's verdict on a `spec check --json` report: { ok, why, review, stages, passed }. Pure.
 *   env      where it is going: "" (a check before any deploy), preview, staging, preprod, production
 *   unproved spec/lock.json's `unproved`: obligations recorded as simulated only
 *   deployed true when the report's traces walked a deployed Worker: they must have passed
 */
export function verdict(report, { env = "", unproved = {}, deployed = false } = {}) {
  const results = Array.isArray(report?.results) ? report.results : [], why = [];
  const review = results.filter((r) => !r.ok && r.stage === "review");
  for (const r of results.filter((x) => !x.ok && x.stage !== "review")) why.push(`${r.stage}: ${r.summary}${r.where ? ` (${r.where})` : ""}`);
  for (const k of Object.keys(unproved ?? {})) why.push(`proof: ${k} is recorded in spec/lock.json as simulated only (accept unproved): prove it before the train carries it`);
  if (RELEASE.includes(env)) for (const r of review) why.push(`review: ${r.summary}: ${env} waits for the owner's sign-off (pnpm accept)`);
  if (deployed && !results.some((r) => r.stage === "traces" && r.ok)) why.push("traces: no conformance walk passed on the deployed Worker");
  if (!results.length) why.push("spec check reported no stages");
  else if (report.ok === false && !why.length && !review.length) why.push(`spec check failed: ${report.next ?? "no reason given"}`);
  const stages = [...new Set(results.map((r) => r.stage))];
  return { ok: !why.length, why, review: review.length, stages: stages.length, passed: stages.filter((s) => results.every((r) => r.stage !== s || r.ok)).length };
}

/**
 * The coverage rule's questions for a vibestack project (deploy.mjs coverage adds them to its own), or null for any
 * other repo. Returns { bad: [sentences], lines, counts: { stories, rules, sims } }.
 */
export function vibestackCoverage(root, m, sims = []) {
  const d = detect(root);
  if (!d) return null;
  const { tree } = d, bad = [], surfaces = m.surfaces ?? [];
  const cmdOf = (c) => (typeof c === "string" ? c : c?.cmd ?? ""), nameOf = (c) => (typeof c === "string" ? c : c.name ?? c.cmd);
  // Stories: each is a simulated person a surface lists (sim.mjs fabricate --from-spec writes one per story).
  const listed = new Set(surfaces.flatMap((s) => s.user ?? []));
  const cited = new Set(sims.filter((s) => s.story && listed.has(s.name)).map((s) => s.story));
  for (const st of tree.stories) if (!cited.has(st.cite)) bad.push(`story ${st.cite} has no simulated person: run \`node .deploy/sim.mjs fabricate --from-spec\`, or list a scenario whose "story" cites it`);
  for (const s of sims) if (s.story && !tree.stories.some((st) => st.cite === s.story)) bad.push(`scenario '${s.name}' cites ${s.story}, which the spec no longer has`);
  // Rules: each spec with rules or stories is a surface's, and that surface's unit tests include the check that proves them.
  const proving = (m.checks ?? []).filter((c) => CHECK.test(cmdOf(c)) && !/--worker/.test(cmdOf(c))).map(nameOf);
  if (!proving.length) bad.push("no check runs `node .deploy/vibestack.mjs check`: nothing proves the spec's rules or reads its review before a deploy");
  for (const spec of tree.specs.filter((s) => s.rules.length || s.stories.length)) {
    const owner = surfaces.find((s) => s.spec === spec.file);
    if (!owner) bad.push(`${spec.file}: ${spec.rules.length} rules and ${spec.stories.length} stories that no surface's "spec" names`);
    else if (proving.length && !(owner.unit ?? []).some((u) => proving.includes(u))) bad.push(`${owner.name}: the rules of ${spec.file} are proved by '${proving[0]}': list it in the surface's unit tests`);
  }
  // Conformance on the deployed Worker, in every environment before production that the Worker has.
  for (const s of surfaces.filter((x) => x.spec && x.worker)) {
    const w = (m.workers ?? []).find((x) => x.name === s.worker);
    for (const env of ["preview", "staging", "preprod"].filter((e) => e === "preview" || w?.envs?.[e])) {
      const g = (m.gates?.[env] ?? []).find((x) => CHECK.test(cmdOf(x)) && new RegExp(`--worker\\s+${s.worker}(\\s|$)`).test(cmdOf(x)));
      if (!g) bad.push(`${s.name}: no ${env} gate runs \`node .deploy/vibestack.mjs check --worker ${s.worker}\`: the spec's conformance is never walked on the deployed Worker there`);
      else if (!(s.e2e ?? []).includes(nameOf(g))) bad.push(`${s.name}: list the gate '${nameOf(g)}' in its e2e tests`);
    }
  }
  // Review blocks a release: preprod and production check it before anything deploys.
  for (const env of RELEASE.filter((e) => (m.workers ?? []).some((w) => w.envs?.[e]))) {
    if (!(m.before?.[env] ?? []).some((c) => CHECK.test(cmdOf(c)))) bad.push(`before.${env} has no \`node .deploy/vibestack.mjs check\`: ${env} could ship a rule its owner has not signed off, or one recorded as unproved`);
  }
  const counts = { stories: tree.stories.length, rules: tree.rules.length, sims: sims.filter((s) => s.story && listed.has(s.name)).length };
  return { bad, counts, lines: [`vibestack ${d.cli.shown}: ${tree.specs.length} specs, ${counts.stories} stories (${cited.size} with a simulated person), ${counts.rules} rules`] };
}

/** The project's `spec train`: a scenario per story in .deploy/sims. Returns { ok, out }. */
export function train(root, check = false) {
  const cli = specCli(root);
  if (!cli) return { ok: false, out: "not a vibestack project: no vibestack/spec.ts and no node_modules/.bin/spec" };
  const r = spawnSync(cli.bin, [...cli.args, "train", ...(check ? ["--check"] : [])], { cwd: root, encoding: "utf8", maxBuffer: 16 << 20 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { ok: r.status === 0 && /TRAIN_OK/.test(out), out };
}

function main() {
  const argv = process.argv.slice(2), cmd = argv[0];
  const arg = (n, dflt) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : dflt; };
  const root = arg("root", process.cwd()), d = detect(root);
  if (cmd === "detect") {
    if (!d) { console.log("NOT_VIBESTACK no spec/index.md with vibestack's tools (vibestack/spec.ts or node_modules/.bin/spec)"); process.exit(1); }
    console.log(`VIBESTACK specs=${d.tree.specs.length} stories=${d.tree.stories.length} rules=${d.tree.rules.length} cli=${d.cli.shown}`);
    return;
  }
  if (cmd === "train") { const r = train(root, argv.includes("--check")); process.stdout.write(r.out); process.exit(r.ok ? 0 : 1); }
  if (cmd !== "check") { console.error("usage: vibestack.mjs detect | check [--env e] [--worker w] | train [--check]"); process.exit(2); }
  const env = arg("env", process.env.DEPLOY_ENV ?? ""), worker = arg("worker", ""), where = env || "checks";
  if (!d) { console.log(`VIBESTACK_FAIL env=${where} not a vibestack project (no spec/index.md with vibestack's tools)`); process.exit(1); }
  const extra = {};
  if (worker) {
    const v = urlVariable(worker);
    if (!/^https?:\/\//.test(process.env[v] ?? "")) { console.log(`VIBESTACK_FAIL env=${where} ${v} is not an address: --worker walks conformance on the deployed Worker (deploy.mjs sets it for a gate)`); process.exit(1); }
    extra.DEPLOY_URL = process.env[v];
  }
  const r = spawnSync(d.cli.bin, [...d.cli.args, "check", "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, ...extra }, maxBuffer: 256 << 20 });
  const out = r.stdout ?? "", at = out.search(/^\{\s*"ok"/m);
  let report;
  try { report = JSON.parse(out.slice(at)); } catch { console.log(`VIBESTACK_FAIL env=${where} \`spec check --json\` gave no report (exit ${r.status}):\n${`${out}${r.stderr ?? ""}`.slice(-1500)}`); process.exit(1); }
  let unproved = {};
  const lock = join(root, "spec", "lock.json"); // no ledger yet: nothing recorded; one that cannot be read fails, never passes
  if (existsSync(lock)) try { unproved = JSON.parse(readFileSync(lock, "utf8")).unproved ?? {}; } catch (e) { console.log(`VIBESTACK_FAIL env=${where} spec/lock.json cannot be read (${e.message}): it says which rules are unproved`); process.exit(1); }
  const v = verdict(report, { env, unproved, deployed: !!worker });
  for (const x of report.results ?? []) console.log(`${x.ok ? "ok  " : x.stage === "review" && !RELEASE.includes(env) ? "wait" : "FAIL"} [${x.stage}] ${x.summary}`);
  if (!v.ok) { console.log(`VIBESTACK_FAIL env=${where} ${v.why.length}:\n  ${v.why.join("\n  ")}`); process.exit(1); }
  // Shown by deploy.mjs on a pass (five spaces): review that waits is said aloud, never passed in silence.
  if (v.review) console.log(`     review waits on its owner (pnpm accept): ${v.review} item(s); it blocks preprod and production, not ${where}`);
  console.log(`VIBESTACK_OK env=${where} stages=${v.passed}/${v.stages} rules=${d.tree.rules.length} unproved=0 review=${v.review ? `pending:${v.review}` : "clear"}${worker ? ` url=${extra.DEPLOY_URL}` : ""}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
