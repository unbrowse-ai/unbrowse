#!/usr/bin/env node
// Which tools of a deployed MCP server does anything test? For each tool the server lists: is it named in a unit test,
// and did a simulated person call it? A tool in neither is untested behaviour a person can reach.
//
//   MCP_URL=https://…/mcp node mcp-coverage.mjs --tests worker/test [--tests more/tests] [--sim-runs .deploy/.sim-runs]
//                                               [--min-unit 0.9] [--waive .deploy/mcp-waivers.json] [--json out.json]
//
// --tests: directories (or files) whose test sources are read; a tool counts when its name appears there in quotes.
// --sim-runs: the records sim.mjs writes; a tool counts when a simulated person called it.
// --waive: {"tool_name": "why it has no test"} for tools that cannot be tested here (a reason of 15+ characters).
// --min-unit: the share of tools a unit test must name (set it from a measured number; default 0: report only).
// Headers as mcp-audit.mjs: MCP_HEADERS, or MCP_HEADER_CMD run before the request.
// Ends with:  MCP_COVERAGE_OK tools=… unit=… user=… untested=… waived=…    Below the floor or untested without a
// waiver (with --strict): MCP_COVERAGE_FAIL, exit 1.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const all = (name) => process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]] : []));
const arg = (name, dflt) => all(name)[0] ?? dflt;
const flag = (name) => process.argv.includes(`--${name}`);

/** Every test source under the given files and directories, as one text. */
export function sources(paths, exts = /\.(ts|tsx|js|mjs|cjs|py)$/) {
  let text = "";
  const walk = (p) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) { for (const f of readdirSync(p)) if (f !== "node_modules" && !f.startsWith(".")) walk(join(p, f)); }
    else if (exts.test(p)) text += `\n${readFileSync(p, "utf8")}`;
  };
  for (const p of paths) walk(p);
  return text;
}

/** For each tool: named in the tests, called by a simulated person, waived, or untested. Pure. */
export function report(tools, testText, simCalls = [], waivers = {}) {
  const called = new Set(simCalls), rows = [];
  for (const t of tools) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const unit = new RegExp(`["'\`]${esc}["'\`]`).test(testText), user = called.has(t);
    const why = typeof waivers[t] === "string" && waivers[t].trim().length >= 15 ? waivers[t] : "";
    rows.push({ tool: t, unit, user, waived: !unit && !user && !!why });
  }
  const untested = rows.filter((r) => !r.unit && !r.user && !r.waived).map((r) => r.tool);
  return { rows, untested, unit: rows.filter((r) => r.unit).length, user: rows.filter((r) => r.user).length, waived: rows.filter((r) => r.waived).length };
}

async function main() {
  const url = process.env.MCP_URL ?? arg("url");
  if (!url || !all("tests").length) { console.error("usage: MCP_URL=https://…/mcp node mcp-coverage.mjs --tests <dir> [--sim-runs dir] [--min-unit 0.9] [--waive file] [--strict]"); process.exit(2); }
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(process.env.MCP_HEADER_CMD ? JSON.parse(execSync(process.env.MCP_HEADER_CMD, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").at(-1)) : JSON.parse(process.env.MCP_HEADERS || "{}")) };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  const raw = await res.text();
  let tools = [];
  for (const chunk of [raw, ...raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5))]) { try { const j = JSON.parse(chunk); if (j.result?.tools) { tools = j.result.tools.map((t) => t.name); break; } } catch { /* next */ } }
  if (!tools.length) { console.log(`MCP_COVERAGE_FAIL the server listed no tools (HTTP ${res.status})`); process.exit(1); }
  const runs = arg("sim-runs"), simCalls = runs && existsSync(runs) ? readdirSync(runs).filter((f) => f.endsWith(".json")).flatMap((f) => { try { return JSON.parse(readFileSync(join(runs, f), "utf8")).called ?? []; } catch { return []; } }) : [];
  const waivers = arg("waive") && existsSync(arg("waive")) ? JSON.parse(readFileSync(arg("waive"), "utf8")) : {};
  const r = report(tools, sources(all("tests")), simCalls, waivers), min = Number(arg("min-unit", "0")), share = r.unit / tools.length;
  if (r.untested.length) console.log(`untested (${r.untested.length}): ${r.untested.join(", ")}`);
  const onlyUser = r.rows.filter((x) => !x.unit && x.user).map((x) => x.tool);
  if (onlyUser.length) console.log(`no unit test, but a simulated person called them (${onlyUser.length}): ${onlyUser.join(", ")}`);
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify(r, null, 2));
  const line = `tools=${tools.length} unit=${r.unit} user=${r.user} untested=${r.untested.length} waived=${r.waived} unit_share=${share.toFixed(3)}`;
  if (share < min) { console.log(`MCP_COVERAGE_FAIL ${line}: unit tests name ${(share * 100).toFixed(1)}% of the tools, the floor is ${(min * 100).toFixed(1)}%`); process.exit(1); }
  if (flag("strict") && r.untested.length) { console.log(`MCP_COVERAGE_FAIL ${line}: ${r.untested.length} tool(s) nothing tests and nobody waived`); process.exit(1); }
  console.log(`MCP_COVERAGE_OK ${line}`);
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) await main();
