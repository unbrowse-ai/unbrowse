#!/usr/bin/env node
// Does the candidate MCP server still accept every call that works today? People's agents and saved skills call tools
// by name with the arguments they learned; a renamed tool or a newly required argument breaks every one of them at once,
// and no test of the new server alone can see it. This compares the candidate's tool list with the one in service.
//
//   MCP_URL=https://candidate/mcp MCP_BASE_URL=https://production/mcp node mcp-compat.mjs
//   MCP_URL=https://candidate/mcp node mcp-compat.mjs --baseline .deploy/mcp-tools.json     (a saved list as the base)
//   MCP_URL=https://production/mcp node mcp-compat.mjs --save .deploy/mcp-tools.json        (write that list down)
//                                  [--allow .deploy/mcp-breaking.json] [--from-data '^(clickup|klaviyo)_']
//
// --from-data: tools whose names match come from what an environment is connected to (an app someone signed in to), not
// from the code, so a preview with a made-up world does not have production's. They are left out of the comparison and
// counted in the marker, so leaving them out is visible.
//
// Breaking: a tool gone; an argument gone; an argument that became required; a new required argument; an argument whose
// type changed; a value dropped from an argument's allowed values. New tools and new optional arguments are fine.
// A break made on purpose is declared with a reason of 15+ characters, keyed by tool or tool.argument:
//   { "old_tool": "replaced by new_tool; the brain guide and every seeded skill were updated in this release" }
// Headers: MCP_HEADERS / MCP_HEADER_CMD for the candidate, MCP_BASE_HEADERS / MCP_BASE_HEADER_CMD for the base. Each
// command runs with MCP_URL set to the server it is making headers for.
// Ends with a success-only marker:  MCP_COMPAT_OK tools=… added=… breaking=0 allowed=…     Else MCP_COMPAT_FAIL, exit 1.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const typeOf = (p) => [].concat(p?.type ?? (p?.anyOf ?? p?.oneOf ?? []).map((x) => x.type) ?? []).filter(Boolean).sort().join("|");

/** Every way `cand` refuses a call `base` accepts: [{ key: "tool" | "tool.arg", why }]. Pure. */
export function breaking(base, cand) {
  const out = [], byName = new Map(cand.map((t) => [t.name, t]));
  for (const b of base) {
    const c = byName.get(b.name);
    if (!c) { out.push({ key: b.name, why: `the tool ${b.name} is gone` }); continue; }
    const bp = b.inputSchema?.properties ?? {}, cp = c.inputSchema?.properties ?? {}, breq = new Set(b.inputSchema?.required ?? []), creq = new Set(c.inputSchema?.required ?? []);
    for (const [arg, spec] of Object.entries(bp)) {
      const key = `${b.name}.${arg}`;
      if (!(arg in cp)) { if (c.inputSchema?.additionalProperties === false || !("additionalProperties" in (c.inputSchema ?? {}))) out.push({ key, why: `${b.name} no longer takes "${arg}"` }); continue; }
      if (creq.has(arg) && !breq.has(arg)) out.push({ key, why: `${b.name} now requires "${arg}", which was optional` });
      const was = typeOf(spec), now = typeOf(cp[arg]);
      if (was && now && was !== now && !now.split("|").includes(was)) out.push({ key, why: `${b.name}."${arg}" changed type from ${was} to ${now}` });
      const lost = (spec.enum ?? []).filter((v) => cp[arg].enum && !cp[arg].enum.includes(v));
      if (lost.length) out.push({ key, why: `${b.name}."${arg}" no longer accepts ${lost.map((v) => JSON.stringify(v)).join(", ")}` });
    }
    for (const arg of creq) if (!(arg in bp)) out.push({ key: `${b.name}.${arg}`, why: `${b.name} has a new required argument "${arg}": every existing call lacks it` });
  }
  return out;
}

/** Split breaks into those declared with a real reason and those not; a declaration that matches nothing is reported too. */
export function judge(breaks, allow = {}) {
  const ok = (k) => typeof allow[k] === "string" && allow[k].trim().length >= 15;
  const allowed = breaks.filter((b) => ok(b.key) || ok(b.key.split(".")[0])), refused = breaks.filter((b) => !allowed.includes(b));
  const keys = new Set(breaks.flatMap((b) => [b.key, b.key.split(".")[0]])), stale = Object.keys(allow).filter((k) => !keys.has(k));
  return { allowed, refused, stale };
}

async function listTools(url, headers) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  const raw = await res.text();
  for (const chunk of [raw, ...raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5))]) { try { const j = JSON.parse(chunk); if (j.result?.tools) return j.result.tools; } catch { /* next */ } }
  throw new Error(`${url} listed no tools (HTTP ${res.status})`);
}
// A header command is told which server it is signing for (MCP_URL), since a credential made for one is refused by the other.
const headersFrom = (cmd, json, url) => (cmd ? JSON.parse(execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, MCP_URL: url } }).trim().split("\n").at(-1)) : JSON.parse(json || "{}"));

async function main() {
  const argv = process.argv.slice(2), arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; }, e = process.env;
  if (!e.MCP_URL || (!arg("save") && !arg("baseline") && !e.MCP_BASE_URL)) { console.error("usage: MCP_URL=<candidate>/mcp MCP_BASE_URL=<in service>/mcp node mcp-compat.mjs [--baseline file] [--save file] [--allow file]"); process.exit(2); }
  try {
    const cand = await listTools(e.MCP_URL, headersFrom(e.MCP_HEADER_CMD, e.MCP_HEADERS, e.MCP_URL));
    if (arg("save")) { // One tool per line, sorted by name and with tools that come from data left out: a change to it reads as the tools that changed.
      const data = arg("from-data") ? new RegExp(arg("from-data")) : null, kept = cand.filter((t) => !data?.test(t.name)).sort((x, y) => (x.name < y.name ? -1 : 1));
      writeFileSync(arg("save"), `[\n${kept.map(({ name, inputSchema }) => JSON.stringify({ name, inputSchema })).join(",\n")}\n]\n`); console.log(`MCP_TOOLS_SAVED tools=${kept.length} ${arg("save")}`); return; }
    const base = arg("baseline") ? JSON.parse(readFileSync(arg("baseline"), "utf8")) : await listTools(e.MCP_BASE_URL, headersFrom(e.MCP_BASE_HEADER_CMD, e.MCP_BASE_HEADERS, e.MCP_BASE_URL));
    const allow = arg("allow") && existsSync(arg("allow")) ? JSON.parse(readFileSync(arg("allow"), "utf8")) : {};
    const data = arg("from-data") ? new RegExp(arg("from-data")) : null, code = (list) => (data ? list.filter((t) => !data.test(t.name)) : list), skipped = base.length - code(base).length;
    const v = judge(breaking(code(base), code(cand)), allow), added = code(cand).filter((t) => !base.some((b) => b.name === t.name)).map((t) => t.name);
    if (added.length) console.log(`new tools (${added.length}): ${added.join(", ")}`);
    for (const b of v.allowed) console.log(`declared: ${b.why} (${allow[b.key] ?? allow[b.key.split(".")[0]]})`);
    for (const k of v.stale) console.log(`note: the declared break "${k}" matches nothing now; remove it`);
    if (v.refused.length) { console.log(`MCP_COMPAT_FAIL ${v.refused.length} call(s) that work today would stop working:\n  ${v.refused.map((b) => b.why).join("\n  ")}`); process.exit(1); }
    console.log(`MCP_COMPAT_OK tools=${cand.length} base=${base.length} added=${added.length} breaking=0 allowed=${v.allowed.length}${data ? ` from_data_not_compared=${skipped}` : ""}`);
  } catch (err) { console.log(`MCP_COMPAT_FAIL ${String(err?.message ?? err)}`); process.exit(1); }
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) await main();
