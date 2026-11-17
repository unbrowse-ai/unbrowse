#!/usr/bin/env node
// User testing by simulation: an agent plays a person with a goal in plain words, acts on the deployed thing through
// its MCP server, and deterministic oracles decide whether the goal was met. The agent's own report never counts.
//
//   node sim.mjs run        [--only <name>] [--json out.json] [--keep]   every scenario in the manifest's sims.dir
//                                                                  (--keep: leave the made-up world up afterwards)
//   node sim.mjs validate                                          scenarios parse and obey the rules (no network)
//   node sim.mjs fabricate  [--count 3] [--focus "…"]              an agent writes new scenarios; each is proved on
//                                                                  the target before it is kept
//   node sim.mjs fabricate --from-spec                             a vibestack project: one scenario per story of its
//                                                                  spec (the project's `spec train`, vibestack.mjs)
//
// A web surface (no sims.target): the agent acts through the browser MCP of sims.agent.servers on the address in its
// task ({DEPLOY_URL_<WORKER>}, filled from the gate's environment), and its oracles are commands.
//
// The agent is headless Claude Code on the machine's own login (a subscription), or CLAUDE_CODE_OAUTH_TOKEN in CI. API
// keys are taken out of its environment, and a run that still used one fails unless sims.agent.allowApiKey is true.
// It starts with no user settings, hooks, skills or built-in tools: only the target's MCP tools, behind a local proxy
// that adds the persona's credentials to every request and records each tool it called.
//
// What makes a scenario count (enforced, not advised):
//   - the task is in the person's words and names no tool;
//   - an oracle only reads (sims.readOnly), and must NOT hold before the agent acts, so it can fail;
//   - a `forbidden` oracle must hold neither before nor after (a write that should have been refused), and the
//     agent's answer must contain nothing listed in `mustNotSay` (what the product must never show this person);
//   - sims never run against production.
// A scenario with `steps` is a journey: each step its own person and fresh agent, one shared {run}, stopping at the
// first step that fails. A step that only finds something out may be judged by `mustSay` (text only the product holds).
// Ends with a success-only marker:  SIM_OK sims=… oracles=… agent=subscription   Any failure: SIM_FAIL, exit 1.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { train } from "./vibestack.mjs";

const READ_ONLY = "^(read_|list_|get_|search_|query_|find_|describe_|recall$|whoami$|doc_history$|audit_log$|memory_status$|status$|health)";
const KINDS = ["contains", "absent", "matches", "error"];

/** `$NAME` and `${NAME}` from the environment; an unset one is an error rather than an empty address. */
export function expandEnv(text, env = process.env) {
  return String(text).replace(/\$\{?([A-Z][A-Z0-9_]*)\}?/g, (_, k) => {
    if (env[k] === undefined || env[k] === "") throw new Error(`${k} is not set`);
    return env[k];
  });
}

/** The addresses deploy.mjs gives a gate (DEPLOY_URL_<WORKER>), as values a task may name: {DEPLOY_URL_APP}. */
export const deployUrls = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k, v]) => /^DEPLOY_URL_[A-Z0-9_]+$/.test(k) && v));

/** Every string in a value with {run} filled in: one id per run, so a scenario can be run again on the same target. */
export function fill(value, vars) {
  if (typeof value === "string") return value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

/** Whether a tool's answer meets an expectation. `error: true` expects a refusal; otherwise an error never passes. */
export function holds(expect = {}, answer) {
  const text = String(answer?.text ?? "");
  if (expect.error === true) { if (!answer?.error) return false; } else if (answer?.error) return false;
  for (const c of [].concat(expect.contains ?? [])) if (!text.includes(c)) return false;
  for (const c of [].concat(expect.absent ?? [])) if (text.includes(c)) return false;
  if (expect.matches && !new RegExp(expect.matches, "s").test(text)) return false;
  return true;
}

/**
 * What is wrong with a scenario, as a list of plain sentences (empty when it is sound). `tools` is the target's tool
 * list when known: with it, a task that names a tool and an oracle that could write are caught.
 */
export function problems(s, { personas = {}, readOnly = READ_ONLY, tools = [], web = false } = {}) {
  // A journey: several steps in order, each its own person and fresh agent, each step sound by the same rules.
  if (s && typeof s === "object" && Array.isArray(s.steps)) {
    const top = [];
    if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(s.name ?? "")) top.push("name: lower-case letters, digits and dashes (3-61)");
    if (!s.surface) top.push("surface: which surface of the manifest this exercises");
    if (!s.steps.length) top.push("steps: at least one");
    return [...top, ...s.steps.flatMap((st, i) => problems({ ...st, name: s.name, surface: s.surface, steps: undefined }, { personas, readOnly, tools, web })
      .map((m) => `step ${i + 1}${st?.name ? ` '${st.name}'` : ""}: ${m}`))];
  }
  const out = [], ro = new RegExp(readOnly);
  const known = (id) => id in personas || id === s?.persona?.id;
  if (!s || typeof s !== "object") return ["not an object"];
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(s.name ?? "")) out.push("name: lower-case letters, digits and dashes (3-61)");
  if (!s.surface) out.push("surface: which surface of the manifest this exercises");
  if (!s.persona?.id) out.push("persona.id: who the agent plays");
  else if (!(s.persona.id in personas) && !s.persona.about) out.push(`persona '${s.persona.id}' is not in sims.personas and has no 'about'`);
  if (typeof s.task !== "string" || s.task.trim().length < 20) out.push("task: the person's goal in their own words (20+ characters)");
  for (const t of tools) if (t.length >= 5 && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(s.task ?? "")) out.push(`task names the tool '${t}': say what the person wants, not how`);
  if ((!Array.isArray(s.oracles) || !s.oracles.length) && ![].concat(s.mustSay ?? []).length) out.push("oracles: at least one check that decides whether the goal was met (or mustSay, for a step that only finds something out)");
  const each = (list, what) => {
    for (const [i, o] of (list ?? []).entries()) {
      const id = `${what}[${i}]${o?.name ? ` '${o.name}'` : ""}`;
      if (!o?.name) out.push(`${id}: name`);
      if (!o?.tool && !o?.cmd) out.push(`${id}: a tool to call or a cmd to run`);
      if (o?.tool && web) out.push(`${id}: a web surface has no MCP tools to call: check with a cmd and a marker`);
      if (o?.tool && what !== "setup" && !ro.test(o.tool)) out.push(`${id}: '${o.tool}' is not a read-only tool, so checking would change what it checks`);
      if (o?.tool && tools.length && !tools.includes(o.tool)) out.push(`${id}: the target has no tool '${o.tool}'`);
      if (o?.tool && !known(o.as ?? "")) out.push(`${id}: 'as' must be a persona (${[...new Set([s?.persona?.id, ...Object.keys(personas)])].filter(Boolean).join(", ")})`);
      if (what !== "setup") {
        const e = o?.expect ?? {};
        if (o?.cmd ? !o.marker : !KINDS.some((k) => e[k] !== undefined && (!Array.isArray(e[k]) || e[k].length))) out.push(`${id}: expect something (${KINDS.join(", ")}), or a marker for a cmd`);
        if (e.matches) { try { new RegExp(e.matches); } catch { out.push(`${id}: 'matches' is not a regular expression`); } }
      }
    }
  };
  each(s.setup, "setup"); each(s.oracles, "oracles"); each(s.forbidden, "forbidden");
  return out;
}

/** One JSON-RPC request to an MCP server over streamable HTTP; the answer may be JSON or an event stream. */
async function rpc(url, headers, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now() % 1e9, method, params }) });
  const raw = await res.text();
  let body = null;
  for (const chunk of [raw, ...raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).reverse()]) {
    try { const j = JSON.parse(chunk); if (j && (j.result !== undefined || j.error !== undefined)) { body = j; break; } } catch { /* next */ }
  }
  return { status: res.status, body, raw };
}

/** The target as one persona sees it. Credentials come from static headers and/or a command run before every request. */
export function target(cfg, env = process.env) {
  const url = expandEnv(cfg.url, env);
  const headersFor = (persona) => {
    let h = { ...(cfg.headers ? JSON.parse(expandEnv(JSON.stringify(cfg.headers), env)) : {}) };
    if (cfg.headerCmd) {
      const r = spawnSync("sh", ["-c", cfg.headerCmd], { encoding: "utf8", env: { ...env, SIM_PERSONA: persona, SIM_MCP_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
      if (r.status) throw new Error(`headerCmd failed for ${persona}: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`);
      h = { ...h, ...JSON.parse(r.stdout.trim().split("\n").at(-1)) };
    }
    return h;
  };
  const call = async (persona, tool, args = {}) => {
    const r = await rpc(url, headersFor(persona), "tools/call", { name: tool, arguments: args });
    if (!r.body) return { error: true, text: `HTTP ${r.status}: ${r.raw.slice(0, 300)}` };
    if (r.body.error) return { error: true, text: JSON.stringify(r.body.error).slice(0, 2000) };
    return { error: !!r.body.result?.isError, text: (r.body.result?.content ?? []).map((c) => c.text ?? "").join("\n") };
  };
  const tools = async (persona) => {
    const r = await rpc(url, headersFor(persona), "tools/list", {});
    return (r.body?.result?.tools ?? []).map((t) => ({ name: t.name, description: String(t.description ?? "") }));
  };
  return { url, headersFor, call, tools };
}

/** A web surface: no MCP server of its own; the agent uses the browser of sims.agent.servers, oracles are commands. */
export const webTarget = (url) => ({ url, web: true, headersFor: () => ({}), tools: async () => [], call: async () => ({ error: true, text: "a web surface has no MCP tools" }) });

/**
 * A local door to the target for one persona: every request the agent makes goes out with that persona's credentials
 * (fresh ones each time, for servers whose credentials are single-use), and each tool it calls is written down.
 */
export function proxy(t, persona) {
  const called = [], calls = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      // Which tool, and which of its arguments were given (names only: what was written stays in the product).
      try { for (const m of [].concat(JSON.parse(body.toString("utf8")))) if (m?.method === "tools/call") { called.push(String(m.params?.name ?? "")); calls.push({ tool: String(m.params?.name ?? ""), args: Object.keys(m.params?.arguments ?? {}).sort() }); } } catch { /* not JSON */ }
      const pass = Object.fromEntries(["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"].filter((k) => req.headers[k]).map((k) => [k, req.headers[k]]));
      const up = await fetch(t.url, { method: req.method, headers: { ...pass, ...t.headersFor(persona) }, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
      res.writeHead(up.status, Object.fromEntries(["content-type", "mcp-session-id", "cache-control"].filter((k) => up.headers.get(k)).map((k) => [k, up.headers.get(k)])));
      if (up.body) for await (const c of up.body) res.write(c);
      res.end();
    } catch (e) { res.writeHead(502, { "content-type": "text/plain" }); res.end(`sim proxy: ${e.message}`); }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}/mcp`, called, calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) })));
}

/** The agent's environment: no API key, so Claude Code uses the login it has (or CLAUDE_CODE_OAUTH_TOKEN in CI). */
export function agentEnv(env, allowApiKey = false) {
  const e = { ...env };
  if (!allowApiKey) for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete e[k];
  return e;
}

/**
 * One agent run. `agent.cmd` (or SIM_AGENT_CMD) swaps Claude Code for any command, which gets SIM_PROXY_URL, SIM_TASK
 * and SIM_PERSONA: how this file is tested without a model, and how another harness can be plugged in. SIM_AGENT_MODEL
 * overrides agent.model (the soak's rounds run on a cheaper model than the deploy gate: traffic.mjs).
 */
export function runAgent({ task, system, proxyUrl, persona, agent = {}, env = process.env }) {
  const timeoutMs = (agent.timeout_s ?? 300) * 1000, custom = env.SIM_AGENT_CMD ?? agent.cmd;
  const cwd = mkdtempSync(join(tmpdir(), "sim-"));
  let cmd, args;
  if (custom) { cmd = "sh"; args = ["-c", custom]; }
  else {
    writeFileSync(join(cwd, "mcp.json"), JSON.stringify({ mcpServers: { ...(proxyUrl ? { app: { type: "http", url: proxyUrl } } : {}), ...(agent.servers ?? {}) } }));
    cmd = agent.bin ?? "claude";
    args = ["-p", task, "--restricted", "--strict-mcp-config", "--mcp-config", join(cwd, "mcp.json"), "--tools", "", "--disable-slash-commands",
      "--no-session-persistence", "--system-prompt", system, "--allowedTools", [...(proxyUrl ? ["mcp__app"] : []), ...Object.keys(agent.servers ?? {}).map((n) => `mcp__${n}`)].join(","),
      "--output-format", "stream-json", "--verbose", ...(env.SIM_AGENT_MODEL || agent.model ? ["--model", env.SIM_AGENT_MODEL || agent.model] : [])];
  }
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: { ...agentEnv(env, agent.allowApiKey), SIM_PROXY_URL: proxyUrl ?? "", SIM_TASK: task, SIM_PERSONA: persona }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, why: `could not start the agent: ${e.message}`, source: custom ? "custom" : "unknown" }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // The tools it used, from its events (a web surface's calls go to the browser, past the proxy).
      let init = null, result = null;
      const used = [];
      for (const line of out.split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e.type === "system" && e.subtype === "init") init = e;
          if (e.type === "result") result = e;
          if (e.type === "assistant") for (const c of e.message?.content ?? []) if (c?.type === "tool_use") used.push(String(c.name));
        } catch { /* not an event */ }
      }
      if (custom) return done({ ok: code === 0 && !timedOut, why: timedOut ? "timed out" : code ? `agent command exited ${code}: ${err.trim().split("\n").at(-1) ?? ""}` : "", source: "custom", said: out.trim().slice(-600), used });
      const source = !init ? "unknown" : init.apiKeySource === "none" ? "subscription" : `api-key (${init.apiKeySource})`;
      const mcp = (init?.mcp_servers ?? []).find((s) => s.name === (proxyUrl ? "app" : Object.keys(agent.servers ?? {})[0]));
      const why = timedOut ? `timed out after ${timeoutMs / 1000} s` : !result ? `no result from the agent: ${(err || out).trim().split("\n").at(-1) ?? ""}`.slice(0, 300)
        : mcp && mcp.status !== "connected" ? `the agent could not connect to the target (${mcp.status})` : result.is_error ? `the agent ended in an error: ${String(result.result ?? result.subtype).slice(0, 200)}` : "";
      done({ ok: !why, why, source, model: init?.model, turns: result?.num_turns, said: String(result?.result ?? "").slice(0, 600), costUsd: result?.total_cost_usd, ms: result?.duration_ms, used });
    });
  });
}

const SYSTEM = (p, web = false) => `You are ${p.name ?? p.id}, ${p.about ?? p.role ?? "a person using this product"}.
You are at work and have one thing to get done, given to you below in your own words. ${web ? "You have a web browser and nothing else: the product is the site your task names." : "You have the product's tools and nothing else."}
Find out what ${web ? "the site" : "the tools"} can do yourself; nobody will tell you ${web ? "where to click" : "which to use"}. Use only what the product tells you: do not invent facts.
Do the work for real, then stop. When you are done, say in two lines what you did and anything that got in your way. If the product would not let you, say exactly what it answered.`;

async function check(t, o, vars, env) {
  if (o.cmd) {
    const r = spawnSync("sh", ["-c", fill(o.cmd, vars)], { encoding: "utf8", env: { ...env, SIM_MCP_URL: t.url, SIM_RUN: vars.run }, timeout: (o.timeout_s ?? 120) * 1000 });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    return { holds: r.status === 0 && text.includes(o.marker), text: text.slice(-400) };
  }
  const a = await t.call(o.as, o.tool, fill(o.args ?? {}, vars));
  return { holds: holds(fill(o.expect ?? {}, vars), a), text: a.text.slice(0, 400), error: a.error };
}

/** One scenario, start to finish. Returns its record; `ok` only when every oracle turned from false to true. */
const newRun = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/**
 * A scenario, or a journey: steps in order, each played by its own person with a fresh agent that knows nothing of the
 * steps before it except what they left in the product. One {run} id is shared, so a later step can find what an
 * earlier one wrote. The journey stops at the first step that fails; the steps after it are named as not run.
 */
export async function runScenario(s, t, opts = {}) {
  const vars = { run: newRun(), ...deployUrls(opts.env), ...(s.vars ?? {}) };
  if (!Array.isArray(s.steps)) return runStep(s, t, opts, vars);
  const log = opts.log ?? (() => {});
  const rec = { name: s.name, surface: s.surface, persona: [...new Set(s.steps.map((x) => x.persona.id))].join("+"), run: vars.run, steps: [], oracles: [], failed: [], called: [], turns: 0, ms: 0, costUsd: 0 };
  const agents = new Set();
  for (const [i, st] of s.steps.entries()) {
    const title = st.name ?? `step ${i + 1}`;
    log(`  step ${i + 1}/${s.steps.length} ${title} as ${st.persona.id}`);
    const r = await runStep({ ...st, name: s.name, surface: s.surface }, t, opts, vars);
    rec.steps.push({ name: title, persona: st.persona.id, ok: r.ok, oracles: r.oracles, called: r.called ?? [], calls: r.calls ?? [], turns: r.turns, ms: r.ms, agent: r.agent, failed: r.failed, said: r.said });
    rec.oracles.push(...r.oracles.map((o) => ({ name: `${title}: ${o.name}`, holds: o.holds })));
    rec.called.push(...(r.called ?? [])); rec.turns += r.turns ?? 0; rec.ms += r.ms ?? 0; rec.costUsd += r.costUsd ?? 0;
    if (r.agent) agents.add(r.agent);
    log(`  ${r.ok ? "ok  " : "FAIL"} step ${i + 1} ${title}: ${r.oracles.filter((o) => o.holds).length}/${(st.oracles ?? []).length} oracles, ${(r.called ?? []).length} tool calls${r.ms ? `, ${Math.round(r.ms / 1000)} s` : ""}`);
    if (!r.ok) {
      rec.failed.push(`step ${i + 1} (${title}): ${r.failed.join("; ")}`);
      rec.notRun = s.steps.slice(i + 1).map((x, k) => x.name ?? `step ${i + 2 + k}`);
      if (rec.notRun.length) log(`     not run after that: ${rec.notRun.join(", ")}`);
      break;
    }
  }
  rec.agent = [...agents].join("+");
  return { ...rec, ok: !rec.failed.length };
}

/** One person, one fresh agent, one job, start to finish. */
async function runStep(s, t, { personas = {}, agent = {}, env = process.env, log = () => {} } = {}, vars = { run: newRun() }) {
  const rec = { name: s.name, surface: s.surface, persona: s.persona.id, run: vars.run, oracles: [], failed: [] };
  const fail = (m) => { rec.failed.push(m); log(`     ${m}`); };
  for (const st of s.setup ?? []) {
    const a = await t.call(st.as, st.tool, fill(st.args ?? {}, vars));
    if (a.error && st.expectError !== true) { fail(`setup '${st.name}' failed: ${a.text.slice(0, 200)}`); return { ...rec, ok: false }; }
  }
  for (const o of s.oracles ?? []) if ((o.before ?? "fail") === "fail" && (await check(t, o, vars, env)).holds) fail(`oracle '${o.name}' already holds before the agent acts: it cannot tell success from doing nothing`);
  for (const o of s.forbidden ?? []) if ((await check(t, o, vars, env)).holds) fail(`forbidden '${o.name}' already holds before the agent acts`);
  if (rec.failed.length) return { ...rec, ok: false };

  const persona = { ...(personas[s.persona.id] ?? {}), ...s.persona }, task = fill(s.task, vars);
  const unset = /\{(DEPLOY_URL_[A-Z0-9_]+)\}/.exec(task)?.[1];
  if (unset) { fail(`the task names {${unset}}, which is not set: run it as a gate (deploy.mjs gives each Worker's address) or set it`); return { ...rec, ok: false }; }
  const p = t.web ? null : await proxy(t, persona.id);
  const a = await runAgent({ task, system: SYSTEM(persona, t.web), proxyUrl: p?.url, persona: persona.id, agent: { ...agent, ...(s.agent ?? {}) }, env });
  await p?.close();
  const called = p ? p.called : a.used ?? [];
  Object.assign(rec, { agent: a.source, model: a.model, turns: a.turns, ms: a.ms, costUsd: a.costUsd, called, calls: p ? p.calls : called.map((tool) => ({ tool, args: [] })), said: a.said });
  if (!a.ok) fail(a.why);
  if (a.source.startsWith("api-key") && !agent.allowApiKey) fail(`the agent ran on an ${a.source}, not the subscription login (sims.agent.allowApiKey permits it)`);
  if (a.ok && !called.length && !s.allowNoCalls) fail(`the agent called no tool${t.web ? " of its browser" : ""}: nothing was exercised`);
  for (const o of s.oracles ?? []) {
    const r = await check(t, o, vars, env);
    rec.oracles.push({ name: o.name, holds: r.holds });
    if (!r.holds) fail(`oracle '${o.name}' does not hold: ${r.text.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  for (const o of s.forbidden ?? []) if ((await check(t, o, vars, env)).holds) fail(`forbidden '${o.name}' holds after the agent acted`);
  // What the product showed the agent ends up in its answer: text this persona must never see there is a leak.
  for (const x of fill([].concat(s.mustNotSay ?? []), vars)) if (String(a.said ?? "").includes(x)) fail(`the agent's answer contains ${JSON.stringify(x)}, which ${persona.id} must never be shown`);
  // A step whose job is to find something out: its answer must carry what only the product could have told it.
  for (const x of fill([].concat(s.mustSay ?? []), vars)) if (!String(a.said ?? "").includes(x)) fail(`the agent's answer does not contain ${JSON.stringify(x)}: it did not find what the product holds`);
  return { ...rec, ok: !rec.failed.length };
}

/** The scenarios of a directory (sub-directories are not read: findings/ holds what was not kept). */
export function load(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: join(dir, f), ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}

function config(root, manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8")), c = m.sims;
  if (!c) { console.error("the manifest has no `sims`: add sims.dir and sims.target (see the skill's manifest example)"); process.exit(2); }
  // A server whose command starts with ./ is the repo's own (its playwright's browser MCP): the agent runs elsewhere.
  if (c.agent?.servers) c.agent.servers = Object.fromEntries(Object.entries(c.agent.servers).map(([k, v]) => [k, String(v?.command).startsWith("./") ? { ...v, command: resolve(root, v.command) } : v]));
  return { m, c, dir: resolve(root, c.dir ?? ".deploy/sims"), personas: c.personas ?? {}, readOnly: c.readOnly ?? READ_ONLY };
}

async function main() {
  const argv = process.argv.slice(2), cmd = argv[0];
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const manifestPath = resolve(arg("manifest", join(dirname(new URL(import.meta.url).pathname), "manifest.json")));
  const root = resolve(arg("root", join(dirname(manifestPath), "..")));
  const { c, dir, personas, readOnly } = config(root, manifestPath);
  const env = { ...process.env }, web = !c.target;
  const all = load(dir), only = arg("only");

  if (cmd === "fabricate" && argv.includes("--from-spec")) {
    // A vibestack project: each story of the spec is a simulated person, written by the project's own `spec train`
    // (it knows the generated module that judges what the deployed Worker holds). Proved when `run` runs them.
    const r = train(root);
    process.stdout.write(r.out.endsWith("\n") || !r.out ? r.out : `${r.out}\n`);
    if (!r.ok) { console.log("SIM_FABRICATE_FAIL the spec's stories could not be written as scenarios"); process.exit(1); }
    const born = load(dir).filter((s) => s.story), unsound = born.filter((s) => problems(s, { personas, readOnly, web }).length);
    for (const s of unsound) console.log(`unsound ${s.name}: ${problems(s, { personas, readOnly, web }).join("; ")}`);
    console.log(`${unsound.length ? "SIM_FABRICATE_FAIL" : "SIM_FABRICATE_OK"} kept=${born.length - unsound.length} findings=0 thrown_away=${unsound.length} from=spec`);
    process.exit(unsound.length ? 1 : 0);
  }

  if (cmd === "validate") {
    let bad = 0;
    for (const s of all) { const p = problems(s, { personas, readOnly, web }); if (p.length) { bad++; console.log(`FAIL ${s.name ?? s.file}\n     ${p.join("\n     ")}`); } else console.log(`ok   ${s.name} [${s.surface}] ${Array.isArray(s.steps) ? `journey of ${s.steps.length} steps` : `as ${s.persona.id}`}`); }
    if (!all.length) { console.log(`SIM_VALIDATE_FAIL no scenarios in ${dir}`); process.exit(1); }
    if (bad) { console.log(`SIM_VALIDATE_FAIL ${bad} of ${all.length}`); process.exit(1); }
    console.log(`SIM_VALIDATE_OK sims=${all.length}`); return;
  }

  const where = env.DEPLOY_ENV ?? arg("env", "");
  const allowed = c.envs ?? ["preview", "staging", "preprod"];
  if (where === "production" || (where && !allowed.includes(where))) { console.log(`SIM_FAIL sims do not run against ${where} (sims.envs: ${allowed.join(", ")})`); process.exit(1); }
  if (arg("target")) env.SIM_MCP_URL = arg("target");
  let t;
  if (web) {
    const url = arg("target") ?? Object.values(deployUrls(env))[0];
    if (!url) { console.log("SIM_FAIL a web surface needs its address: DEPLOY_URL_<WORKER> (a gate gets one) or --target"); process.exit(1); }
    if (!Object.keys(c.agent?.servers ?? {}).length) { console.log("SIM_FAIL a web surface (no sims.target) needs a browser in sims.agent.servers for the agent to use it"); process.exit(1); }
    if (cmd === "fabricate") { console.log("SIM_FABRICATE_FAIL agent-written scenarios need an MCP target to read; a vibestack spec: --from-spec"); process.exit(1); }
    t = webTarget(url);
  } else try { t = target(c.target ?? {}, env); } catch (e) { console.log(`SIM_FAIL target: ${e.message}`); process.exit(1); }
  if (c.forbidTargets && new RegExp(c.forbidTargets).test(t.url)) { console.log(`SIM_FAIL ${new URL(t.url).host} is on the list sims must never touch (sims.forbidTargets)`); process.exit(1); }
  const world = (which) => {
    if (!c[which]) return true;
    const r = spawnSync("sh", ["-c", c[which]], { cwd: root, encoding: "utf8", env: { ...env, SIM_MCP_URL: t.url }, timeout: 600000 });
    if (r.status) console.log(`${which} failed:\n${`${r.stdout}${r.stderr}`.slice(-1200)}`);
    return r.status === 0;
  };
  if (!world("world")) { console.log("SIM_FAIL the world could not be prepared"); process.exit(1); }
  let code = 0;
  try {
    const first = Object.keys(personas)[0] ?? all[0]?.persona?.id ?? all[0]?.steps?.[0]?.persona?.id;
    const tools = first ? (await t.tools(first)).map((x) => x.name) : [];
    if (!tools.length && !web) { console.log("SIM_FAIL the target lists no tools (address or credentials)"); code = 1; return; }

    if (cmd === "fabricate") { code = await fabricate({ c, dir, personas, readOnly, t, tools: await t.tools(first), env, arg, existing: all }); return; }
    if (cmd !== "run") { console.error("usage: sim.mjs run | validate | fabricate"); code = 2; return; }

    const list = all.filter((s) => !only || s.name === only);
    if (!list.length) { console.log(`SIM_FAIL no scenario${only ? ` named ${only}` : `s in ${dir}`}`); code = 1; return; }
    const recs = [];
    for (const s of list) {
      const p = problems(s, { personas, readOnly, tools, web });
      if (p.length) { console.log(`FAIL ${s.name}: not a sound scenario\n     ${p.join("\n     ")}`); recs.push({ name: s.name, ok: false, failed: p }); continue; }
      console.log(`run  ${s.name} [${s.surface}] ${Array.isArray(s.steps) ? `journey of ${s.steps.length} steps` : `as ${s.persona.id}`}`);
      let r = await runScenario(s, t, { personas, agent: c.agent ?? {}, env, log: console.log });
      // A simulated person is one try, and a person does not do the same thing every time. A failure is tried again
      // (sims.attempts in all, default 3): only when every later try passes does the scenario pass, and then the
      // failure is kept as a finding, not forgotten. One that fails again is a failure.
      const attempts = Math.max(1, Number(arg("attempts") ?? c.attempts ?? 3)), firstFailure = r;
      for (let n = 2; !firstFailure.ok && n <= attempts; n++) {
        console.log(`     failed once (${(firstFailure.failed ?? []).join("; ").slice(0, 160)}); try ${n} of ${attempts}`);
        // A journey writes to fixed places (a client's folder), so what the try before left is still there and its
        // oracles "already hold before the agent acts": a second try in the same world can never pass (Chronos
        // staging, 2026-11-13). Each later try of a journey gets the world built again from nothing.
        if (Array.isArray(s.steps)) {
          if (!c.world || !c.teardown) { console.log(`     a journey needs a world it can rebuild to be tried again (sims.world and sims.teardown): the first failure stands`); break; }
          if (!(world("teardown") && world("world"))) { console.log(`     the world could not be rebuilt for another try: the first failure stands`); break; }
        }
        r = await runScenario(s, t, { personas, agent: c.agent ?? {}, env, log: console.log });
        if (!r.ok) break;
      }
      if (!firstFailure.ok && !r.ok && r !== firstFailure) r.failed = [...(r.failed ?? []), `first try: ${(firstFailure.failed ?? []).join("; ").slice(0, 300)}`];
      if (!firstFailure.ok && r.ok) r.flaky = { tries: attempts, firstFailure: firstFailure.failed, called: firstFailure.called ?? [], said: firstFailure.said };
      console.log(`${r.ok ? "ok  " : "FAIL"} ${s.name}: ${Array.isArray(s.steps) ? `${r.steps.filter((x) => x.ok).length}/${s.steps.length} steps, ` : ""}${r.oracles.filter((o) => o.holds).length}/${(s.steps ?? [s]).reduce((n, x) => n + (x.oracles ?? []).length, 0)} oracles, ${r.called?.length ?? 0} tool calls (${[...new Set(r.called ?? [])].join(", ") || "none"})${r.turns ? `, ${r.turns} turns` : ""}${r.ms ? `, ${Math.round(r.ms / 1000)} s` : ""}, agent=${r.agent ?? "-"}`);
      recs.push(r);
    }
    const runs = resolve(root, c.runs ?? ".deploy/.sim-runs");
    mkdirSync(runs, { recursive: true });
    for (const r of recs) writeFileSync(join(runs, `${r.name}.json`), JSON.stringify({ ...r, at: new Date().toISOString(), target: new URL(t.url).host }, null, 2));
    if (arg("json")) writeFileSync(arg("json"), JSON.stringify(recs, null, 2));
    // Flaky scenarios: each is written to findings/ for a person to read, and counted. The third time in a week one
    // fails-then-passes, it fails the gate: by then it is how often a real person would fail at it.
    const flakyFile = join(runs, "flaky.json"), seen = existsSync(flakyFile) ? JSON.parse(readFileSync(flakyFile, "utf8")) : {}, week = Date.now() - 7 * 86_400_000;
    for (const r of recs.filter((x) => x.flaky)) {
      seen[r.name] = [...(seen[r.name] ?? []).filter((d) => Date.parse(d) > week), new Date().toISOString()];
      mkdirSync(join(dir, "findings"), { recursive: true });
      writeFileSync(join(dir, "findings", `${r.name}-flaky-${r.run}.json`), JSON.stringify({ scenario: r.name, at: new Date().toISOString(), target: new URL(t.url).host, ...r.flaky }, null, 2));
      const often = seen[r.name].length >= 3;
      console.log(`${often ? "FAIL" : "flaky"} ${r.name}: failed once, then passed ${r.flaky.tries - 1} of ${r.flaky.tries - 1}${often ? `; flaky ${seen[r.name].length} times in 7 days: fix the product or the scenario` : ""} (first failure: ${(r.flaky.firstFailure ?? []).join("; ").slice(0, 200)})`);
      if (often) { r.ok = false; r.failed = [`flaky ${seen[r.name].length} times in 7 days`]; }
    }
    if (recs.some((x) => x.flaky)) writeFileSync(flakyFile, JSON.stringify(seen, null, 2));
    const flaky = recs.filter((r) => r.flaky && r.ok).length;
    const bad = recs.filter((r) => !r.ok), agents = [...new Set(recs.map((r) => r.agent).filter(Boolean))];
    if (bad.length) { console.log(`SIM_FAIL ${bad.length} of ${recs.length}: ${bad.map((r) => r.name).join(", ")}`); code = 1; return; }
    console.log(`SIM_OK sims=${recs.length} oracles=${recs.reduce((n, r) => n + r.oracles.length, 0)} agent=${agents.join("+")}${flaky ? ` flaky=${flaky}` : ""}`);
  } finally {
    // --keep leaves the made-up world up after the run, to read what the agents left when a step failed.
    if (argv.includes("--keep")) console.log("the world was kept (--keep): remove it with the manifest's sims.teardown command when done");
    else world("teardown");
    process.exit(code);
  }
}

/**
 * New scenarios written by an agent from what the target can do, then proved here: sound by the rules, false before
 * anyone acts, and passed by a fresh agent. Those are kept in the gate set. One that breaks a rule, or whose oracle is
 * already true, is thrown away with the reason. One a fresh agent could not pass is a finding (a bug, or a goal the
 * product cannot meet yet): it is written to findings/ for a person to read, never silently dropped.
 */
async function fabricate({ c, dir, personas, readOnly, t, tools, env, arg, existing }) {
  const count = Number(arg("count", "3")), focus = arg("focus", "");
  const schema = { type: "object", required: ["scenarios"], properties: { scenarios: { type: "array", items: { type: "object", required: ["name", "surface", "persona", "task", "oracles"],
    properties: { name: { type: "string" }, surface: { type: "string" }, persona: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, task: { type: "string" },
      setup: { type: "array", items: { type: "object" } }, oracles: { type: "array", items: { type: "object" } }, forbidden: { type: "array", items: { type: "object" } } } } } } };
  const prompt = `Write ${count} user-testing scenarios for the product whose tools are listed below. Each is one realistic job a real person in one of the roles would bring to it, in that person's own words.

Rules (a scenario that breaks one is thrown away):
- "task": what the person wants, in plain words, 2-5 sentences. Never name a tool or a parameter. Write the literal text {run} inside any title, reference or phrase the person asks to be saved, so it is unique each time the scenario runs.
- "persona": {"id": one of ${JSON.stringify(Object.keys(personas))}}.
- "oracles": 1-4 checks that are true only if the job was really done. Each: {"name", "as": persona id, "tool": a READ-ONLY tool (matching ${readOnly}), "args": {...}, "expect": {"contains": ["exact text that will be there"], "absent": [...], "matches": "regex"}}. They are run BEFORE the person acts and must be false then, so check for something only this task creates: put {run} in what the task writes and in what the oracle expects. An oracle that would already be true in the world as it stands (or that only checks something is absent) is thrown away. Check with a tool that returns stored content (reading or listing it), never one that repeats your question back in its answer.
- "forbidden" (optional): the same shape, for what must never become true (another client's data in an answer, a write the role may not make).
- "setup" (optional): steps to make before the person starts: {"name", "as", "tool", "args"} (may write).
- "surface": one of ${JSON.stringify([...new Set(existing.map((s) => s.surface))].concat(["mcp"]).filter((v, i, a) => a.indexOf(v) === i))}.
- "name": the scenario's own id: lower-case-with-dashes, no {run} in it, unique, not one of ${JSON.stringify(existing.map((s) => s.name))}.
${focus ? `Focus on: ${focus}\n` : ""}
People:
${Object.entries(personas).map(([id, p]) => `- ${id}: ${p.about ?? p.role ?? ""}`).join("\n")}

Tools:
${tools.map((x) => `- ${x.name}: ${x.description.replace(/\s+/g, " ").slice(0, 220)}`).join("\n")}

Answer with JSON only: {"scenarios": [...]}.`;
  const cwd = mkdtempSync(join(tmpdir(), "simfab-")), custom = env.SIM_FABRICATE_CMD;
  const r = custom ? spawnSync("sh", ["-c", custom], { encoding: "utf8", env: { ...env, SIM_PROMPT: prompt }, maxBuffer: 1 << 26 })
    : spawnSync(c.agent?.bin ?? "claude", ["-p", prompt, "--restricted", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--tools", "", "--disable-slash-commands", "--no-session-persistence",
        "--output-format", "json", "--json-schema", JSON.stringify(schema), ...(c.agent?.fabricateModel ?? c.agent?.model ? ["--model", c.agent.fabricateModel ?? c.agent.model] : [])],
      { cwd, encoding: "utf8", env: agentEnv(env, c.agent?.allowApiKey), maxBuffer: 1 << 26, timeout: 600000 });
  let made = [];
  try {
    const j = JSON.parse(r.stdout.trim().split("\n").at(-1));
    const body = j.structured_output ?? j.scenarios ?? JSON.parse(String(j.result ?? "{}").replace(/^```(?:json)?\s*|\s*```$/g, ""));
    made = body.scenarios ?? body;
  } catch (e) { console.log(`SIM_FABRICATE_FAIL the agent's answer was not the scenarios asked for: ${e.message}\n${String(r.stdout || r.stderr).slice(-400)}`); return 1; }
  const findings = join(dir, "findings");
  let kept = 0, found = 0, thrown = 0;
  for (const s of made) {
    if (typeof s?.name === "string") s.name = s.name.replace(/[-_]?\{run\}/g, "").replace(/-+$/, ""); // the id is fixed; only what the task writes varies
    const stamp = { by: "agent", model: c.agent?.fabricateModel ?? c.agent?.model ?? "default", at: new Date().toISOString().slice(0, 10) };
    const p = problems(s, { personas, readOnly, tools: tools.map((x) => x.name) });
    if (existing.some((e) => e.name === s.name)) p.push("name already used");
    if (p.length) { thrown++; console.log(`thrown away ${s.name ?? "(no name)"}: ${p.join("; ")}`); continue; }
    console.log(`prove ${s.name} [${s.surface}] as ${s.persona.id}`);
    const rec = await runScenario(s, t, { personas, agent: c.agent ?? {}, env, log: console.log });
    if (rec.ok) { kept++; writeFileSync(join(dir, `${s.name}.json`), JSON.stringify({ ...s, fabricated: { ...stamp, proved: rec.run } }, null, 2) + "\n"); console.log(`kept  ${s.name}: ${rec.oracles.length} oracles, ${rec.called.length} tool calls`); }
    else if (rec.called === undefined) { thrown++; console.log(`thrown away ${s.name}: ${rec.failed[0]}`); } // unsound before anyone acted: the scenario's fault, not the product's
    else { found++; mkdirSync(findings, { recursive: true }); writeFileSync(join(findings, `${s.name}.json`), JSON.stringify({ ...s, fabricated: stamp, finding: { failed: rec.failed, called: rec.called, said: rec.said } }, null, 2) + "\n"); console.log(`finding ${s.name}: ${rec.failed[0]}`); }
  }
  console.log(`SIM_FABRICATE_OK kept=${kept} findings=${found} thrown_away=${thrown}`);
  return 0;
}

// Run as a command (through a symlinked path too: the skills folder is one), not when imported by a test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? import.meta.dirname)).href) main();
