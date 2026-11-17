#!/usr/bin/env node
// Simulated people use the deployed site all through the soak window, so the soak judges real-shaped use and not an
// empty staging. After every staging and preprod deploy (deploy.mjs starts it), a timer runs a round every 25 minutes
// for the soak's hours: `wrangler tail` listens on each Worker while the round's journeys run (the manifest's sims and
// smoke gates, or soak.traffic.run), and what they did and what the Worker answered is written down. The soak is then
// judged from those rounds when Cloudflare's analytics cannot be read (no CLOUDFLARE_API_TOKEN), and with them when it can.
//
//   node traffic.mjs start <env> --workers '<json>' [--scheduler systemd|none]   (deploy.mjs runs this after a deploy)
//   node traffic.mjs tick <env>       one round now (what the timer runs); at the window's end the verdict is written
//   node traffic.mjs stop <env>       stop the timer (deploy.mjs does this before deploying that environment again)
//   node traffic.mjs status <env>     the window, its rounds and the verdict when there is one
//   node traffic.mjs judge <env> [--hours 6] [--end <ISO time>] [--json]
//                                     SOAK_OK worker=… source=sims per Worker, from the rounds alone
// All take --root <repo> and --manifest <path> (default .deploy/manifest.json there).
//
// The judgement (per Worker, for the version live now): that version is the one the simulated people drove; it has
// been live the soak's hours; a round came at least every 2 x everyMinutes + 10 minutes across the window; every
// journey in every round worked (a failure the simulated people met is a failure of the soak, not noise); wrangler tail
// saw at least minRequests requests from that version, no more than maxErrorRate failed (5xx or an exception), and
// none ended at a platform limit; the probe answers. Ends with SOAK_OK … source=sims, or SOAK_FAIL with the reasons
// (exit 1); SOAK_UNKNOWN (exit 2) when wrangler could not say what is live. TRAFFIC_NONE (exit 4): nothing drives it.
//
// Cost: a journey run by an agent (sim.mjs) uses soak.traffic.model (default haiku) through SIM_AGENT_MODEL, and once
// the window's agent cost reaches soak.traffic.budgetUsd (default 3) only scripted journeys run on. A command may say
// `every: 3` to run every third round.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const SOAK_ENVS = ["staging", "preprod"];
const TRAFFIC_RE = /\bsim\.mjs\s+run\b|\bhttp-smoke\.mjs\b/;
// The same outcomes soak.mjs counts against a Worker (tail names a thrown exception "exception").
const HARD = new Set(["exceededMemory", "exceededCpu", "exceededResources", "internalError", "loadShed", "dosAttack"]);
const BENIGN = new Set(["ok", "success", "canceled", "clientDisconnected", "responseStreamDisconnected"]);

/** What drives an environment through its soak, from the manifest: soak.traffic.run, or the gates that are journeys. */
export function trafficPlan(m, env) {
  const t = m.soak?.traffic ?? {};
  const base = { everyMinutes: Math.max(5, Number(t.everyMinutes ?? 25)), budgetUsd: Number(t.budgetUsd ?? 3), model: t.model ?? "haiku",
    hours: Number(m.soak?.hours ?? 6), memoryMax: t.memoryMax ?? "", env: [].concat(t.env ?? []), tail: t.tail !== false };
  if (!SOAK_ENVS.includes(env)) return { ...base, run: [], off: `${env} does not soak` };
  if (typeof t.off === "string" && t.off.trim().length >= 15) return { ...base, run: [], off: t.off.trim(), waived: true };
  const named = t.run ?? (m.gates?.[env] ?? []).filter((g) => (typeof g === "string" ? TRAFFIC_RE.test(g) : g.traffic ?? TRAFFIC_RE.test(g.cmd ?? "")));
  const run = named.map((g) => (typeof g === "string" ? { cmd: g } : g)).map((g) => ({ ...g, agent: g.agent ?? /\bsim\.mjs\b/.test(g.cmd), every: Math.max(1, Number(g.every ?? 1)) }));
  return { ...base, run, off: run.length ? "" : `nothing in the manifest drives ${env} (soak.traffic.run, or a ${env} gate that runs sim.mjs or http-smoke.mjs)` };
}

/** The JSON objects in what `wrangler tail --format json` printed (pretty-printed, one after another). */
export function tailEvents(text) {
  const out = [];
  let depth = 0, inStr = false, esc = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"' && depth) inStr = true;
    else if (c === "{") { if (!depth) start = i; depth++; }
    else if (c === "}" && depth) { depth--; if (!depth) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* a torn event */ } } }
  }
  return out;
}

/** Requests one Worker answered, from its tail events: those of `version` (all, when it is not known) are counted. */
export function tally(events, version) {
  const t = { requests: 0, failed: 0, hard: {}, statuses: {}, other: 0, failures: [] };
  for (const e of events) {
    if (version && e.scriptVersion?.id && e.scriptVersion.id !== version) { t.other++; continue; }
    const outcome = e.outcome ?? "unknown", status = Number(e.event?.response?.status ?? 0);
    t.requests++;
    const key = status ? `${outcome}:${status}` : outcome;
    t.statuses[key] = (t.statuses[key] ?? 0) + 1;
    if (!BENIGN.has(outcome) || status >= 500) {
      t.failed++;
      // Which requests failed, so a soak that fails on them can be read without a second look (paths only: no query).
      let path = "?"; try { path = new URL(e.event?.request?.url ?? "").pathname; } catch { /* not a request */ }
      if (t.failures.length < 10) t.failures.push(`${e.event?.request?.method ?? e.event?.type ?? "event"} ${path} ${status || ""}${BENIGN.has(outcome) ? "" : ` ${outcome}`}${e.exceptions?.[0]?.message ? `: ${String(e.exceptions[0].message).slice(0, 120)}` : ""}`);
    }
    if (HARD.has(outcome)) t.hard[outcome] = (t.hard[outcome] ?? 0) + 1;
  }
  return t;
}

/** The verdict for each Worker from the rounds written down. Pure: `live` is what wrangler says runs now. */
export function judge({ window: w, rounds, live, now = Date.now(), hours, minRequests = 50, maxErrorRate = 0.01, probes = {} }) {
  const results = [];
  const h = Number(hours ?? w.hours ?? 6), every = w.everyMinutes ?? 25, allowedGap = every * 2 + 10;
  for (const wk of w.workers) {
    const lines = [], fails = [];
    const check = (ok, text) => { lines.push(`${ok ? "ok  " : "FAIL"} ${text}`); if (!ok) fails.push(text); };
    const l = live[wk.key] ?? {}, version = wk.version ?? "";
    const short = `${String(l.version ?? version ?? "?").slice(0, 8)}`;
    check(!!version && l.version === version, version ? (l.version === version ? `version ${short} is live, the one the simulated people drove` : `version ${String(l.version ?? "?").slice(0, 8)} is live, but the simulated people drove ${version.slice(0, 8)}: deploy through the train and they start again`) : `no version was recorded when the simulated people started`);
    const liveSince = Date.parse(l.liveSince ?? wk.liveSince ?? w.startedAt), end = Math.min(now, Date.parse(w.until)), ageH = (end - liveSince) / 3600_000;
    check(ageH >= h, `version ${short} live for ${Math.max(0, ageH).toFixed(1)} h of the window (needs ${h} h; deployed ${new Date(liveSince).toISOString()})`);
    const from = Math.max(liveSince, end - h * 3600_000);
    const mine = rounds.filter((r) => Date.parse(r.at) >= from && Date.parse(r.at) <= end && (!version || r.versions?.[wk.key] === version));
    const points = [from, ...mine.map((r) => Date.parse(r.at)), end].sort((a, b) => a - b);
    const gap = Math.max(0, ...points.slice(1).map((p, i) => (p - points[i]) / 60_000));
    check(mine.length > 0 && gap <= allowedGap, `${mine.length} rounds of simulated people across the window, the longest wait ${Math.round(gap)} min (allowed ${allowedGap})`);
    const broken = mine.filter((r) => r.commands.some((c) => !c.ok));
    check(broken.length === 0, `every journey worked: ${broken.length} of ${mine.length} rounds met a failure${broken.length ? `: ${broken.slice(0, 4).map((r) => `${r.at.slice(11, 16)} ${r.commands.filter((c) => !c.ok).map((c) => c.name).join(", ")}${w.commit && r.checkout && r.checkout !== w.commit ? ` (journeys from ${r.checkout}, site from ${w.commit})` : ""}`).join("; ")}` : ""}`);
    const sum = { requests: 0, failed: 0, hard: {}, seen: {} };
    for (const r of mine) {
      const t = r.tail?.[wk.key]; if (!t) continue;
      sum.requests += t.requests; sum.failed += t.failed;
      for (const [k, v] of Object.entries(t.hard ?? {})) sum.hard[k] = (sum.hard[k] ?? 0) + v;
      for (const f of t.failures ?? []) sum.seen[f] = (sum.seen[f] ?? 0) + 1;
    }
    const seen = Object.entries(sum.seen).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${f} x${n}`).join("; ");
    const tailed = mine.filter((r) => r.tail?.[wk.key]).length;
    check(sum.requests >= minRequests, `${sum.requests} requests seen by wrangler tail in ${tailed} of ${mine.length} rounds (needs ${minRequests}: no errors with no use proves nothing)`);
    const rate = sum.requests ? sum.failed / sum.requests : 0;
    check(rate <= maxErrorRate, `${sum.failed} failed requests of ${sum.requests} (${(rate * 100).toFixed(2)}%, limit ${(maxErrorRate * 100).toFixed(2)}%)${seen ? `: ${seen}` : ""}`);
    check(Object.keys(sum.hard).length === 0, `no request ended at a platform limit${Object.keys(sum.hard).length ? `: ${JSON.stringify(sum.hard)}` : ""}`);
    if (probes[wk.key]) check(probes[wk.key].ok, `probe ${probes[wk.key].path} answered HTTP ${probes[wk.key].status} in ${probes[wk.key].ms} ms`);
    const cost = mine.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    lines.push(`     the simulated people's agents cost $${cost.toFixed(2)} in this window (budget $${Number(w.budgetUsd ?? 0).toFixed(2)})`);
    const marker = fails.length ? `SOAK_FAIL worker=${wk.name} version=${short} reasons=${fails.length} source=sims`
      : `SOAK_OK worker=${wk.name} version=${short}@100% hours=${h} requests=${sum.requests} failed=${sum.failed} rounds=${mine.length} source=sims`;
    results.push({ worker: wk.name, key: wk.key, ok: !fails.length, lines, fails, marker, requests: sum.requests, failed: sum.failed, rounds: mine.length });
  }
  return results;
}

// ---------- the command ----------

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const sh = (bin, args, opts = {}) => {
  const r = spawnSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };

function paths(root, env) {
  const dir = join(root, ".deploy", ".soak");
  return { dir, window: join(dir, `${env}.json`), rounds: join(dir, `${env}.rounds.jsonl`), verdict: join(dir, `${env}.verdict.json`), lock: join(dir, `${env}.lock`) };
}
const headOf = (root) => sh("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root }).stdout.trim();
const readRounds = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
export function unitName(root, env) {
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "repo";
  return `train-traffic-${slug}-${createHash("sha256").update(root).digest("hex").slice(0, 6)}-${env}`;
}
function schedulerOf(m) {
  const s = arg("scheduler") ?? process.env.RELEASE_TRAIN_SCHEDULER ?? m.soak?.traffic?.scheduler;
  if (s) return s;
  return !process.env.CI && sh("systemctl", ["--user", "show-environment"]).code === 0 ? "systemd" : "none";
}
/** The environment wrangler runs in. A manifest pinned to an account ("account") acts on that account only, never on
 *  whichever account wrangler's own login sees first (a Worker of the same name on another account would be tailed and
 *  judged in its place). CF_ENV_FILE names a file with CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID) lines, as for
 *  promote-local.sh; it is read every time, so the timer's rounds use what the file says now. */
export function cfEnv(m, base = process.env) {
  const env = { ...base }, f = String(base.CF_ENV_FILE ?? "").replace(/^~(?=\/)/, base.HOME ?? "~");
  if (f && existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n")) {
    const x = l.match(/^(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)=(.*)$/);
    if (x) env[x[1]] = x[2].trim().replace(/^["']|["']$/g, "");
  }
  if (m?.account) env.CLOUDFLARE_ACCOUNT_ID = m.account;
  return env;
}
/** What runs now for each Worker, by wrangler (its own login, or CF_ENV_FILE's token: no analytics token needed). */
function liveOf(root, workers, env = process.env) {
  const live = {};
  for (const w of workers) {
    const r = sh("npx", ["--no-install", "wrangler", "deployments", "status", "-c", join(root, w.config), "--json"], { cwd: root, timeout: 120_000, env });
    try { const j = JSON.parse(r.out.slice(r.out.indexOf("{"))); live[w.key] = { version: j.versions?.[0]?.version_id ?? null, liveSince: j.created_on ?? null }; }
    catch {
      const said = r.out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter((l) => l && !/Logs were written/.test(l));
      live[w.key] = { version: null, error: said.find((l) => /\[code: \d+\]/.test(l)) ?? said.find((l) => /\[ERROR\]/.test(l)) ?? said.at(-1) ?? "no answer" };
    }
  }
  return live;
}
function stopTimer(unit, scheduler, { service = true } = {}) {
  if (scheduler !== "systemd") return;
  sh("systemctl", ["--user", "stop", `${unit}.timer`, ...(service ? [`${unit}.service`] : [])]);
  sh("systemctl", ["--user", "reset-failed", `${unit}.timer`, `${unit}.service`]);
}

function start(root, manifestPath, env, m) {
  const plan = trafficPlan(m, env), p = paths(root, env);
  if (!plan.run.length) { console.log(`TRAFFIC_NONE env=${env}: ${plan.off}`); process.exit(plan.waived ? 0 : 4); }
  const given = JSON.parse(arg("workers", "[]"));
  if (!given.length) { console.log(`TRAFFIC_FAIL env=${env}: no Workers were given (--workers)`); process.exit(1); }
  const scheduler = schedulerOf(m), unit = unitName(root, env), at = new Date();
  // Asked with what the timer's rounds will have (systemd keeps only PATH, HOME, CF_ENV_FILE and soak.traffic.env), so a
  // token that is in this shell only does not hide that the rounds could not see the account.
  const kept = ["PATH", "HOME", "CF_ENV_FILE", ...plan.env];
  const roundEnv = scheduler === "systemd" ? Object.fromEntries(kept.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) : process.env;
  const live = liveOf(root, given, cfEnv(m, roundEnv));
  const blind = m.account ? given.filter((w) => !live[w.key]?.version) : [];
  if (blind.length) {
    console.log(`TRAFFIC_FAIL env=${env}: wrangler, as the rounds would run it, cannot see what runs on account ${m.account} (${blind.map((w) => `${w.name}: ${String(live[w.key]?.error ?? "no answer").slice(0, 160)}`).join("; ")}). Set CF_ENV_FILE to a file with a static CLOUDFLARE_API_TOKEN line for that account (an OAuth token from wrangler login expires within hours), then start again`);
    process.exit(1);
  }
  const workers = given.map((w) => ({ ...w, version: live[w.key]?.version ?? null, liveSince: live[w.key]?.liveSince ?? new Date().toISOString() }));
  const old = readJson(p.window);
  if (old) stopTimer(old.unit ?? unit, old.scheduler ?? scheduler);
  mkdirSync(p.dir, { recursive: true });
  if (existsSync(p.rounds)) renameSync(p.rounds, p.rounds.replace(/\.jsonl$/, ".prev.jsonl"));
  rmSync(p.verdict, { force: true });
  const w = { env, startedAt: at.toISOString(), until: new Date(at.getTime() + (plan.hours * 60 + plan.everyMinutes + 5) * 60_000).toISOString(), hours: plan.hours,
    everyMinutes: plan.everyMinutes, budgetUsd: plan.budgetUsd, model: plan.model, scheduler, unit, commit: headOf(root), manifest: manifestPath, workers, run: plan.run, tail: plan.tail, env_keys: plan.env };
  writeFileSync(p.window, JSON.stringify(w, null, 2));
  const self = realpathSync(new URL(import.meta.url).pathname);
  if (scheduler === "systemd") {
    const keep = kept.filter((k) => process.env[k] !== undefined).map((k) => `--setenv=${k}=${process.env[k]}`);
    const r = sh("systemd-run", ["--user", `--unit=${unit}`, `--description=release train: simulated people on ${basename(root)} ${env}`, "--on-active=60",
      `--on-unit-active=${plan.everyMinutes}min`, "--timer-property=AccuracySec=30s", `--working-directory=${root}`, ...keep, "-p", "Nice=10",
      ...(plan.memoryMax ? ["-p", `MemoryMax=${plan.memoryMax}`] : []), "--", process.execPath, self, "tick", env, "--root", root, "--manifest", manifestPath]);
    if (r.code) { console.log(`TRAFFIC_FAIL env=${env}: the timer could not be made: ${r.out.trim().split("\n").at(-1)}`); process.exit(1); }
  }
  const versions = workers.map((x) => `${x.name}@${String(x.version ?? "?").slice(0, 8)}`).join(",");
  console.log(`TRAFFIC_ON env=${env} every=${plan.everyMinutes}min until=${w.until} journeys=${plan.run.length} model=${plan.model} budget=$${plan.budgetUsd} versions=${versions} scheduler=${scheduler}${scheduler === "systemd" ? ` unit=${unit}` : ` (run \`node .deploy/traffic.mjs tick ${env}\` every ${plan.everyMinutes} min: the hub's routines, cron or a scheduled workflow)`}`);
}

/** wrangler tail on each Worker while `body` runs: what each one answered. */
async function tailed(root, workers, body, { warmMs, settleMs, env = process.env }) {
  const bin = join(root, "node_modules", ".bin", "wrangler");
  const tails = workers.map((w) => {
    const [cmd, args] = existsSync(bin) ? [bin, []] : ["npx", ["--no-install", "wrangler"]];
    const child = spawn(cmd, [...args, "tail", "-c", join(root, w.config), "--format", "json"], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const t = { w, out: "", err: "", child, closed: false };
    child.stdout.on("data", (d) => { t.out += d; }); child.stderr.on("data", (d) => { t.err += d; });
    child.on("close", () => { t.closed = true; }); child.on("error", (e) => { t.err += String(e.message); t.closed = true; });
    return t;
  });
  await sleep(warmMs);
  let result;
  try { result = await body(); } finally {
    await sleep(settleMs);
    for (const t of tails) { try { process.kill(-t.child.pid, "SIGINT"); } catch { /* gone */ } }
    for (let i = 0; i < 30 && tails.some((t) => !t.closed); i++) await sleep(100);
    for (const t of tails) if (!t.closed) { try { process.kill(-t.child.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  return { result, tails };
}

async function tick(root, env) {
  const p = paths(root, env), w = readJson(p.window);
  if (!w) { console.log(`TRAFFIC_IDLE env=${env}: no soak window (deploy.mjs ${env} starts one)`); return 0; }
  if (w.stopped) { console.log(`TRAFFIC_IDLE env=${env}: stopped at ${w.stopped.at}: ${w.stopped.why}`); return 0; }
  const now = Date.now();
  if (now > Date.parse(w.until)) {
    const v = verdict(root, env, w);
    writeFileSync(p.verdict, JSON.stringify(v, null, 2));
    for (const l of v.lines) console.log(l);
    stopTimer(w.unit, w.scheduler, { service: false });
    console.log(`TRAFFIC_DONE env=${env} rounds=${readRounds(p.rounds).length} verdict=${v.ok ? "SOAK_ALL_OK" : "SOAK_ALL_FAIL"}`);
    return 0;
  }
  if (existsSync(p.lock)) {
    const pid = Number(readFileSync(p.lock, "utf8"));
    try { process.kill(pid, 0); console.log(`TRAFFIC_BUSY env=${env}: round ${pid} is still running`); return 0; } catch { /* left behind */ }
  }
  writeFileSync(p.lock, String(process.pid));
  try {
    const wenv = cfEnv(readJson(w.manifest, {}));
    const live = liveOf(root, w.workers, wenv);
    const moved = w.workers.filter((x) => x.version && live[x.key]?.version && live[x.key].version !== x.version);
    if (moved.length) {
      const why = `a newer deploy landed: ${moved.map((x) => `${x.name} runs ${String(live[x.key].version).slice(0, 8)}, not ${String(x.version).slice(0, 8)}`).join("; ")}`;
      writeFileSync(p.window, JSON.stringify({ ...w, stopped: { at: new Date().toISOString(), why } }, null, 2));
      stopTimer(w.unit, w.scheduler, { service: false });
      console.log(`TRAFFIC_STOPPED env=${env}: ${why}`);
      return 0;
    }
    // The journeys are the checkout's, the site is what was deployed: when the checkout has moved on (a commit not deployed
    // yet), a journey may expect what the site does not do yet. The round says so, and so does a failure it causes.
    const checkout = headOf(root);
    if (w.commit && checkout && checkout !== w.commit) console.log(`     the checkout is at ${checkout}, the site was deployed from ${w.commit}: these journeys are the checkout's`);
    const before = readRounds(p.rounds), n = before.length;
    let spent = before.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const roundStart = new Date();
    const urls = Object.fromEntries(w.workers.filter((x) => x.url).map((x) => [`DEPLOY_URL_${x.key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, x.url]));
    const runAll = async () => {
      const ran = [];
      for (const c of w.run) {
        const name = c.name ?? c.cmd;
        if (n % c.every) { ran.push({ name, skipped: `every ${c.every} rounds`, ok: true }); continue; }
        if (c.agent && spent >= w.budgetUsd) { ran.push({ name, skipped: `the agent budget ($${w.budgetUsd}) is spent`, ok: true }); continue; }
        const t0 = Date.now();
        const r = await new Promise((done) => {
          const child = spawn("sh", ["-c", c.cmd], { cwd: root, env: { ...process.env, ...urls, DEPLOY_ENV: env, DEPLOY_URLS: w.workers.map((x) => x.url).join(","), DEPLOY_WORKERS: w.workers.map((x) => x.name).join(","),
            SIM_AGENT_MODEL: process.env.SIM_AGENT_MODEL || w.model, SOAK_ROUND: String(n) }, stdio: ["ignore", "pipe", "pipe"] });
          let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
          const timer = setTimeout(() => child.kill("SIGKILL"), (c.timeout_s ?? 900) * 1000);
          child.on("close", (code) => { clearTimeout(timer); done({ code: code ?? 1, out }); });
        });
        const ok = r.code === 0 && (!c.marker || r.out.includes(c.marker));
        const cost = c.agent ? simCost(root, w, roundStart) - spent0(ran) : 0;
        ran.push({ name, ok, code: r.code, s: Math.round((Date.now() - t0) / 1000), ...(ok ? {} : { tail: r.out.slice(-1500) }), ...(c.agent ? { costUsd: Math.max(0, cost) } : {}) });
        if (c.agent) spent += Math.max(0, cost);
      }
      return ran;
    };
    const spent0 = (ran) => ran.reduce((s, x) => s + (x.costUsd ?? 0), 0);
    const warmMs = Number(process.env.TRAFFIC_TAIL_WARM_MS ?? 10_000), settleMs = Number(process.env.TRAFFIC_TAIL_SETTLE_MS ?? 5_000);
    const { result: commands, tails } = w.tail ? await tailed(root, w.workers, runAll, { warmMs, settleMs, env: wenv }) : { result: await runAll(), tails: [] };
    const tail = Object.fromEntries(tails.map((t) => { const ev = tailEvents(t.out); return [t.w.key, { ...tally(ev, t.w.version), ...(ev.length ? {} : { said: t.err.trim().split("\n").slice(-2).join(" ").slice(0, 300) }) }]; }));
    const round = { n, checkout, at: roundStart.toISOString(), ended: new Date().toISOString(), versions: Object.fromEntries(w.workers.map((x) => [x.key, live[x.key]?.version ?? null])),
      commands, tail, costUsd: commands.reduce((s, c) => s + (c.costUsd ?? 0), 0) };
    appendFileSync(p.rounds, JSON.stringify(round) + "\n");
    for (const c of commands) console.log(`${c.skipped ? "skip" : c.ok ? "ok  " : "FAIL"} ${c.name}${c.skipped ? ` (${c.skipped})` : ` (${c.s} s${c.costUsd ? `, $${c.costUsd.toFixed(2)}` : ""})`}${c.ok ? "" : `\n${c.tail}`}`);
    const req = Object.values(tail).reduce((s, t) => s + t.requests, 0), bad = Object.values(tail).reduce((s, t) => s + t.failed, 0);
    for (const [k, t] of Object.entries(tail)) {
      if (t.said) console.log(`     wrangler tail on ${k} saw nothing: ${t.said}`);
      for (const f of t.failures ?? []) console.log(`     failed on ${k}: ${f}`);
    }
    console.log(`TRAFFIC_ROUND env=${env} n=${n} journeys=${commands.filter((c) => !c.skipped && c.ok).length}/${commands.filter((c) => !c.skipped).length} requests=${req} failed=${bad} cost=$${round.costUsd.toFixed(2)} spent=$${spent.toFixed(2)}`);
    return 0;
  } finally { rmSync(p.lock, { force: true }); }
}

/** The agent cost the sim runs wrote since `since` (sim.mjs writes each scenario's costUsd to its runs folder). */
function simCost(root, w, since) {
  const m = readJson(w.manifest, {}), dir = resolve(root, m.sims?.runs ?? ".deploy/.sim-runs");
  if (!existsSync(dir)) return 0;
  let sum = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "flaky.json")) {
    const r = readJson(join(dir, f));
    if (r?.at && Date.parse(r.at) >= since.getTime()) sum += Number(r.costUsd ?? 0);
  }
  return sum;
}

function verdict(root, env, w, { hours, end } = {}) {
  const m = readJson(w.manifest, {}), o = m.soak ?? {}, p = paths(root, env), rounds = readRounds(p.rounds);
  const live = liveOf(root, w.workers, cfEnv(m));
  const unknown = w.workers.filter((x) => !live[x.key]?.version);
  if (unknown.length) return { ok: false, unknown: true, lines: unknown.map((x) => `SOAK_UNKNOWN worker=${x.name}: wrangler could not say what runs now (${live[x.key]?.error ?? "?"})`), at: new Date().toISOString() };
  const probes = {};
  for (const x of w.workers) {
    const per = { ...o, ...((m.workers ?? []).find((y) => y.name === x.key)?.soak ?? {}) };
    if (per.probe?.[env]) {
      const t0 = Date.now(), r = spawnSync(process.execPath, ["-e", `fetch(${JSON.stringify(per.probe[env])},{redirect:"manual",signal:AbortSignal.timeout(15000)}).then(r=>console.log(r.status),e=>console.log(0))`], { encoding: "utf8" });
      const status = Number(r.stdout.trim()) || 0;
      probes[x.key] = { ok: status >= 200 && status < 400, status, ms: Date.now() - t0, path: new URL(per.probe[env]).pathname };
    }
  }
  const res = judge({ window: w, rounds, live, now: end ? Date.parse(end) : Date.now(), hours, probes,
    minRequests: Number(o.minRequests ?? 50), maxErrorRate: Number(o.maxErrorRate ?? 0.01) });
  return { ok: res.every((r) => r.ok), at: new Date().toISOString(), results: res, lines: res.flatMap((r) => [...r.lines, r.marker]) };
}

async function main() {
  const cmd = argv[0], env = argv[1] ?? "staging";
  const root = resolve(arg("root", process.cwd())), manifestPath = resolve(root, arg("manifest", ".deploy/manifest.json"));
  const m = readJson(manifestPath);
  if (!m) { console.error(`no manifest at ${manifestPath}`); process.exit(2); }
  const p = paths(root, env);
  if (cmd === "start") return start(root, manifestPath, env, m);
  if (cmd === "tick") process.exit(await tick(root, env));
  if (cmd === "stop") {
    const w = readJson(p.window);
    if (!w) { console.log(`TRAFFIC_IDLE env=${env}: nothing to stop`); return; }
    stopTimer(w.unit, w.scheduler);
    if (!w.stopped) writeFileSync(p.window, JSON.stringify({ ...w, stopped: { at: new Date().toISOString(), why: arg("why", "stopped by hand") } }, null, 2));
    console.log(`TRAFFIC_STOPPED env=${env}: ${arg("why", "stopped by hand")}`);
    return;
  }
  if (cmd === "status") {
    const w = readJson(p.window);
    if (!w) { console.log(`TRAFFIC_IDLE env=${env}: no soak window`); return; }
    const rounds = readRounds(p.rounds), v = readJson(p.verdict);
    console.log(`window ${w.startedAt} .. ${w.until}, every ${w.everyMinutes} min, ${w.scheduler}${w.unit ? ` (${w.unit})` : ""}${w.stopped ? `; stopped ${w.stopped.at}: ${w.stopped.why}` : ""}`);
    for (const r of rounds.slice(-12)) console.log(`round ${r.n} ${r.at}: ${r.commands.filter((c) => !c.skipped && c.ok).length}/${r.commands.filter((c) => !c.skipped).length} journeys, ${Object.values(r.tail ?? {}).reduce((s, t) => s + t.requests, 0)} requests, $${(r.costUsd ?? 0).toFixed(2)}`);
    if (v) console.log(`verdict at ${v.at}: ${v.ok ? "SOAK_ALL_OK" : "SOAK_ALL_FAIL"}`);
    console.log(`TRAFFIC_STATUS env=${env} rounds=${rounds.length} cost=$${rounds.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(2)}${w.stopped ? " stopped" : ""}${v ? ` verdict=${v.ok ? "ok" : "fail"}` : ""}`);
    return;
  }
  if (cmd === "judge") {
    const plan = trafficPlan(m, env), w = readJson(p.window);
    if (!plan.run.length) { console.log(`TRAFFIC_NONE env=${env}: ${plan.off}`); process.exit(4); }
    if (!w) { console.log(`FAIL no simulated people have used ${env} since its last deploy (no .deploy/.soak/${env}.json): deploy it through the train (deploy.mjs ${env}) and they start`); console.log(`SOAK_FAIL worker=* reasons=1 source=sims`); process.exit(1); }
    const v = verdict(root, env, w, { hours: arg("hours"), end: arg("end") });
    if (argv.includes("--json")) console.log(JSON.stringify(v)); else for (const l of v.lines) console.log(l);
    process.exit(v.unknown ? 2 : v.ok ? 0 : 1);
  }
  console.error("usage: traffic.mjs start|tick|stop|status|judge <env> [--root r] [--manifest m]");
  process.exit(2);
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) await main();
