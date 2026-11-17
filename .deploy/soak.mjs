#!/usr/bin/env node
// Soak verdict for one Cloudflare Worker: has the version that is live now been live long enough, with real use and
// no trouble, to be promoted? Reads Cloudflare's own records (deployments + GraphQL analytics); stores nothing.
//
//   node soak.mjs --worker chronos-memory-staging [--hours 6] [--min-requests 50] [--max-error-rate 0.01]
//                 [--probe https://…/healthz] [--account <id>] [--end <ISO time>] [--json]
//
// Three more questions, each asked only when its option is given:
//   --since-deploy [--min-minutes 15]   judge the time since the live version was deployed, not a fixed window: the
//                                       watch after a production deploy. Sooner than --min-minutes it is SOAK_EARLY
//                                       (exit 3): too soon to say, which is not a pass. So is too little use since the
//                                       deploy (fewer than --min-requests) when nothing seen so far is wrong.
//   --baseline-hours 6 [--max-error-ratio 2] [--min-rate 0.002]
//                                       compare with the hours before the deploy. A fixed 1% limit misses a version
//                                       that is twice as bad as the one before it and still under 1%: this fails when
//                                       the failure rate is more than twice what it was (and over --min-rate, with at
//                                       least 5 failures, so that noise on a quiet Worker is not a verdict).
//   --slo 0.99 [--budget-days 30]       the error budget: with a 99% target, 1% of the period's requests may fail.
//                                       Fails when under a fifth of that allowance is left: it is time for fixes, not
//                                       for more change.
//
// Needs CLOUDFLARE_API_TOKEN (Account Analytics: Read, Workers Scripts: Read) and CLOUDFLARE_ACCOUNT_ID (or --account).
// Prints one line per check and ends with a success-only marker:  SOAK_OK worker=… sha/version=… hours=… requests=…
// Any failed check prints SOAK_FAIL with the reasons and exits 1. Exit 2: could not ask Cloudflare (never a pass).

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(`--${name}`);
const worker = arg("worker"), hours = Number(arg("hours", "6")), minRequests = Number(arg("min-requests", "50"));
const maxErrorRate = Number(arg("max-error-rate", "0.01")), probe = arg("probe"), account = arg("account", process.env.CLOUDFLARE_ACCOUNT_ID);
const sinceDeploy = flag("since-deploy"), minMinutes = Number(arg("min-minutes", "15")), baselineHours = Number(arg("baseline-hours", "0")), maxRatio = Number(arg("max-error-ratio", "2")), minRate = Number(arg("min-rate", "0.002"));
const slo = Number(arg("slo", "0")), budgetDays = Number(arg("budget-days", "30"));
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!worker || !account || !token) { console.error("usage: soak.mjs --worker <name> [--hours 6] …  with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (or --account)"); process.exit(2); }

const API = process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4"; // (a test points this at a made-up Cloudflare)
const cf = async (path, init = {}) => {
  const r = await fetch(API + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.success === false || j.errors?.length) throw new Error(`Cloudflare ${path.split("?")[0]} answered HTTP ${r.status}: ${JSON.stringify(j?.errors ?? j)?.slice(0, 200)}`);
  return j;
};
const gql = async (query) => (await cf("/graphql", { method: "POST", body: JSON.stringify({ query }) })).data.viewer.accounts[0];

// Statuses that are the Worker's own trouble. A client hanging up, or a request cancelled by one, is not.
const HARD = new Set(["exceededMemory", "exceededCpu", "exceededResources", "internalError", "loadShed", "dosAttack"]);
const BENIGN = new Set(["success", "clientDisconnected", "canceled", "responseStreamDisconnected"]);

const fails = [], lines = [];
const check = (ok, text) => { lines.push(`${ok ? "ok  " : "FAIL"} ${text}`); if (!ok) fails.push(text); };

try {
  // --end <ISO time>: judge a past window (to check the checker against a known bad day); the default is now.
  const now = arg("end") ? new Date(arg("end")) : new Date();
  let from = new Date(now.getTime() - hours * 3600_000);
  // 1. The live version, and how long it has been live. A deploy inside the window restarts the clock: the soak is of
  //    one version, not of "staging lately".
  const dep = (await cf(`/accounts/${account}/workers/scripts/${worker}/deployments`)).result?.deployments?.[0];
  if (!dep) throw new Error(`no deployment found for ${worker}`);
  const liveSince = new Date(dep.created_on), ageH = (now - liveSince) / 3600_000;
  const version = dep.versions?.map((v) => `${String(v.version_id).slice(0, 8)}@${v.percentage}%`).join("+") ?? "?";
  if (sinceDeploy && ageH * 60 < minMinutes) { console.log(`SOAK_EARLY worker=${worker} version=${version}: deployed ${Math.floor(ageH * 60)} min ago; judged after ${minMinutes} min`); process.exit(3); }
  if (sinceDeploy) from = liveSince;
  else check(ageH >= hours, `version ${version} live for ${ageH.toFixed(1)} h (needs ${hours} h; deployed ${liveSince.toISOString()})`);
  const span = sinceDeploy ? `since the deploy (${ageH.toFixed(1)} h)` : `in the last ${hours} h`;
  check((dep.versions ?? []).length === 1, `one version takes all traffic (${(dep.versions ?? []).length} in the deployment)`);

  const flt = `datetime_geq:"${from.toISOString()}",datetime_lt:"${now.toISOString()}"`;
  // 2. Requests in the window, by outcome and by minute.
  const w = (await gql(`query{viewer{accounts(filter:{accountTag:"${account}"}){
    w:workersInvocationsAdaptive(limit:9999,filter:{${flt},scriptName:"${worker}"}){dimensions{datetimeMinute status} sum{requests errors}}}}}`)).w;
  let requests = 0, bad = 0;
  const hard = {}, byMinute = new Map();
  for (const r of w) {
    const n = r.sum.requests, s = r.dimensions.status, m = r.dimensions.datetimeMinute;
    requests += n;
    const cell = byMinute.get(m) ?? { all: 0, bad: 0 };
    cell.all += n;
    if (!BENIGN.has(s)) { bad += n; cell.bad += n; }
    if (HARD.has(s)) hard[s] = (hard[s] ?? 0) + n;
    byMinute.set(m, cell);
  }
  // Since a deploy, too little use is "cannot say yet", not a failure: a quiet evening must not roll a healthy release back.
  const quiet = sinceDeploy && requests < minRequests;
  if (!quiet) check(requests >= minRequests, `${requests} requests ${span} (needs ${minRequests}: no errors with no use proves nothing)`);
  const rate = requests ? bad / requests : 0;
  check(rate <= maxErrorRate, `${bad} failed requests of ${requests} (${(rate * 100).toFixed(2)}%, limit ${(maxErrorRate * 100).toFixed(2)}%)`);
  check(Object.keys(hard).length === 0, `no request ended at a platform limit${Object.keys(hard).length ? `: ${JSON.stringify(hard)}` : ""}`);
  // Outcomes by hour over a longer span (the minute rows above would run past the row limit).
  const byHour = async (alias, a, b) => {
    const rows = (await gql(`query{viewer{accounts(filter:{accountTag:"${account}"}){
      ${alias}:workersInvocationsAdaptive(limit:9999,filter:{datetime_geq:"${a.toISOString()}",datetime_lt:"${b.toISOString()}",scriptName:"${worker}"}){dimensions{datetimeHour status} sum{requests}}}}}`))[alias];
    let all = 0, failed = 0;
    for (const r of rows) { all += r.sum.requests; if (!BENIGN.has(r.dimensions.status)) failed += r.sum.requests; }
    return { all, failed, rate: all ? failed / all : 0 };
  };
  // 2b. Against the version before it: twice as many failures as before is a regression even under the fixed limit.
  if (baselineHours) {
    const before = await byHour("b", new Date(liveSince.getTime() - baselineHours * 3600_000), liveSince), limit = Math.max(maxRatio * before.rate, minRate);
    if (before.all < minRequests) check(true, `not compared with before the deploy: only ${before.all} requests in the ${baselineHours} h before it`);
    else check(!(rate > limit && bad >= 5), `failure rate ${(rate * 100).toFixed(2)}% against ${(before.rate * 100).toFixed(2)}% in the ${baselineHours} h before the deploy (fails over ${maxRatio}x, that is ${(limit * 100).toFixed(2)}%)`);
  }
  // 2c. The error budget of the period: what the target allows to fail, and how much of that is left.
  if (slo) {
    const period = await byHour("g", new Date(now.getTime() - budgetDays * 86_400_000), now), allowed = (1 - slo) * period.all, left = allowed ? 1 - period.failed / allowed : 1;
    check(left >= 0.2, `${(Math.max(left, 0) * 100).toFixed(0)}% of the error budget is left (${period.failed} failed of ${period.all} in ${budgetDays} days; a ${(slo * 100).toFixed(1)}% target allows ${Math.floor(allowed)}; under 20% left is time for fixes only)`);
  }
  // 3. Uptime: a minute in which requests came and every one failed is a minute down.
  const down = [...byMinute.entries()].filter(([, c]) => c.all >= 2 && c.bad === c.all).map(([m]) => m.slice(11, 16)).sort();
  check(down.length === 0, `no minute with every request failing${down.length ? `: ${down.slice(0, 6).join(", ")}${down.length > 6 ? ` (+${down.length - 6})` : ""}` : ""} (${byMinute.size} minutes with traffic)`);
  // 4. Durable Objects of this Worker: resets at the memory limit and fatal errors never show as a failed request.
  const spaces = [];
  for (let page = 1; page < 20; page++) {
    const res = (await cf(`/accounts/${account}/workers/durable_objects/namespaces?per_page=50&page=${page}`)).result ?? [];
    spaces.push(...res.filter((n) => n.script === worker));
    if (res.length < 50) break;
  }
  for (const ns of spaces) {
    const p = (await gql(`query{viewer{accounts(filter:{accountTag:"${account}"}){
      p:durableObjectsPeriodicGroups(limit:9999,filter:{${flt},namespaceId:"${ns.id}"}){sum{exceededMemoryErrors exceededCpuErrors fatalInternalErrors}}}}}`)).p;
    const sum = (k) => p.reduce((a, r) => a + (r.sum[k] ?? 0), 0);
    const mem = sum("exceededMemoryErrors"), cpu = sum("exceededCpuErrors"), fatal = sum("fatalInternalErrors");
    check(mem + cpu + fatal === 0, `Durable Object ${ns.class}: ${mem} memory resets, ${cpu} CPU limit, ${fatal} fatal errors`);
  }
  // 5. It answers right now.
  if (probe) {
    const t0 = Date.now();
    const r = await fetch(probe, { redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch((e) => ({ status: 0, statusText: String(e?.message ?? e) }));
    check(r.status >= 200 && r.status < 400, `probe ${new URL(probe).pathname} answered HTTP ${r.status || r.statusText} in ${Date.now() - t0} ms`);
  }

  if (flag("json")) console.log(JSON.stringify({ worker, version, live_since: liveSince.toISOString(), hours, requests, failed: bad, hard, down_minutes: down.length, ok: fails.length === 0, fails }));
  else for (const l of lines) console.log(l);
  if (fails.length) { console.log(`SOAK_FAIL worker=${worker} version=${version} reasons=${fails.length}`); process.exit(1); }
  if (quiet) { console.log(`SOAK_EARLY worker=${worker} version=${version}: ${requests} requests ${span}; judged once there are ${minRequests} (nothing seen so far is wrong)`); process.exit(3); }
  console.log(`SOAK_OK worker=${worker} version=${version} hours=${sinceDeploy ? ageH.toFixed(1) : hours} requests=${requests} failed=${bad} source=analytics`);
} catch (e) {
  console.error(`SOAK_UNKNOWN worker=${worker}: ${String(e?.message ?? e)}`);
  process.exit(2);
}
