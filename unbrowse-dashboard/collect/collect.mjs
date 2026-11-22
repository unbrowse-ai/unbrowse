#!/usr/bin/env node
// Collect CI runs' numbers and post them, signed, to the dashboard.
//
//   node collect.mjs run <run-id> [--conclusion <c>] [--in-progress] [--soft] [--post <url>] [--dry]
//   node collect.mjs backfill --since <date> [--branches staging,main] [--also <id,id>] [--post <url>] [--dry]
//
// Needs `gh` signed in (GH_TOKEN in CI) and DASHBOARD_INGEST_KEY to post. --in-progress is for a workflow's own last
// job: the run has not ended, so the end is now and the conclusion is given. --soft never fails the caller (a
// workflow's job must not go red because the dashboard is down): it prints a warning instead.
// Markers: DASHBOARD_POST_OK run=… metrics=… sites=…   DASHBOARD_BACKFILL_OK runs=… posted=… metrics=… failed=0

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkRecord } from "../src/lib/record.mjs";
import { sign } from "../src/lib/sign.mjs";
import { ARTIFACTS, WORKFLOWS, metricsFrom } from "./parse.mjs";

const REPO = process.env.GITHUB_REPOSITORY || "unbrowse-ai/unbrowse-core";
const TRUSTED_EVENTS = new Set(["push", "schedule", "workflow_dispatch"]);

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (["--in-progress", "--soft", "--dry"].includes(a)) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const ghJson = (path) => JSON.parse(gh("api", path));

function readTree(dir, prefix) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(md|json|jsonl)$/.test(name) && st.size < 8 << 20) files[`${prefix}/${relative(dir, p)}`] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return files;
}

// The artifacts of a run that hold numbers, read into memory. Expired ones are skipped.
function artifactFiles(runId, workflow) {
  const wanted = ARTIFACTS[workflow];
  if (!wanted) return {};
  const list = ghJson(`repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`).artifacts ?? [];
  const tmp = mkdtempSync(join(tmpdir(), "dash-"));
  try {
    let files = {};
    for (const a of list) {
      if (a.expired || !wanted.some((re) => re.test(a.name))) continue;
      const dir = join(tmp, String(a.id));
      gh("run", "download", String(runId), "-R", REPO, "-n", a.name, "-D", dir);
      files = { ...files, ...readTree(dir, a.name) };
    }
    return files;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function recordFromRun(run, files, opts = {}) {
  const { metrics, sites } = metricsFrom(run.name, files);
  return {
    run_id: run.id,
    attempt: run.run_attempt,
    workflow: run.name,
    branch: run.head_branch,
    sha: run.head_sha,
    event: run.event,
    conclusion: opts.conclusion || run.conclusion,
    started_at: run.run_started_at || run.created_at,
    finished_at: opts.inProgress ? new Date().toISOString() : run.updated_at,
    metrics,
    sites,
  };
}

async function post(url, record) {
  const key = process.env.DASHBOARD_INGEST_KEY;
  if (!key) throw new Error("DASHBOARD_INGEST_KEY is not set");
  const body = JSON.stringify(record);
  const { time, signature } = await sign(key, body);
  const res = await fetch(new URL("/api/ingest", url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-dashboard-time": time, "x-dashboard-signature": signature },
    body,
  });
  if (!res.ok) throw new Error(`ingest answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function one(runId, a) {
  const run = ghJson(`repos/${REPO}/actions/runs/${runId}`);
  const rec = recordFromRun(run, artifactFiles(runId, run.name), { conclusion: a.conclusion, inProgress: a["in-progress"] });
  const { record, error } = checkRecord(rec);
  if (error) throw new Error(`run ${runId}: ${error}`);
  if (a.dry) console.log(JSON.stringify(record));
  else await post(a.post, record);
  return record;
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  a.post ||= process.env.DASHBOARD_URL;
  if (!a.dry && !a.post) throw new Error("give --post <url> or DASHBOARD_URL");
  if (cmd === "run") {
    const r = await one(Number(a._[1]), a);
    console.log(`DASHBOARD_POST_OK run=${r.run_id} workflow=${JSON.stringify(r.workflow)} metrics=${Object.keys(r.metrics).length} sites=${r.sites.length}`);
    return;
  }
  if (cmd === "backfill") {
    if (!a.since) throw new Error("give --since <date>");
    const branches = (a.branches || "staging,main").split(",");
    const ids = new Set((a.also || "").split(",").filter(Boolean).map(Number));
    for (const branch of branches) {
      for (let page = 1; ; page++) {
        const runs = ghJson(`repos/${REPO}/actions/runs?branch=${encodeURIComponent(branch)}&created=%3E%3D${a.since}&per_page=100&page=${page}`).workflow_runs ?? [];
        for (const r of runs) {
          if (WORKFLOWS.includes(r.name) && TRUSTED_EVENTS.has(r.event) && r.status === "completed") ids.add(r.id);
        }
        if (runs.length < 100) break;
      }
    }
    let posted = 0;
    let metrics = 0;
    const failed = [];
    for (const id of [...ids].sort()) {
      try {
        const r = await one(id, a);
        posted++;
        metrics += Object.keys(r.metrics).length;
      } catch (e) {
        failed.push(id);
        console.error(`run ${id}: ${e.message}`);
      }
    }
    const line = `runs=${ids.size} posted=${posted} metrics=${metrics} failed=${failed.length}`;
    if (failed.length) throw new Error(`DASHBOARD_BACKFILL_FAIL ${line} ids=${failed.join(",")}`);
    console.log(`DASHBOARD_BACKFILL_OK ${line}`);
    return;
  }
  throw new Error("usage: collect.mjs run <run-id> | backfill --since <date>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    if (process.argv.includes("--soft")) {
      console.log(`::warning title=dashboard::numbers not posted: ${e.message}`);
      process.exit(0);
    }
    console.error(e.message);
    process.exit(1);
  });
}
