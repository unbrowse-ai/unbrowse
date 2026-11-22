#!/usr/bin/env node
// The deployed dashboard, end to end: it answers, refuses unsigned, wrongly signed and stale posts, keeps a signed
// made-up run, serves it back, and a real browser reads that run's number off the page at phone and desktop width
// with nothing wider than the screen.
//
//   node unbrowse-dashboard/gate.mjs <url> [--no-browser]
//
// The key: DASHBOARD_INGEST_KEY, else the 0600 file DASHBOARD_KEY_FILE (default ~/.config/unbrowse-dashboard/staging-ingest.key).
// Made-up runs go on a gate-* branch, which no view shows and which the Worker drops a day later.
// Marker: DASHBOARD_GATE_OK checks=… browser=phone,desktop

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { sign } from "./src/lib/sign.mjs";

const base = process.argv[2];
const browser = !process.argv.includes("--no-browser");
if (!base) throw new Error("usage: gate.mjs <url>");
const key = process.env.DASHBOARD_INGEST_KEY || readFileSync(process.env.DASHBOARD_KEY_FILE || `${homedir()}/.config/unbrowse-dashboard/staging-ingest.key`, "utf8").trim();

let checks = 0;
const fail = (why) => {
  console.log(`DASHBOARD_GATE_FAIL ${why}`);
  process.exit(1);
};
const check = (ok, why) => {
  if (!ok) fail(why);
  checks++;
};

const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const branch = `gate-${tag}`;
const pass = 1 + Math.floor(Math.random() * 11); // a number no real run is likely to show: pass/13 on a gate branch
const now = new Date();
const record = {
  run_id: 9_000_000_000_000 + Math.floor(Math.random() * 1e9),
  attempt: 1,
  workflow: "QA",
  branch,
  sha: "0".repeat(40),
  event: "workflow_dispatch",
  conclusion: "failure",
  started_at: new Date(now - 600_000).toISOString(),
  finished_at: now.toISOString(),
  metrics: { qa_pass: 0, qa_checks_pass: pass, qa_checks_total: 13, cost_usd: 0.01 },
  sites: [],
};
const body = JSON.stringify(record);
const ingest = (headers, b = body) => fetch(new URL("/api/ingest", base), { method: "POST", body: b, headers: { "content-type": "application/json", ...headers } });

const health = await fetch(new URL("/healthz", base));
check(health.ok && (await health.json()).ok === true, `healthz answered ${health.status}`);

check((await ingest({})).status === 401, "an unsigned post was not refused");
const good = await sign(key, body);
check((await ingest({ "x-dashboard-time": good.time, "x-dashboard-signature": good.signature.replace(/.$/, (c) => (c === "0" ? "1" : "0")) })).status === 401, "a wrongly signed post was not refused");
const old = await sign(key, body, Math.floor(Date.now() / 1000) - 3600);
check((await ingest({ "x-dashboard-time": old.time, "x-dashboard-signature": old.signature })).status === 401, "a stale post was not refused");
const junk = JSON.stringify({ ...record, sha: "nope" });
const junkSig = await sign(key, junk);
check((await ingest({ "x-dashboard-time": junkSig.time, "x-dashboard-signature": junkSig.signature }, junk)).status === 400, "a malformed run was not refused");

const kept = await ingest({ "x-dashboard-time": good.time, "x-dashboard-signature": good.signature });
check(kept.status === 200, `a signed run was not kept: ${kept.status} ${await kept.text()}`);

const { runs } = await (await fetch(new URL(`/api/runs?branch=${branch}`, base))).json();
check(runs.length === 1 && runs[0].run_id === record.run_id && runs[0].metrics.qa_checks_pass === pass, "the kept run did not come back");
const all = await (await fetch(new URL("/api/runs?branch=all&days=2", base))).json();
check(!all.runs.some((r) => r.branch.startsWith("gate-")), "a gate run shows in the all view");

const page = await fetch(new URL(`/?branch=${branch}`, base));
const html = await page.text();
check(page.ok && html.includes(`${pass}/13`), "the page does not show the run's number in its HTML");

const widths = [];
if (browser) {
  const session = `dash-gate-${tag}`;
  const ab = (...a) => execFileSync("agent-browser", ["--session", session, ...a], { encoding: "utf8", timeout: 60_000 });
  try {
    ab("open", new URL(`/?branch=${branch}`, base).href);
    for (const [name, w, h] of [["phone", 390, 844], ["desktop", 1440, 1000]]) {
      ab("set", "viewport", String(w), String(h));
      ab("wait", "1500");
      const out = ab(
        "eval",
        `JSON.stringify({ text: document.body.innerText.includes("${pass}/13"), overflow: document.documentElement.scrollWidth - window.innerWidth, svg: document.querySelectorAll(".chart svg").length, rows: document.querySelectorAll("tbody tr").length, tall: [...document.querySelectorAll("td")].filter((td) => td.getBoundingClientRect().height > 40).length })`,
      );
      const r = JSON.parse(JSON.parse(out.trim().split("\n").pop()));
      check(r.text, `${name}: the page does not show ${pass}/13`);
      check(r.overflow <= 0, `${name}: the page is ${r.overflow}px wider than the screen`);
      check(r.svg >= 1 && r.rows === 1, `${name}: ${r.svg} charts and ${r.rows} table rows`);
      check(r.tall === 0, `${name}: ${r.tall} table cells wrap`);
      widths.push(name);
    }
  } finally {
    try {
      ab("close");
    } catch {}
  }
}

console.log(`DASHBOARD_GATE_OK checks=${checks} run=${record.run_id} browser=${widths.join(",") || "skipped"}`);
