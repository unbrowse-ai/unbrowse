#!/usr/bin/env node
// The release train's gate on a deployed telemetry worker (.deploy/manifest.json). Sends what a node sends and checks
// the worker keeps it, refuses what it must, and answers the stats door only with the token.
//
//   node gate.mjs <base url>                  prints TELEMETRY_GATE_OK … or FAIL lines and exits 1
//   node gate.mjs <base url> --real-installs  also needs installs other than the gate's own (the watch after a
//                                             production deploy: release nodes are sending)
//
// The token is ADMIN_TOKEN or the file stats.mjs reads. The gate's events carry the install id of 32 f's, which every
// question in queries.sql leaves out. No bug report is filed: the relay is only sent one it must refuse.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = (process.argv[2] || "").replace(/\/$/, "");
const real = process.argv.includes("--real-installs");
if (!/^https:\/\//.test(base)) {
  console.error("usage: node gate.mjs <https base url> [--real-installs]");
  process.exit(2);
}
const file = base === "https://telemetry.unbrowse.ai" ? "telemetry-admin-token" : "telemetry-admin-token-staging";
const token = process.env.ADMIN_TOKEN || readFileSync(join(homedir(), ".config/unbrowse", file), "utf8").trim();
const GATE = "f".repeat(32);
const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
};
const call = async (path, init = {}) => {
  for (let i = 0; ; i++) {
    try {
      return await fetch(base + path, init);
    } catch (e) {
      if (i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
};
const post = (path, body) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const stat = async (name, auth = token) => {
  const r = await call(`/v1/stats/${name}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

check((await call("/")).status === 404, "/ answers 404");
check((await call("/v1/events")).status === 405, "GET /v1/events answers 405");
const bad = await post("/v1/events", { events: [{ event: "tool_call", version: "1.0.0", os: "linux", install_id: GATE, outcome: "ok", url: "https://example.com" }] });
check(bad.status === 400, `a field off the list is refused (got ${bad.status})`);
const tagOnCall = await post("/v1/events", { events: [{ event: "tool_call", version: "1.0.0", os: "linux", install_id: GATE, outcome: "ok", from: "internal" }] });
check(tagOnCall.status === 400, `a source tag on a tool call is refused (got ${tagOnCall.status})`);
const badReport = await post("/v1/reports", { kind: "nonsense" });
// Unsigned, so refused before its shape is read (401); nothing is filed either way.
check(badReport.status === 401, `an unsigned report is refused (got ${badReport.status})`);
check((await stat("installs", null)).status === 404, "the stats door is 404 with no token");
check((await stat("installs", "not-the-admin-token")).status === 404, "the stats door is 404 with a wrong token");

const before = await stat("gate");
check(before.status === 200, `the stats door answers the token (got ${before.status})`);
const sent = await post("/v1/events", {
  events: [
    { event: "tool_call", version: "0.0.0", os: "linux", install_id: GATE, tool: "unbrowse_do", outcome: "ok", duration_ms: 1 },
    // A start with its source tag, as `unbrowse start --from internal` sends it.
    { event: "node_start", version: "0.0.0", os: "linux", install_id: GATE, outcome: "ok", from: "internal" },
  ],
});
check(sent.status === 204, `a valid batch is taken (got ${sent.status})`);
const after = await stat("gate");
const n0 = before.body.rows?.[0]?.events ?? -1;
const n1 = after.body.rows?.[0]?.events ?? -1;
check(n1 === n0 + 2, `the events sent were kept, the tagged start among them (gate count ${n0} -> ${n1})`);
for (const name of ["funnel", "funnel_by_from", "arms"]) {
  const q = await stat(name);
  check(q.status === 200 && Array.isArray(q.body.rows), `the ${name} question answers (got ${q.status})`);
}

// One install by its id, as the site's /admin Journey asks it: the gate's own, which just made a good call.
const one = await stat(`install?id=${GATE}`);
const row = one.body.rows?.[0];
check(one.status === 200 && row?.install_id === GATE && row.first_good_call !== null && row.from_tag === "internal", `the install question answers the gate's install with its tag and first good call (got ${one.status} ${JSON.stringify(row ?? null)})`);
check((await stat("install?id=not-an-install")).status === 400, "the install question refuses an id off its shape");

let installs = 0;
const inst = await stat("installs");
check(inst.status === 200, `the installs question answers (got ${inst.status})`);
installs = (inst.body.rows || []).reduce((s, r) => s + r.installs, 0);
if (real) check(installs > 0, "release nodes are sending: some install other than the gate's has an event");

if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log(`TELEMETRY_GATE_OK url=${base} kept=+2 from=ok install=ok installs=${installs}${real ? " real=yes" : ""}`);
