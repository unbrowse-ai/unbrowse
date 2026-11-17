#!/usr/bin/env node
// One deploy command for every repo and every environment, driven by .deploy/manifest.json (see the skill's
// assets/manifest.example.json). The environments are the same four everywhere: preview, staging, preprod, production.
//
//   node deploy.mjs staging                      deploy every Worker in the manifest to staging, then run its gate
//   node deploy.mjs preview --branch feat/x      a deployment of its own for that branch (like a Vercel preview)
//   node deploy.mjs preview --branch feat/x --delete     remove that branch's deployment
//   node deploy.mjs production --dry-run         print what would run; build the bundles, deploy nothing
//   node deploy.mjs env-for --ref refs/heads/release/1.4   print the environment a git ref deploys to (or "none")
//   node deploy.mjs checks                       every pre-deploy check, the coverage rule first
//   node deploy.mjs coverage                     every surface has unit, end-to-end and user tests, or a written reason
//   node deploy.mjs gate preview --branch feat/x run an environment's gates on what is deployed there now (no deploy)
//   node deploy.mjs after production             run the manifest's `after` commands again (a release note that did not go out)
//   node deploy.mjs watch production             the manifest's `watch` commands for an environment: what only shows later
//                                                (a connection revoked at its next token renewal, a slow failure).
//                                                --rollback: when the watch fails, go back to the version before the deploy.
//   node deploy.mjs drill staging                the rollback drill: go back to the version before, run the gates on it,
//                                                come forward again. A rollback nobody has run is a guess.
//   node deploy.mjs gated staging                did that environment's gates pass on the code in this checkout, lately?
//                                                (GATED_OK / GATED_NO: what the production-deploy guard hook asks)
//
// A gate that fails after a deploy rolls every Worker of that environment back to the version it had before, and the
// command exits 1. Every deploy, pass or fail, is written to the ledger (ledger.mjs) when that script sits beside this one.
// Ends with a success-only marker:  DEPLOY_OK env=… workers=… gate=…
//
// Several manifests in one repo (one per Cloudflare account, say): --manifest .deploy/manifest.<name>.json on every
// command. Each is a train of its own: its gate stamps are .deploy/.gate-stamps.<name>.json, not the default manifest's.
// A manifest with "account": "<Cloudflare account id>" only ever acts on that account: CLOUDFLARE_ACCOUNT_ID is set to
// it when unset, a command run with another one ends ACCOUNT_FAIL before anything is touched, and the stamps and ledger
// records another account left are not read as its own.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, dirname, join, relative, resolve } from "node:path";
import { vibestackCoverage } from "./vibestack.mjs";

const ENVS = ["preview", "staging", "preprod", "production"];
const NAME_MAX = 54;
const argv = process.argv.slice(2), cmd = argv[0];
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);

/** The environment a git ref deploys to. The same rule in every repo; a manifest may rename its branches (`branches`). */
export function envFor(ref, branches = {}) {
  const b = { staging: "staging", release: "release/", main: "main", ...branches };
  if (/^refs\/tags\/v\d+\.\d+\.\d+/.test(ref)) return "production";
  const name = ref.replace(/^refs\/heads\//, "");
  if (ref.startsWith("refs/tags/") || !name) return "none";
  if (name === b.staging) return "staging";
  if (name.startsWith(b.release)) return "preprod";
  if (name === b.main) return "none"; // main is a log of releases: production goes out from a tag, or the soak promotion
  return "preview";
}

/** A branch as part of a Worker name and a hostname label: lower case, a-z 0-9 and -, short, and still unique. */
export function slugOf(branch, max = 24) {
  const clean = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
  if (clean.length <= max) return clean;
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 6);
  return max <= 8 ? `b${hash}` : `${clean.slice(0, max - 7).replace(/-+$/, "")}-${hash}`;
}

/** JSON with comments and trailing commas (wrangler.jsonc), read without a dependency. */
export function parseJsonc(text) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * A branch's own copy of a Worker's config: its own name (so its own Durable Objects and its own address), bindings to
 * sibling Workers pointed at their copies for the same branch, and whatever the manifest says a preview must not have
 * (cron triggers, routes on real domains…) taken out. Everything else is the `from` environment's config.
 */
export function previewConfig(base, worker, slug, siblings, strip = ["triggers", "routes", "route"]) {
  const cfg = structuredClone(base);
  const rename = (n) => `${n}-pr-${slug}`.slice(0, 54).replace(/-+$/, "");
  cfg.name = rename(worker);
  for (const s of cfg.services ?? []) if (siblings.includes(s.service)) s.service = rename(s.service);
  for (const d of cfg.durable_objects?.bindings ?? []) if (d.script_name && siblings.includes(d.script_name)) d.script_name = rename(d.script_name);
  for (const path of strip) {
    const parts = path.split(".");
    let o = cfg;
    for (const p of parts.slice(0, -1)) o = o?.[p];
    const last = parts.at(-1);
    if (Array.isArray(o)) { const i = o.findIndex((x) => x?.binding === last || x?.name === last); if (i >= 0) o.splice(i, 1); }
    else if (o && typeof o === "object") delete o[last];
  }
  cfg.workers_dev = true;
  cfg.preview_urls = false; // the copy is the preview; it needs no per-version addresses of its own
  return cfg;
}

/** The three kinds of test every surface needs: on the code, on the deployed thing, and by a simulated person. */
export const TEST_KINDS = ["unit", "e2e", "user"];
const PRE_PRODUCTION = ["preview", "staging", "preprod"];
const SOAK_ENVS = ["staging", "preprod"]; // (traffic.mjs keeps the same list)

/** What a Worker's wrangler config says it has that can break on its own, as surface kinds. */
export function detectSurfaces(cfg = {}) {
  const out = [];
  if (cfg.workers_dev !== false || cfg.routes?.length || cfg.route) out.push("http");
  if (cfg.durable_objects?.bindings?.some((b) => !b.script_name)) out.push("durable-object");
  if (cfg.triggers?.crons?.length) out.push("cron");
  if (cfg.queues?.consumers?.length || cfg.queues?.producers?.length) out.push("queue");
  if (cfg.send_email?.length) out.push("email");
  if (cfg.assets || cfg.site) out.push("pages");
  if (cfg.workflows?.length) out.push("workflow");
  return out;
}

/**
 * The coverage rule: every surface in the manifest names at least one test of each kind, or says why it has none.
 *   unit  a check in `checks` (runs on the code, before anything deploys)
 *   e2e   a gate that runs before production (preview, staging or preprod), on the deployed thing
 *   user  a simulation scenario (sims) whose `surface` is this one
 * A surface kind a Worker's config shows (Durable Objects, cron, queues…) must be covered by some surface too.
 * Returns { ok, bad: [sentences], lines: [one per surface], counts }.
 */
export function coverage(m, { sims = [], detected = [] } = {}) {
  const bad = [], lines = [], counts = { surfaces: 0, unit: 0, e2e: 0, user: 0, waived: 0 };
  const gname = (g) => (typeof g === "string" ? g : g.name ?? g.cmd);
  const checks = new Set((m.checks ?? []).map((c) => c.name ?? c.cmd));
  const early = new Set(PRE_PRODUCTION.flatMap((e) => (m.gates?.[e] ?? []).map(gname)));
  const any = new Set(Object.values(m.gates ?? {}).flat().map(gname));
  const surfaces = m.surfaces ?? [];
  if (!surfaces.length) bad.push("the manifest lists no surfaces: name each thing a person or a system can reach (mcp, http, pages, cron, durable-object, webhook, bot…)");
  for (const s of surfaces) {
    counts.surfaces++;
    const cells = [];
    for (const k of TEST_KINDS) {
      const refs = [].concat(s[k] ?? []), why = s.waive?.[k];
      if (!refs.length) {
        if (typeof why === "string" && why.trim().length >= 15) { counts.waived++; cells.push(`${k}: waived`); }
        else { bad.push(`${s.name}: no ${k} test, and no reason given (waive.${k})`); cells.push(`${k}: NONE`); }
        continue;
      }
      let ok = 0;
      for (const r of refs) {
        if (k === "unit") { if (checks.has(r)) ok++; else bad.push(`${s.name}: unit test '${r}' is not a check in the manifest`); }
        else if (k === "e2e") {
          if (early.has(r)) ok++;
          else bad.push(any.has(r) ? `${s.name}: gate '${r}' runs only in production: it must also run in ${PRE_PRODUCTION.join(", ")} to count as testing before a deploy` : `${s.name}: e2e test '${r}' is not a gate in the manifest`);
        } else {
          const sim = sims.find((x) => x.name === r);
          if (!sim) bad.push(`${s.name}: user test '${r}' is not a scenario in the sims directory`);
          else if (sim.surface !== s.name) bad.push(`${s.name}: scenario '${r}' says it exercises '${sim.surface}'`);
          else ok++;
        }
      }
      if (ok) counts[k]++;
      cells.push(`${k}: ${ok}`);
    }
    lines.push(`${s.name} [${[].concat(s.kind ?? "?").join(", ")}]  ${cells.join("  ")}`);
  }
  const listed = new Set(surfaces.flatMap((s) => (s.user ?? [])));
  for (const x of sims) {
    if (!surfaces.some((s) => s.name === x.surface)) bad.push(`scenario '${x.name}' exercises '${x.surface}', which is not a surface in the manifest`);
    else if (!listed.has(x.name)) bad.push(`scenario '${x.name}' is not listed under its surface's user tests, so nothing says it must run`);
  }
  const kinds = new Set(surfaces.flatMap((s) => [].concat(s.kind ?? [])));
  for (const d of new Set(detected)) {
    if (!kinds.has(d) && !(typeof m.surfacesIgnored?.[d] === "string" && m.surfacesIgnored[d].trim().length >= 15)) bad.push(`a Worker's config shows a ${d} surface that no surface in the manifest covers (or give the reason in surfacesIgnored.${d})`);
  }
  return { ok: !bad.length, bad, lines, counts };
}

const sh = (bin, args, opts = {}) => {
  const r = spawnSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
/** What to show of a failed command: the end of what it printed and the end of what it complained about, each on its
 *  own, so a test runner's summary is not pushed out of sight by warnings written after it. */
export const failTail = (r, n = 2500) => (r.stderr?.trim() && r.stdout?.trim() ? `${r.stdout.slice(-Math.ceil(n * 0.6))}\n--- stderr ---\n${r.stderr.slice(-Math.floor(n * 0.4))}` : r.out.slice(-n));
const wrangler = (args, opts) => sh("npx", ["--no-install", "wrangler", ...args], opts);

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
// The train this run is on, set by main and read by the stamp and ledger helpers below ("" is .deploy/manifest.json).
let TRAIN = "", ACCOUNT = "", MANIFEST = ".deploy/manifest.json";
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) await main();

async function main() {
  const root = resolve(arg("root", process.cwd())), manifestPath = resolve(root, arg("manifest", ".deploy/manifest.json"));
  TRAIN = trainOf(manifestPath); MANIFEST = relative(root, manifestPath) || manifestPath;
  if (!["env-for", "checks", "coverage"].includes(cmd) && existsSync(manifestPath)) {
    try { ACCOUNT = String(JSON.parse(readFileSync(manifestPath, "utf8")).account ?? ""); } catch { /* the command says what is wrong with it */ }
    // `gated` only reads this checkout's stamps: it is asked by hooks that hold no Cloudflare credentials at all.
    const bad = cmd === "gated" ? "" : accountProblem(ACCOUNT, process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
    if (bad) { console.log(`ACCOUNT_FAIL ${MANIFEST}: ${bad}; nothing was done`); process.exit(2); }
    if (ACCOUNT && cmd !== "gated") process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT; // (wrangler and soak.mjs read it)
  }
  if (cmd === "env-for") { const m = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {}; console.log(envFor(arg("ref", ""), m.branches)); return; }
  if (cmd === "checks") return checks(root, manifestPath);
  if (cmd === "coverage") { const c = coverageOf(root, manifestPath); for (const l of c.lines) console.log(l); if (!c.ok) { console.log(`COVERAGE_FAIL ${c.bad.length}:\n  ${c.bad.join("\n  ")}`); process.exit(1); } console.log(coverageMarker(c)); return; }
  if (cmd === "gate") return gateOnly(root, manifestPath, argv[1]);
  if (cmd === "watch") return gateOnly(root, manifestPath, argv[1], "watch");
  if (cmd === "after") {
    const env = argv[1] ?? "production", r = runAfter(root, env, JSON.parse(readFileSync(manifestPath, "utf8")), [], (t) => console.log(t));
    if (!r) { console.log(`AFTER_FAIL env=${env} the manifest has no after commands for ${env}`); process.exit(1); }
    console.log(`${r.failed ? "AFTER_FAIL" : "AFTER_OK"} env=${env} after=${r.passed}/${r.of}`);
    process.exit(r.failed ? 1 : 0);
  }
  if (cmd === "gated") {
    const env = argv[1] ?? "staging", v = stampVerdict(readStamps(root)[env], treeId(root), Date.now(), Number(arg("max-hours", "12")));
    console.log(v.ok ? `GATED_OK env=${env} at=${v.at} gates=${v.gates}` : `GATED_NO env=${env}: ${v.why}`);
    process.exit(v.ok ? 0 : 1);
  }
  if (cmd === "soak") return soak(root, manifestPath, argv[1] ?? "staging");
  if (cmd === "drill") return drill(root, manifestPath, argv[1] ?? "staging");
  if (!ENVS.includes(cmd)) { console.error(`usage: deploy.mjs <${ENVS.join("|")}|checks|coverage|gate <env>|watch <env> [--rollback]|drill <env>|soak <env>|env-for> [--branch b] [--dry-run] [--delete] [--only worker] [--no-gate]`); process.exit(2); }
  if (flag("no-gate") && ["preprod", "production"].includes(cmd)) { console.error(`--no-gate is refused for ${cmd}: its gates are what stand between the code and customers`); process.exit(2); }
  if (!existsSync(manifestPath)) { console.error(`no ${manifestPath}: copy the skill's assets/manifest.example.json and fill it in`); process.exit(2); }
  const m = JSON.parse(readFileSync(manifestPath, "utf8")), env = cmd, dry = flag("dry-run");
  const workers = (m.workers ?? []).filter((w) => !arg("only") || w.name === arg("only"));
  const branch = arg("branch", process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "");
  if (env === "preview" && !branch) { console.error("preview needs --branch"); process.exit(2); }
  // A Worker with a workers.dev address may be named with at most 54 characters (Cloudflare refuses longer, code
  // 100315), so the branch's part is as long as the longest Worker name in the manifest leaves room for.
  // (Every Worker of the manifest counts, also when --only deploys one of them: the branch's name must not depend on
  // which Workers a run happens to deploy, or one Worker lands beside the branch's others under another name.)
  const baseNameOf = (w) => { try { return parseJsonc(readFileSync(join(root, w.envs?.[w.envs?.preview?.from ?? "staging"]?.config ?? ""), "utf8")).name; } catch { return w.name; } };
  const allNames = (m.workers ?? []).map(baseNameOf);
  const longest = Math.max(0, ...allNames.map((n) => n.length));
  const slug = env === "preview" ? slugOf(branch, Math.max(8, Math.min(24, NAME_MAX - 4 - longest))) : "";
  const names = workers.map((w) => w.name);
  const done = [], log = (s) => console.log(s);

  // What each Worker deploys from, in the order given (a Worker others bind to goes first in the manifest).
  const plan = workers.map((w) => {
    const e = w.envs?.[env] ?? (env === "preview" ? { from: "staging" } : null);
    if (!e) return { w, skip: `no ${env} environment in the manifest` };
    const from = e.from ? w.envs?.[e.from] : e;
    if (!from?.config) return { w, skip: `no config for ${e.from ?? env}` };
    const base = parseJsonc(readFileSync(join(root, from.config), "utf8"));
    // The deployed name of this Worker in this environment (and of its siblings, for preview's bindings).
    return { w, e, from, base, baseName: base.name, ownWorker: env === "preview" && (e.mode ?? (base.durable_objects || base.services ? "worker" : "alias")) === "worker" };
  });
  // Siblings are the manifest's Workers, deployed in this run or not: one deployed alone still binds to the branch's copies.
  const siblingNames = env === "preview" ? allNames : plan.filter((p) => p.base).map((p) => p.baseName);

  if (flag("delete")) {
    for (const p of plan.filter((p) => p.ownWorker)) {
      const name = previewConfig(p.base, p.baseName, slug, siblingNames).name;
      const r = dry ? { code: 0, out: "" } : wrangler(["delete", "--name", name, "--force"], { cwd: root });
      log(`${r.code === 0 ? "deleted" : "not deleted"} ${name}${r.code ? `: ${r.out.trim().split("\n").at(-1)}` : ""}`);
    }
    return;
  }

  // What must be written down before the deploy so it can be judged afterwards (a snapshot a gate compares with: the
  // connections that already need a person, say). One that cannot be taken stops the deploy: nothing could judge it.
  if (!dry && (m.before?.[env] ?? []).length) {
    const at = plan.filter((p) => p.base).map((p) => ({ name: p.baseName, key: p.w.name, url: m.subdomain && env !== "preview" ? `https://${p.baseName}.${m.subdomain}.workers.dev` : "" }));
    const pre = runGates(m.before[env], { root, env, done: at, log, label: "before" });
    if (pre.failed) { console.log(`DEPLOY_FAIL env=${env} before=${JSON.stringify(pre.failed)} nothing was deployed`); process.exit(1); }
  }
  // The simulated people of the soak stop while their environment is deployed again: a round must not meet a half-done
  // deploy, and the new version gets its own window (started below once its gates pass).
  const soaks = !dry && !slug && SOAK_ENVS.includes(env) && existsSync(trafficScript());
  if (soaks) { const s = sh("node", [trafficScript(), "stop", env, "--root", root, "--manifest", manifestPath, "--why", `deploying ${env} again`], { cwd: root }); if (/TRAFFIC_STOPPED/.test(s.out)) log(s.out.trim()); }
  const before = new Map(); // Worker → the version it ran before this deploy (to roll back to)
  const fresh = new Set(); // previews of their own deployed for the first time: deleted, not left live, when they fail
  // What a failed deploy leaves: each Worker back on its version before, a new preview deleted, and the rest named.
  const undo = () => {
    const back = rollback(before, root, log);
    const gone = done.map((d) => d.name).filter((n) => fresh.has(n)).filter((n) => { const r = wrangler(["delete", "--name", n, "--force"], { cwd: root }); log(`${r.code === 0 ? "deleted" : "NOT DELETED"} ${n}`); return r.code === 0; });
    const broken = done.map((d) => d.name).filter((n) => !back.includes(n) && !gone.includes(n));
    return `rolled_back=${back.length}${gone.length ? ` deleted=${gone.length}` : ""}${broken.length ? ` left_broken=${broken.join(",")}` : ""}`;
  };
  const again = []; // previews first deployed without their sibling bindings (a circle of bindings)
  for (const p of plan) {
    if (p.skip) { log(`skip ${p.w.name}: ${p.skip}`); continue; }
    if (p.w.build && !dry) { const b = sh("sh", ["-c", p.w.build], { cwd: root }); if (b.code) { console.error(`build failed for ${p.w.name}:\n${b.out.slice(-2000)}`); process.exit(1); } }
    let config = join(root, p.from.config), name = p.baseName, args;
    if (env === "preview" && p.ownWorker) {
      // Its own Worker: needed when it has Durable Objects (no preview address exists for those) or binds to siblings.
      const cfg = previewConfig(p.base, p.baseName, slug, siblingNames, p.e.strip ?? p.w.previewStrip);
      // Values that must name the copy itself (its own public address…): {name} {slug} {subdomain} are filled in.
      const fill = (v) => String(v).replaceAll("{name}", cfg.name).replaceAll("{slug}", slug).replaceAll("{subdomain}", m.subdomain ?? "");
      const sib = (v) => siblingNames.reduce((t, n) => t.replaceAll(`{${n}}`, previewConfig({ name: n }, n, slug, []).name), fill(v));
      for (const [k, v] of Object.entries(p.e.vars ?? p.w.previewVars ?? {})) (cfg.vars ??= {})[k] = sib(v);
      // Paths in a config are relative to it, so the copy sits beside the original.
      config = join(dirname(config), `.wrangler.preview.${slug}.${p.baseName}.json`);
      writeFileSync(config, JSON.stringify(cfg, null, 2)); // git-ignored (.wrangler.preview.*); a dry run needs it too
      name = cfg.name;
      args = ["deploy", "-c", config];
    } else if (env === "preview") {
      // No state of its own: a version of the staging Worker under the branch's alias, serving no real traffic.
      args = ["versions", "upload", "-c", config, "--preview-alias", slug, "--tag", slug, "--message", `preview of ${branch}`];
    } else args = ["deploy", "-c", config];
    if (process.env.GITHUB_SHA && args[0] === "deploy") args.push("--tag", process.env.GITHUB_SHA.slice(0, 12), "--message", `${env} ${process.env.GITHUB_REF_NAME ?? ""} ${process.env.GITHUB_SHA.slice(0, 7)}`.trim());
    if (dry) args.push("--dry-run");
    if (!dry && (env !== "preview" || p.ownWorker)) { // (an alias preview has no version of its own to go back to)
      const d = wrangler(["deployments", "status", "-c", config, "--json"], { cwd: root });
      let version = ""; try { version = JSON.parse(d.out.slice(d.out.indexOf("{"))).versions?.[0]?.version_id ?? ""; } catch { /* a first deploy: nothing to roll back to */ }
      if (version) before.set(name, { config, version }); else if (env === "preview") fresh.add(name);
    }
    log(`${dry ? "would run" : "run"}: wrangler ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
    let r = wrangler(args, { cwd: root });
    // Cloudflare's API fails now and then for no reason of ours: one more try before anything else is concluded.
    if (r.code && !dry && /A request to the Cloudflare API .*failed/.test(r.out) && !/\[code: 1\d{4}\]/.test(r.out)) { log(`Cloudflare's API failed for ${name}; trying once more`); r = wrangler(args, { cwd: root }); }
    if (r.code && env === "preview" && p.ownWorker && !dry) {
      // Workers that bind to each other in a circle: neither exists yet, so neither can deploy first. This one goes up
      // once without its bindings to siblings (so the others can name it), and is deployed whole after them.
      const whole = JSON.parse(readFileSync(config, "utf8")), bare = structuredClone(whole);
      const mine = (n) => typeof n === "string" && n.endsWith(`-pr-${slug}`);
      bare.services = (bare.services ?? []).filter((x) => !mine(x.service));
      if (bare.durable_objects) bare.durable_objects.bindings = bare.durable_objects.bindings.filter((x) => !mine(x.script_name));
      writeFileSync(config, JSON.stringify(bare, null, 2));
      const first = wrangler(args, { cwd: root });
      writeFileSync(config, JSON.stringify(whole, null, 2));
      if (first.code === 0) { log(`deployed ${name} without its sibling bindings first (a circle); whole again after the others`); again.push({ name, args }); r = first; }
      else r = { code: first.code, out: `${r.out.slice(-1200)}\n--- and without its sibling bindings ---\n${first.out.slice(-1500)}` };
    }
    if (r.code) { console.error(`deploy failed for ${name}:\n${r.out.slice(-3000)}`); before.delete(name); log(undo()); if (env !== "preview") ledger(root, env, "failed", "", log); process.exit(1); }
    // Secrets a new Worker has none of: given as one JSON object in the environment (a GitHub environment secret).
    if (!dry && env === "preview" && p.ownWorker && process.env.WORKER_SECRETS) {
      const s = spawnSync("npx", ["--no-install", "wrangler", "secret", "bulk", "--name", name], { cwd: root, input: process.env.WORKER_SECRETS, encoding: "utf8" });
      if (s.status) { console.error(`secrets not set on ${name}`); process.exit(1); }
    }
    const url = /https:\/\/[^\s]+\.workers\.dev[^\s]*/.exec(r.out)?.[0] ?? "";
    done.push({ name, url, key: p.w.name });
    log(`${dry ? "built" : "deployed"} ${name}${url ? ` ${url}` : ""}`);
  }

  for (const a of again) {
    const r = wrangler(a.args, { cwd: root });
    if (r.code) { console.error(`deploy failed for ${a.name} (whole, second pass):\n${r.out.slice(-3000)}`); process.exit(1); }
    log(`deployed ${a.name} whole`);
  }

  // The gate: what must hold on the deployed thing before anything is promoted past it.
  const gates = flag("no-gate") || dry ? [] : (m.gates?.[env] ?? m.gates?.default ?? []);
  const g = runGates(gates, { root, env, done, log });
  if (g.failed) { const left = undo(); if (!slug && done.length) ledger(root, env, "rolled_back", `${g.passed}/${gates.length}`, log); console.log(`DEPLOY_FAIL env=${env} gate=${JSON.stringify(g.failed)} ${left}`); process.exit(1); }
  const passed = g.passed;
  if (gates.length && !slug) stamp(root, env, passed, Object.fromEntries(before));
  if (!dry && !slug && done.length) ledger(root, env, "ok", `${passed}/${gates.length}`, log); // (nothing deployed, nothing to record)
  // The deploy is good. What follows it (after.<env>: telling the people who use the product what changed) never
  // takes it back: a note that did not go out is a FAIL line and `after=0/1`, and `deploy.mjs after <env>` sends it again.
  const told = dry || slug || !done.length ? null : runAfter(root, env, m, done, log);
  // Then the simulated people start using it, every 25 minutes for the soak's hours (traffic.mjs): the soak judges what
  // they met. Not an option: --no-traffic is for a deploy that must not be soaked (a test of the train itself).
  const traffic = soaks && done.length && !flag("no-traffic") ? startTraffic(root, manifestPath, env, plan, done, m, log) : "";
  console.log(`${dry ? "DEPLOY_DRY_OK" : "DEPLOY_OK"} env=${env}${slug ? ` branch=${slug}` : ""} workers=${done.map((d) => d.name).join(",")} gate=${passed}/${gates.length}${told ? ` after=${told.passed}/${told.of}` : ""}${traffic ? ` traffic=${traffic}` : ""}`);
}

function trafficScript() { return join(dirname(realpathSync(new URL(import.meta.url).pathname)), "traffic.mjs"); }

/** Start the soak's simulated people on what was just deployed. Returns on, none, waived or failed. */
function startTraffic(root, manifestPath, env, plan, done, m, log) {
  const workers = plan.filter((p) => p.base && done.some((d) => d.key === p.w.name)).map((p) => {
    const d = done.find((x) => x.key === p.w.name);
    return { key: p.w.name, name: p.baseName, config: p.from.config, url: d.url || (m.subdomain ? `https://${p.baseName}.${m.subdomain}.workers.dev` : "") };
  });
  const r = sh("node", [trafficScript(), "start", env, "--root", root, "--manifest", manifestPath, "--workers", JSON.stringify(workers)], { cwd: root });
  if (r.code === 4) return "none";
  if (/TRAFFIC_NONE/.test(r.out)) return "waived";
  log(r.out.trim().split("\n").at(-1));
  return r.code === 0 && /TRAFFIC_ON/.test(r.out) ? "on" : "failed";
}

/**
 * The manifest's `after.<env>` commands: a list, or { since, run }. Each gets RELEASE_ENV, RELEASE_COMMIT (this
 * checkout's commit) and RELEASE_PREVIOUS: the commit the people were last told about (kept in .deploy/.announced.json
 * and moved on only when every command passed, so a note that failed is not skipped by the next release), or `since`
 * the first time.
 */
function runAfter(root, env, m, done, log) {
  const a = m.after?.[env], run = Array.isArray(a) ? a : (a?.run ?? []);
  if (!run.length) return null;
  const file = join(root, ".deploy/.announced.json");
  let state = {};
  try { state = JSON.parse(readFileSync(file, "utf8")); } catch { /* first time */ }
  const head = sh("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
  const r = runGates(run, { root, env, done, log, label: "after", extra: { RELEASE_ENV: env, RELEASE_COMMIT: head, RELEASE_PREVIOUS: state[env] ?? (Array.isArray(a) ? "" : a?.since ?? "") } });
  if (!r.failed && head) writeFileSync(file, JSON.stringify({ ...state, [env]: head }, null, 2));
  return { passed: r.passed, of: run.length, failed: r.failed };
}

/**
 * An environment's gates, each a shell command with a success-only marker. A gate learns where things are from
 * DEPLOY_ENV, DEPLOY_URLS, DEPLOY_WORKERS, and one DEPLOY_URL_<WORKER> per Worker of the manifest (its manifest name in
 * capitals, e.g. DEPLOY_URL_MY_API), so the same command works for a branch's preview and for staging.
 */
function runGates(gates, { root, env, done, log, label = "gate", extra = {} }) {
  const urls = Object.fromEntries(done.filter((d) => d.url && d.key).map((d) => [`DEPLOY_URL_${d.key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, d.url]));
  let passed = 0;
  for (const g of gates) {
    const spec = typeof g === "string" ? { cmd: g } : g;
    const r = sh("sh", ["-c", spec.cmd], { cwd: root, env: { ...process.env, ...urls, ...extra, DEPLOY_ENV: env, DEPLOY_URLS: done.map((d) => d.url).join(","), DEPLOY_WORKERS: done.map((d) => d.name).join(",") }, timeout: (spec.timeout_s ?? 900) * 1000 });
    const ok = r.code === 0 && (!spec.marker || r.out.includes(spec.marker));
    log(`${ok ? "ok  " : label === "watch" && r.code === 3 ? "wait" : label === "watch" && r.code === 2 ? "?   " : "FAIL"} ${label}: ${spec.name ?? spec.cmd}${ok ? "" : `\n${failTail(r)}`}`);
    // What a passing command says for a person to read (its lines indented five spaces: "still needs a person: …")
    // is shown, not swallowed: a pass that hides a connection someone must sign in again is a pass in silence.
    if (ok) for (const note of r.out.split("\n").filter((l) => /^ {5}\S/.test(l)).slice(0, 40)) log(note);
    // A watch command that exits 3 says "too soon to judge" and one that exits 2 says "could not ask" (soak.mjs): neither
    // is a pass and neither is a failure. Only a failure rolls anything back.
    if (!ok && label === "watch" && (r.code === 3 || r.code === 2)) return { passed, failed: "", [r.code === 3 ? "early" : "unknown"]: spec.name ?? spec.cmd };
    if (!ok) return { passed, failed: spec.name ?? spec.cmd };
    passed++;
  }
  return { passed, failed: "" };
}

/** `deploy.mjs gate <env>`: the gates of an environment on what is deployed there now. Deploys and rolls back nothing. */
function gateOnly(root, manifestPath, env, kind = "gates") {
  if (!ENVS.includes(env)) { console.error(`usage: deploy.mjs gate <${ENVS.join("|")}> [--branch b]`); process.exit(2); }
  const m = JSON.parse(readFileSync(manifestPath, "utf8")), branch = arg("branch", ""), workers = m.workers ?? [];
  if (env === "preview" && !branch) { console.error("gate preview needs --branch"); process.exit(2); }
  const from = (w) => { const e = w.envs?.[env] ?? (env === "preview" ? { from: "staging" } : null); return e?.from ? w.envs?.[e.from] : e; };
  const bases = workers.map((w) => { try { return parseJsonc(readFileSync(join(root, from(w).config), "utf8")); } catch { return null; } });
  const slug = env === "preview" ? slugOf(branch, Math.max(8, Math.min(24, NAME_MAX - 4 - Math.max(0, ...bases.filter(Boolean).map((b) => b.name.length))))) : "";
  const done = workers.map((w, i) => {
    if (!bases[i]) return null;
    const name = env === "preview" ? previewConfig({ name: bases[i].name }, bases[i].name, slug, []).name : bases[i].name;
    return { name, key: w.name, url: m.subdomain ? `https://${name}.${m.subdomain}.workers.dev` : "" };
  }).filter(Boolean);
  if (kind === "watch") {
    // `watch.<env>` is a list of commands, or { afterMinutes, run }: what they look for only shows that long after the
    // deploy (a grant dies at its next token renewal), so an earlier look is not a verdict and says so.
    const w = m.watch?.[env], list = Array.isArray(w) ? w : (w?.run ?? []), wait = Array.isArray(w) ? 0 : Number(w?.afterMinutes ?? 0);
    const since = readStamps(root)[env]?.at, mins = since ? (Date.now() - Date.parse(since)) / 60_000 : Infinity;
    if (list.length && wait && mins < wait && !flag("now")) {
      console.log(`WATCH_EARLY env=${env}: deployed ${Math.floor(mins)} min ago and this is judged after ${wait} min; ready in ${Math.ceil(wait - mins)} min (--now looks anyway)`);
      process.exit(3);
    }
    if (!list.length) { console.log(`WATCH_FAIL env=${env} the manifest has no watch commands for ${env}: nothing was looked at`); process.exit(1); }
    const seen = runGates(list, { root, env, done, log: (s) => console.log(s), label: "watch" });
    if (seen.early) { console.log(`WATCH_EARLY env=${env}: "${seen.early}" says it is too soon to judge; nothing was decided`); process.exit(3); }
    if (seen.unknown) { console.log(`WATCH_UNKNOWN env=${env}: "${seen.unknown}" could not ask (exit 2); nothing was decided and nothing was rolled back`); process.exit(2); }
    if (seen.failed && flag("rollback")) {
      // What the gate could not see at deploy time went wrong later: back to the version before, and the pass is withdrawn.
      const prev = previousVersions(root, env, m), back = rollback(prev, root, (s) => console.log(s), "the watch after the deploy failed").length;
      const all = readStamps(root, true); delete all[env]; writeFileSync(stampsPath(root), JSON.stringify(all, null, 2));
      if (back) ledger(root, env, "rolled_back", `watch ${seen.passed}/${list.length}`, (s) => console.log(s));
      console.log(`WATCH_FAIL env=${env} watch=${JSON.stringify(seen.failed)} passed=${seen.passed}/${list.length} rolled_back=${back}${prev.size ? "" : " (there is no record of the version before this deploy: roll back by hand)"}`);
      process.exit(1);
    }
    if (seen.failed) { console.log(`WATCH_FAIL env=${env} watch=${JSON.stringify(seen.failed)} passed=${seen.passed}/${list.length}`); process.exit(1); }
    console.log(`WATCH_OK env=${env} watch=${seen.passed}/${list.length}`);
    return;
  }
  const gates = m.gates?.[env] ?? m.gates?.default ?? [];
  if (!gates.length) { console.log(`GATE_FAIL env=${env} the manifest has no gates for ${env}: nothing was tested`); process.exit(1); }
  const g = runGates(gates, { root, env, done, log: (s) => console.log(s) });
  if (g.failed) { console.log(`GATE_FAIL env=${env} gate=${JSON.stringify(g.failed)} passed=${g.passed}/${gates.length}`); process.exit(1); }
  if (!slug) stamp(root, env, g.passed);
  console.log(`GATE_OK env=${env}${slug ? ` branch=${slug}` : ""} gate=${g.passed}/${gates.length}`);
}

// ---------- the record that an environment's gates passed on this code (what "tested by default" rests on) ----------

// (Functions, not constants: the command runs from the top of this file, before a constant down here exists.)
function stampsPath(root) { return join(root, `.deploy/.gate-stamps${TRAIN ? `.${TRAIN}` : ""}.json`); }
/** A manifest's train: "" for the repo's own .deploy/manifest.json, "x" for .deploy/manifest.x.json (or x.json). */
export function trainOf(manifestPath) {
  const b = basename(String(manifestPath));
  return b === "manifest.json" ? "" : b.replace(/^manifest\./, "").replace(/\.json$/, "").replace(/[^\w.-]/g, "_");
}
/** Why a manifest pinned to a Cloudflare account must not act with the account in the environment ("" when it may). */
export function accountProblem(pinned, envAccount) {
  if (!pinned || !envAccount || pinned === envAccount) return "";
  return `the manifest is for Cloudflare account ${pinned.slice(0, 8)}… but CLOUDFLARE_ACCOUNT_ID is ${envAccount.slice(0, 8)}…: use that account's token, or the manifest for the other account (--manifest)`;
}
/** The code in a checkout as one id: its commit and everything that differs from it, submodule pins included. Untracked
 *  files are left out (a stamp file or a scratch note must not change it). "" outside a git repository. */
export function treeId(root) {
  const g = (...a) => sh("git", a, { cwd: root }).stdout;
  const head = g("rev-parse", "HEAD").trim();
  return head ? createHash("sha256").update(`${head}\n${g("diff", "HEAD", "--submodule=short")}\n${g("submodule", "status", "--recursive")}`).digest("hex").slice(0, 16) : "";
}
/** This train's stamps. A pinned manifest reads only those its account wrote; `raw`: the whole file (what a rewrite keeps). */
function readStamps(root, raw = false) {
  let all = {}; try { all = JSON.parse(readFileSync(stampsPath(root), "utf8")); } catch { return {}; }
  return raw || !ACCOUNT ? all : Object.fromEntries(Object.entries(all).filter(([, v]) => v?.account === ACCOUNT));
}
/** Written only after every gate of the environment passed: when, on which code, how many gates. */
function stamp(root, env, gates, previous) {
  const tree = treeId(root), all = readStamps(root, true), mine = readStamps(root)[env];
  if (!tree) return;
  // `previous`: the version each Worker ran before this deploy (what a later watch or a drill goes back to). A gate run
  // on what is already deployed keeps the one the deploy wrote down.
  writeFileSync(stampsPath(root), JSON.stringify({ ...all, [env]: { at: new Date().toISOString(), tree, gates, previous: previous ?? mine?.previous ?? {}, ...(ACCOUNT ? { account: ACCOUNT } : {}) } }, null, 2));
}
/** Is a stamp proof that this code was tested? Pure, so it is tested without a repository. */
export function stampVerdict(s, tree, nowMs, maxHours = 12) {
  if (!s?.at || !s.tree) return { ok: false, why: "its gates have not passed on this checkout (run `node .deploy/deploy.mjs staging`: it deploys staging and runs every end-to-end and simulated-user gate)" };
  if (!tree || s.tree !== tree) return { ok: false, why: `the code changed since its gates passed at ${s.at}: run them again on what is here now` };
  const age = (nowMs - Date.parse(s.at)) / 3600_000;
  if (!(age <= maxHours)) return { ok: false, why: `its gates passed ${age.toFixed(1)} h ago (over ${maxHours} h): run them again` };
  return { ok: true, at: s.at, gates: s.gates };
}

/** The coverage rule on this repo: the manifest's surfaces against its checks, gates and scenario files, and what the Workers' own configs show. */
function coverageOf(root, manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8")), dir = join(root, m.sims?.dir ?? ".deploy/sims");
  const sims = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return { name: f, surface: "(unreadable)" }; } }) : [];
  const detected = (m.workers ?? []).flatMap((w) => { const c = w.envs?.production?.config ?? w.envs?.staging?.config; try { return detectSurfaces(parseJsonc(readFileSync(join(root, c), "utf8"))); } catch { return []; } });
  const c = coverage(m, { sims, detected }), v = vibestackCoverage(root, m, sims);
  c.bad.push(...buildProblems(root, m)); c.ok = !c.bad.length;
  // A vibestack project: its spec says what else must be covered (a simulated person per story, the rules proved by a
  // check, conformance walked on the deployed Worker, review read before a release: vibestack.mjs).
  if (v) { c.bad.push(...v.bad); c.lines.push(...v.lines); Object.assign(c.counts, v.counts); c.ok = !c.bad.length; }
  return c;
}
/** Wrangler runs a config's build.command in the cwd the train deploys from (the repo root), not beside the config: a
 *  Worker of a package whose build does not name that package would deploy whatever its folder last held. */
function buildProblems(root, m) {
  const configs = new Set((m.workers ?? []).flatMap((w) => Object.values(w.envs ?? {}).map((e) => e.config).filter(Boolean)));
  return [...configs].flatMap((config) => {
    const dir = dirname(config), command = (() => { try { return parseJsonc(readFileSync(join(root, config), "utf8")).build?.command; } catch { return undefined; } })();
    if (dir === "." || !command) return [];
    let pkg = ""; try { pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).name ?? ""; } catch { /* a folder that is not a package */ }
    const names = [dir, `./${dir}`, ...(pkg ? [pkg] : [])].map((x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");
    if (new RegExp(`(-C|--dir|--prefix|--filter|-F|cd)[ =](${names})(\\s|$|&|;)`).test(command)) return [];
    return [`${config}: build.command "${command}" runs in the repo root, so it builds the root and not ${dir}: name the folder (pnpm -C ${dir} build)${pkg ? ` or the package (pnpm --filter ${pkg} build)` : ""}`];
  });
}
function coverageMarker(c) { return `COVERAGE_OK surfaces=${c.counts.surfaces} unit=${c.counts.unit} e2e=${c.counts.e2e} user=${c.counts.user} waived=${c.counts.waived}${"stories" in c.counts ? ` stories=${c.counts.stories} rules=${c.counts.rules}` : ""}`; }

/** Put each Worker back on the version it ran before. Returns the names of those that went back. */
function rollback(before, root, log, why = "gate failed after deploy") {
  const n = [];
  for (const [name, b] of before) {
    if (!b.version) continue;
    const r = wrangler(["rollback", b.version, "-c", b.config, "--message", why, "-y"], { cwd: root });
    log(`${r.code === 0 ? "rolled back" : "ROLLBACK FAILED for"} ${name} to ${String(b.version).slice(0, 8)}`);
    if (r.code === 0) n.push(name);
  }
  return n;
}

/**
 * The version each Worker of an environment ran before its last deploy: Map(name → { config, version }). From this
 * checkout's own record of the deploy when it made it; otherwise from the ledger (a scheduled job did not do the deploy).
 */
function previousVersions(root, env, m) {
  const mine = Object.entries(readStamps(root)[env]?.previous ?? {}).filter(([, b]) => b?.version);
  if (mine.length) return new Map(mine);
  const script = join(dirname(realpathSync(new URL(import.meta.url).pathname)), "ledger.mjs"), r = existsSync(script) ? sh("node", [script, "previous", "--env", env, "--manifest", MANIFEST], { cwd: root }) : { code: 1, stdout: "" };
  let was = {}; try { was = r.code === 0 ? JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) : {}; } catch { /* nothing usable */ }
  const configs = new Map((m.workers ?? []).filter((w) => w.envs?.[env]?.config).map((w) => [parseJsonc(readFileSync(join(root, w.envs[env].config), "utf8")).name, join(root, w.envs[env].config)]));
  return new Map(Object.entries(was).filter(([name, v]) => v && configs.has(name)).map(([name, version]) => [name, { config: configs.get(name), version }]));
}

/** Every deploy goes on the ledger, pass or fail (ledger.mjs beside this script). A record that could not be written is said aloud. */
function ledger(root, env, outcome, gate, log) {
  const script = join(dirname(realpathSync(new URL(import.meta.url).pathname)), "ledger.mjs");
  if (!existsSync(script) || process.env.DEPLOY_LEDGER === "off") return;
  const r = sh("node", [script, "record", "--env", env, "--outcome", outcome, "--gate", gate, "--manifest", MANIFEST], { cwd: root });
  log(r.code === 0 ? r.stdout.trim().split("\n").at(-1) : `LEDGER NOT RECORDED for ${env} (${outcome}): ${r.out.trim().split("\n").at(-1)}`);
}

/**
 * The rollback drill: each Worker of an environment goes back to the version before its last deploy, the gates run on
 * that, and it comes forward again. Proves three things a real incident would otherwise find out: that Cloudflare lets
 * this version be rolled back (a migration can forbid it), that the version before still passes, and that coming
 * forward works. Never production: its rollback is exercised by a real failure or not at all.
 */
function drill(root, manifestPath, env) {
  if (!["staging", "preprod"].includes(env)) { console.error("usage: deploy.mjs drill <staging|preprod>   (a drill is never run on production or a preview)"); process.exit(2); }
  const m = JSON.parse(readFileSync(manifestPath, "utf8")), log = (s) => console.log(s), prev = Object.fromEntries(previousVersions(root, env, m)), now = new Map(), back = new Map(), done = [];
  for (const w of m.workers ?? []) {
    const config = w.envs?.[env]?.config; if (!config) continue;
    const name = parseJsonc(readFileSync(join(root, config), "utf8")).name, d = wrangler(["deployments", "status", "-c", join(root, config), "--json"], { cwd: root });
    let live = ""; try { live = JSON.parse(d.out.slice(d.out.indexOf("{"))).versions?.[0]?.version_id ?? ""; } catch { /* not deployed */ }
    if (!live || !prev[name]?.version || prev[name].version === live) { console.log(`ROLLBACK_DRILL_FAIL env=${env} ${name}: ${!live ? "nothing is deployed" : "there is no record of a different version before this one"}. Deploy ${env} through the train (\`deploy.mjs ${env}\`) and drill after that`); process.exit(1); }
    now.set(name, { config: join(root, config), version: live }); back.set(name, { config: join(root, config), version: prev[name].version });
    done.push({ name, key: w.name, url: m.subdomain ? `https://${name}.${m.subdomain}.workers.dev` : "" });
  }
  if (!back.size) { console.log(`ROLLBACK_DRILL_FAIL env=${env}: the manifest has no Worker there`); process.exit(1); }
  const went = rollback(back, root, log, "rollback drill").length;
  const gates = m.drill?.[env] ?? m.gates?.[env] ?? m.gates?.default ?? [], g = went === back.size ? runGates(gates, { root, env, done, log, label: "drill" }) : { passed: 0, failed: "the rollback itself" };
  // (Nothing went back: there is nothing to bring forward.)
  const forward = went ? rollback(now, root, (s) => log(s.replace("rolled back", "came forward:").replace(" to ", " is on ")), "rollback drill: forward again").length : now.size;
  if (forward !== now.size) { console.log(`ROLLBACK_DRILL_FAIL env=${env} COULD NOT COME FORWARD AGAIN: ${env} is on the older version. Run \`deploy.mjs ${env}\` now`); process.exit(1); }
  ledger(root, env, "ok", `drill ${g.passed}/${gates.length}`, log);
  if (g.failed) { console.log(`ROLLBACK_DRILL_FAIL env=${env} ${went === back.size ? `the version before does not pass ${JSON.stringify(g.failed)}: rolling back would not have helped` : "Cloudflare refused the rollback (a migration in this version forbids it?): a real failure could not be rolled back either"}; ${env} is back on the current version`); process.exit(1); }
  console.log(`ROLLBACK_DRILL_OK env=${env} workers=${back.size} gate=${g.passed}/${gates.length} (rolled back, gated, forward again)`);
}

/**
 * Every check the manifest lists for code that is not deployed yet (types, lint, unit, workerd, audits…), all of them
 * run even when one fails, so one push shows everything wrong with it. CHECKS_OK only when all pass.
 */
function checks(root, manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8")), list = m.checks ?? [];
  if (!list.length) { console.error("the manifest lists no checks: add at least typecheck and tests"); process.exit(2); }
  const only = arg("layer"), failed = [], ran = list.filter((c) => !only || c.layer === only);
  let extra = 0;
  if (!only || only === "coverage") {
    // Nothing deploys with a surface nobody tests: the coverage rule is the first check, in every repo.
    const c = coverageOf(root, manifestPath); extra = 1;
    console.log(`${c.ok ? "ok  " : "FAIL"} [coverage] every surface has unit, end-to-end and user tests${c.ok ? ` (${coverageMarker(c).slice("COVERAGE_OK ".length)})` : `\n  ${c.bad.join("\n  ")}`}`);
    if (!c.ok) failed.push("coverage");
  }
  for (const c of ran) {
    const t0 = Date.now(), r = sh("sh", ["-c", c.cmd], { cwd: root, timeout: (c.timeout_s ?? 1200) * 1000 });
    const ok = r.code === 0 && (!c.marker || r.out.includes(c.marker));
    console.log(`${ok ? "ok  " : "FAIL"} [${c.layer ?? "code"}] ${c.name ?? c.cmd} (${Math.round((Date.now() - t0) / 1000)} s)${ok ? "" : `\n${failTail(r)}`}`);
    if (!ok) failed.push(c.name ?? c.cmd);
  }
  if (failed.length) { console.log(`CHECKS_FAIL ${failed.length}: ${failed.join("; ")}`); process.exit(1); }
  console.log(`CHECKS_OK ${ran.length + extra}/${ran.length + extra}`);
}

/**
 * The soak verdict for every Worker of an environment, with the manifest's thresholds. Two sources, each read when it
 * can be: Cloudflare's analytics (soak.mjs, needs CLOUDFLARE_API_TOKEN and the account) and what the simulated people
 * met across the window (traffic.mjs judge, needs only wrangler's login). Without a token the simulated people alone
 * decide, and the marker says so: SOAK_ALL_OK env=… source=sims. With one, both must pass (source=analytics+sims).
 */
function soak(root, manifestPath, env) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8")), o = m.soak ?? {}, bad = [], sources = [];
  const here = dirname(realpathSync(new URL(import.meta.url).pathname)), script = join(here, "soak.mjs");
  const token = process.env.CLOUDFLARE_API_TOKEN && (process.env.CLOUDFLARE_ACCOUNT_ID || m.account);
  if (token) {
    sources.push("analytics");
    for (const w of m.workers ?? []) {
      const cfg = w.envs?.[env]?.config;
      if (!cfg) continue;
      const name = parseJsonc(readFileSync(join(root, cfg), "utf8")).name, per = { ...o, ...(w.soak ?? {}) };
      const args = [script, "--worker", name, "--hours", String(arg("hours", per.hours ?? 6)), "--min-requests", String(per.minRequests ?? 50), "--max-error-rate", String(per.maxErrorRate ?? 0.01)];
      if (per.probe?.[env]) args.push("--probe", per.probe[env]);
      if (m.account) args.push("--account", m.account);
      const r = sh("node", args, { cwd: root });
      process.stdout.write(r.out);
      if (r.code) bad.push(name);
    }
  }
  const t = existsSync(trafficScript()) ? sh("node", [trafficScript(), "judge", env, "--root", root, "--manifest", manifestPath, ...(arg("hours") ? ["--hours", arg("hours")] : [])], { cwd: root })
    : { code: 4, out: "TRAFFIC_NONE traffic.mjs is not beside deploy.mjs\n" };
  if (t.code === 4) {
    const why = t.out.trim().split("\n").at(-1).replace(/^TRAFFIC_NONE (env=\S+: )?/, "");
    if (!token) { console.log(`FAIL nothing to judge ${env} by: no CLOUDFLARE_API_TOKEN for Cloudflare's analytics, and no simulated people (${why})`); bad.push("all"); }
    else console.log(`     no simulated people on ${env}: ${why}`);
  } else {
    sources.push("sims");
    process.stdout.write(t.out);
    if (!token) console.log(`     judged from what the simulated people met and wrangler tail saw (no CLOUDFLARE_API_TOKEN, so not from Cloudflare's analytics)`);
    const named = [...t.out.matchAll(/^SOAK_(?:FAIL|UNKNOWN) worker=(\S+)/gm)].map((x) => x[1]);
    if (t.code) for (const n of named.length ? named : ["sims"]) if (!bad.includes(n)) bad.push(n);
  }
  const source = sources.join("+") || "none";
  if (bad.length) { console.log(`SOAK_ALL_FAIL env=${env} not_ready=${bad.join(",")} source=${source}`); process.exit(1); }
  console.log(`SOAK_ALL_OK env=${env} source=${source}`);
}
