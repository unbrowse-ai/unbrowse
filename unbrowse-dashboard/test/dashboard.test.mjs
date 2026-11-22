import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { recordFromRun } from "../collect/collect.mjs";
import { metricsFrom, parseBankReads, parseCoverage, parseHardSites, parseQa, parseResultsCost, parseVerdict } from "../collect/parse.mjs";
import { handleApi } from "../src/lib/api.mjs";
import { checkRecord } from "../src/lib/record.mjs";
import { sign, verify } from "../src/lib/sign.mjs";
import { fakeD1 } from "./d1.mjs";

const fx = (f) => readFileSync(new URL(`fixtures/${f}`, import.meta.url), "utf8");
const KEY = "test-key";

test("a slice verdict reads as its counts", () => {
  assert.deepEqual(parseVerdict(fx("slice-verdict.md")), { right: 7, aside: 1, wrong: 1, fail: 0, error: 0, tasks: 9 });
});

test("a full verdict reads as its counts", () => {
  assert.deepEqual(parseVerdict(fx("full-verdict.md")), { right: 59, aside: 10, wrong: 0, fail: 10, error: 12, tasks: 91 });
});

test("text with no verdict line gives nothing, not zeros", () => {
  assert.equal(parseVerdict("PROMOTION_REFUSED"), null);
  assert.equal(parseResultsCost("not json\n\n"), undefined);
  assert.deepEqual(parseBankReads("nothing here"), {});
  assert.deepEqual(parseCoverage("{"), {});
  assert.deepEqual(parseQa("{", ""), {});
});

test("a bank run's cost is the client's and the judge's", () => {
  assert.equal(parseResultsCost(fx("slice-results.jsonl.txt")), 0.2782);
});

test("QA reads as pass, checks and cost", () => {
  assert.deepEqual(parseQa(fx("qa-verdict.json"), fx("qa-cost.json")), { qa_pass: 1, qa_checks_total: 13, qa_checks_pass: 13, cost_usd: 0.5303 });
});

test("the live-site bank and coverage read", () => {
  assert.deepEqual(parseBankReads(fx("bank-reads.md")), { bank_pass: 5, bank_total: 13 });
  assert.deepEqual(parseCoverage(fx("coverage-summary.json")), { coverage_pct: 81.12, coverage_covered: 176870, coverage_total: 218044 });
});

test("the hard-site report reads as counts and sites", () => {
  const { metrics, sites } = parseHardSites(fx("hard-sites.json"));
  assert.deepEqual(metrics, { hard_right: 0, hard_wrong: 8, hard_browser: 6, hard_walled: 16, hard_unknown: 0 });
  assert.deepEqual(sites[1], { site: "g2.com", label: "wrong", seconds: 164 });
});

test("a workflow's artifacts become metrics under the right scope", () => {
  const gb = metricsFrom("Gate bank", {
    "gate-bank-full-abc/verdict.md": fx("full-verdict.md"),
    "gate-bank-full-abc/results.jsonl": fx("slice-results.jsonl.txt"),
  });
  assert.equal(gb.metrics.full_right, 59);
  assert.equal(gb.metrics.slice_right, undefined);
  assert.equal(gb.metrics.cost_usd, 0.2782);
  assert.deepEqual(metricsFrom("CI", { "x/verdict.md": fx("slice-verdict.md") }), { metrics: {}, sites: [] });
  const bank = metricsFrom("Bank", { "hard-sites-report/hard-sites.json": fx("hard-sites.json"), "bank/_temp/reads.md": fx("bank-reads.md") });
  assert.equal(bank.metrics.bank_pass, 5);
  assert.equal(bank.sites.length, 3);
});

const run = {
  id: 44729682568,
  run_attempt: 1,
  name: "QA",
  head_branch: "staging",
  head_sha: "337ba4b8d1539d4a89691f83ffcfa1dd7cb66c0e",
  event: "push",
  conclusion: "success",
  run_started_at: "2026-11-20T11:41:44Z",
  updated_at: "2026-11-20T11:52:35Z",
};

test("a run becomes a record the Worker accepts, with its wall-clock", () => {
  const { record, error } = checkRecord(recordFromRun(run, { "qa-report/qa-verdict.json": fx("qa-verdict.json") }));
  assert.equal(error, undefined);
  assert.equal(record.wall_s, 651);
  assert.equal(record.metrics.qa_checks_pass, 13);
});

test("a record with junk is refused", () => {
  const ok = recordFromRun(run, {});
  assert.equal(checkRecord({ ...ok, sha: "not a sha" }).error, "sha");
  assert.equal(checkRecord({ ...ok, metrics: { made_up: 1 } }).error, "metric made_up");
  assert.equal(checkRecord({ ...ok, metrics: { cost_usd: "1" } }).error, "metric cost_usd");
  assert.equal(checkRecord({ ...ok, conclusion: "great" }).error, "conclusion");
  assert.equal(checkRecord({ ...ok, sites: [{ site: "x.com", label: "fine" }] }).error, "site label");
});

test("a signature checks out only with the key, the body and a fresh time", async () => {
  const now = 1_800_000_000;
  const s = await sign(KEY, "{}", now);
  assert.equal(await verify(KEY, "{}", s.time, s.signature, now), null);
  assert.equal(await verify("other", "{}", s.time, s.signature, now), "bad signature");
  assert.equal(await verify(KEY, "{ }", s.time, s.signature, now), "bad signature");
  assert.equal(await verify(KEY, "{}", s.time, s.signature, now + 601), "stale");
  assert.equal(await verify(KEY, "{}", null, null, now), "unsigned");
  assert.equal(await verify("", "{}", s.time, s.signature, now), "no key configured");
});

async function post(env, body, key = KEY) {
  const text = JSON.stringify(body);
  const { time, signature } = await sign(key, text);
  return handleApi(new Request("https://d/api/ingest", { method: "POST", body: text, headers: { "x-dashboard-time": time, "x-dashboard-signature": signature } }), env);
}
const get = (env, path) => handleApi(new Request(`https://d${path}`), env);

test("the ingest door keeps a signed run, refuses the rest, and the read door shows it", async () => {
  const env = { DB: fakeD1(), INGEST_KEY: KEY };
  const rec = recordFromRun(run, { "qa-report/qa-verdict.json": fx("qa-verdict.json"), "qa-report/qa-cost.json": fx("qa-cost.json") });
  assert.equal((await post(env, rec, "wrong-key")).status, 401);
  assert.equal((await handleApi(new Request("https://d/api/ingest", { method: "POST", body: "{}" }), env)).status, 401);
  assert.equal((await post(env, { ...rec, sha: "zz" })).status, 400);
  assert.equal((await get(env, "/api/runs")).status, 200);
  assert.deepEqual(await (await get(env, "/api/runs")).json(), { runs: [] });
  assert.equal((await post(env, rec)).status, 200);
  assert.equal((await post(env, rec)).status, 200); // a repeat is the same row
  const { runs } = await (await get(env, "/api/runs?branch=staging&days=365")).json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].metrics.cost_usd, 0.5303);
  assert.deepEqual((await (await get(env, "/api/runs?branch=main&days=365")).json()).runs, []);
  assert.equal((await (await get(env, "/healthz")).json()).runs, 1);
});

test("an older attempt never overwrites a newer one, and hard sites are kept per run", async () => {
  const env = { DB: fakeD1(), INGEST_KEY: KEY };
  const bank = { ...run, id: 7, name: "Bank", run_attempt: 2 };
  const rec = recordFromRun(bank, { "hard-sites-report/hard-sites.json": fx("hard-sites.json") });
  assert.equal((await post(env, rec)).status, 200);
  assert.equal((await post(env, { ...rec, attempt: 1, conclusion: "failure", sites: [] })).status, 200);
  const [row] = (await (await get(env, "/api/runs?days=365")).json()).runs;
  assert.equal(row.conclusion, "success");
  const { sites } = await (await get(env, "/api/sites?run=7")).json();
  assert.equal(sites.length, 3);
  assert.equal((await get(env, "/api/sites?run=x")).status, 400);
  assert.equal(await get(env, "/nope"), null);
});

test("the deploy gate's made-up runs show only when asked for by branch, and go a day later", async () => {
  const env = { DB: fakeD1(), INGEST_KEY: KEY };
  const gate = { ...recordFromRun({ ...run, id: 9, head_branch: "gate-x" }, {}) };
  assert.equal((await post(env, gate)).status, 200);
  assert.equal((await post(env, recordFromRun(run, {}))).status, 200);
  assert.deepEqual((await (await get(env, "/api/runs?branch=all&days=365")).json()).runs.map((r) => r.run_id), [run.id]);
  assert.equal((await (await get(env, "/api/runs?branch=gate-x&days=365")).json()).runs.length, 1);
  assert.equal((await (await get(env, "/api/runs?branch=no%20spaces&days=365")).json()).runs[0].branch, "staging");
  const { saveRun } = await import("../src/lib/db.mjs");
  const { record } = checkRecord({ ...gate, run_id: 10, branch: "gate-y" });
  await saveRun(env.DB, record, new Date(Date.now() + 2 * 86400_000).toISOString());
  assert.equal((await (await get(env, "/api/runs?branch=gate-x&days=365")).json()).runs.length, 0);
});
