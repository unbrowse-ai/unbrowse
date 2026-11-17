#!/usr/bin/env node
// End-to-end check of HTTP routes and pages on a deployed Worker: each route answers as expected for a signed-in
// caller, shows what it should, shows nothing it should not, and refuses a caller with no credentials.
//
//   BASE_URL=https://…  node http-smoke.mjs --routes .deploy/routes.json [--header-cmd 'bun scripts/headers.ts']
//
// routes.json: [{ "name": "Docs page", "path": "/console/docs", "method": "GET", "as": "owner",
//                 "expect": { "status": 200, "contains": ["Saved knowledge"], "absent": ["Something went wrong"],
//                             "maxMs": 8000, "headers": { "content-type": "text/html" } },
//                 "anon": { "status": [302, 401, 403], "absent": ["Saved knowledge"] } }]
// `status` may be one number or a list. `anon` is the same request with no credentials; leave it out only for a route
// that is public on purpose ("public": true), so a forgotten auth check is never the default. A route that is itself
// the no-credentials case (an API that must answer 401) says "credentials": false and "public": true.
// Credentials: HTTP_HEADERS='{"authorization":"Bearer …"}', or --header-cmd / HTTP_HEADER_CMD, a command that prints a
// JSON object of headers and is run before every request with SMOKE_AS=<the route's "as"> (single-use credentials).
// Ends with a success-only marker:  HTTP_SMOKE_OK routes=… anon=…   Any failed check: HTTP_SMOKE_FAIL, exit 1.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };

/** Why an answer does not meet an expectation ("" when it does). Pure, so it is tested without a server. */
export function mismatch(expect = {}, got) {
  const want = [].concat(expect.status ?? 200);
  if (!want.includes(got.status)) return `HTTP ${got.status}, expected ${want.join(" or ")}`;
  for (const c of [].concat(expect.contains ?? [])) if (!got.text.includes(c)) return `does not show ${JSON.stringify(c)}`;
  for (const c of [].concat(expect.absent ?? [])) if (got.text.includes(c)) return `shows ${JSON.stringify(c)}`;
  for (const [k, v] of Object.entries(expect.headers ?? {})) if (!new RegExp(v, "i").test(got.headers?.[k.toLowerCase()] ?? "")) return `header ${k} is ${JSON.stringify(got.headers?.[k.toLowerCase()] ?? "")}, expected ${v}`;
  if (expect.maxMs && got.ms > expect.maxMs) return `took ${got.ms} ms (limit ${expect.maxMs})`;
  return "";
}

/** What is wrong with a routes file before any request is made. */
export function routeProblems(routes) {
  const out = [];
  if (!Array.isArray(routes) || !routes.length) return ["no routes"];
  for (const [i, r] of routes.entries()) {
    const id = r?.name ?? `route ${i}`;
    if (!r?.name) out.push(`${id}: name`);
    if (!String(r?.path ?? "").startsWith("/")) out.push(`${id}: path must start with /`);
    if (!r?.expect) out.push(`${id}: expect`);
    if (!r?.public && !r?.anon) out.push(`${id}: say what a caller with no credentials gets ("anon"), or mark the route "public": true`);
  }
  return out;
}

async function main() {
  const base = (process.env.BASE_URL ?? arg("base", "")).replace(/\/+$/, "");
  if (!base || !arg("routes")) { console.error("usage: BASE_URL=https://… node http-smoke.mjs --routes routes.json [--header-cmd '…']"); process.exit(2); }
  const routes = JSON.parse(readFileSync(arg("routes"), "utf8")), headerCmd = arg("header-cmd", process.env.HTTP_HEADER_CMD);
  const bad = routeProblems(routes);
  if (bad.length) { console.log(`HTTP_SMOKE_FAIL the routes file is not sound:\n  ${bad.join("\n  ")}`); process.exit(1); }
  const headersFor = (as) => ({ ...JSON.parse(process.env.HTTP_HEADERS || "{}"),
    ...(headerCmd ? JSON.parse(execSync(headerCmd, { encoding: "utf8", env: { ...process.env, SMOKE_AS: as ?? "", BASE_URL: base }, stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").at(-1)) : {}) });
  const ask = async (r, headers) => {
    const t0 = Date.now();
    const res = await fetch(base + r.path, { method: r.method ?? "GET", headers: { ...(r.body ? { "content-type": "application/json" } : {}), ...headers }, body: r.body ? JSON.stringify(r.body) : undefined, redirect: "manual" });
    return { status: res.status, text: await res.text(), headers: Object.fromEntries(res.headers), ms: Date.now() - t0 };
  };
  let failed = 0, anon = 0;
  for (const r of routes) {
    let why = "";
    try { why = mismatch(r.expect, await ask(r, r.credentials === false ? {} : headersFor(r.as))); } catch (e) { why = `no answer: ${e.message}`; }
    if (!why && r.anon) { anon++; try { const w = mismatch(r.anon, await ask(r, {})); if (w) why = `with no credentials: ${w}`; } catch (e) { why = `with no credentials: no answer: ${e.message}`; } }
    console.log(`${why ? "FAIL" : "ok  "} ${r.name} (${r.method ?? "GET"} ${r.path}${r.as ? ` as ${r.as}` : ""})${why ? `: ${why}` : ""}`);
    if (why) failed++;
  }
  if (failed) { console.log(`HTTP_SMOKE_FAIL ${failed} of ${routes.length}`); process.exit(1); }
  console.log(`HTTP_SMOKE_OK routes=${routes.length} anon=${anon}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) await main();
