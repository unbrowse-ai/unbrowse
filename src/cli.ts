#!/usr/bin/env bun
/**
 * Unbrowse CLI — shell-safe wrapper for the local API.
 * Eliminates curl + jq escaping issues. All JSON is constructed
 * and parsed in TypeScript, never through shell interpolation.
 *
 * Usage: unbrowse <command> [flags]
 */

const BASE_URL = process.env.UNBROWSE_URL || "http://localhost:6969";

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const raw = argv.slice(2); // skip runtime + script
  const command = raw[0] && !raw[0].startsWith("--") ? raw[0] : "help";
  const rest = command === "help" ? raw : raw.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, args: positional, flags };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.headers.get("content-type")?.includes("json")) {
    return res.json();
  }
  if (!res.ok) {
    return { error: `HTTP ${res.status}: ${await res.text()}` };
  }
  return res.json();
}

function output(data: unknown, pretty = false): void {
  process.stdout.write((pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)) + "\n");
}

function die(msg: string): never {
  output({ error: msg });
  process.exit(1);
}

function info(msg: string): void {
  process.stderr.write(`[unbrowse] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Extract helper — resolve dot-paths with [] array expansion
// ---------------------------------------------------------------------------

function extract(data: unknown, fields: string[]): unknown {
  if (data == null) return data;

  function resolve(obj: unknown, path: string): unknown {
    const parts = path.split(".");
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      if (p.endsWith("[]")) {
        const key = p.slice(0, -2);
        const arr = key ? (cur as Record<string, unknown>)[key] : cur;
        if (!Array.isArray(arr)) return undefined;
        const remaining = parts.slice(parts.indexOf(p) + 1).join(".");
        if (!remaining) return arr;
        return arr.map((item) => resolve(item, remaining)).filter((v) => v !== undefined);
      }
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  }

  // If data is an array, map each item
  if (Array.isArray(data)) {
    return data.map((item) => {
      const out: Record<string, unknown> = {};
      for (const f of fields) {
        const alias = f.includes(":") ? f.split(":")[0] : f.split(".").pop()!;
        const path = f.includes(":") ? f.split(":").slice(1).join(":") : f;
        out[alias] = resolve(item, path);
      }
      return out;
    });
  }

  // Single object
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const alias = f.includes(":") ? f.split(":")[0] : f.split(".").pop()!;
    const path = f.includes(":") ? f.split(":").slice(1).join(":") : f;
    out[alias] = resolve(data, path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function ensureServer(noAutoStart: boolean): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return;
  } catch { /* not running */ }

  if (noAutoStart) die("Server not running. Start with: cd ~/.agents/skills/unbrowse && bun src/index.ts");

  info("Server not running. Starting...");
  const skillDir = process.env.SKILL_DIR ?? `${process.env.HOME}/.agents/skills/unbrowse`;
  const { spawn } = await import("child_process");
  spawn("bun", ["src/index.ts"], {
    cwd: skillDir,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, UNBROWSE_NON_INTERACTIVE: "1", UNBROWSE_TOS_ACCEPTED: "1" },
  }).unref();

  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) { info("Server ready."); return; }
    } catch { /* keep polling */ }
  }
  die("Server failed to start. Check /tmp/unbrowse.log");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdHealth(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("GET", "/health"), !!flags.pretty);
}

async function cmdResolve(flags: Record<string, string | boolean>): Promise<void> {
  const intent = flags.intent as string;
  if (!intent) die("--intent is required");

  const body: Record<string, unknown> = { intent };
  const url = flags.url as string | undefined;
  const domain = flags.domain as string | undefined;

  if (url) {
    body.params = { url };
    body.context = { url };
  }
  if (domain) {
    body.context = { ...(body.context as Record<string, unknown> ?? {}), domain };
  }
  if (flags["endpoint-id"]) {
    body.params = { ...(body.params as Record<string, unknown> ?? {}), endpoint_id: flags["endpoint-id"] };
  }
  if (flags.params) {
    body.params = { ...(body.params as Record<string, unknown> ?? {}), ...JSON.parse(flags.params as string) };
  }
  if (flags["dry-run"]) body.dry_run = true;
  if (flags["force-capture"]) body.force_capture = true;
  if (flags.raw) body.projection = { raw: true };

  let result = await api("POST", "/v1/intent/resolve", body) as Record<string, unknown>;

  // --extract: ad-hoc field extraction from .result
  const extractFields = flags.extract as string | undefined;
  if (extractFields && result.result) {
    const fields = extractFields.split(",").map((f) => f.trim());
    result = { ...result, result: extract(result.result, fields) };
  }

  // Append CLI hint for feedback
  const skill = result.skill as Record<string, unknown> | undefined;
  const trace = result.trace as Record<string, unknown> | undefined;
  if (skill?.skill_id && trace) {
    (result as Record<string, unknown>)._feedback = `unbrowse feedback --skill ${skill.skill_id} --endpoint ${trace.endpoint_id || "?"} --rating <1-5>`;
  }

  output(result, !!flags.pretty);
}

async function cmdExecute(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");

  const body: Record<string, unknown> = { params: {} };
  if (flags.endpoint) {
    (body.params as Record<string, unknown>).endpoint_id = flags.endpoint;
  }
  if (flags.params) {
    body.params = { ...(body.params as Record<string, unknown>), ...JSON.parse(flags.params as string) };
  }
  if (flags["dry-run"]) body.dry_run = true;
  if (flags["confirm-unsafe"]) body.confirm_unsafe = true;
  if (flags.raw) body.projection = { raw: true };

  let result = await api("POST", `/v1/skills/${skillId}/execute`, body) as Record<string, unknown>;

  const extractFields = flags.extract as string | undefined;
  if (extractFields && result.result) {
    const fields = extractFields.split(",").map((f) => f.trim());
    result = { ...result, result: extract(result.result, fields) };
  }

  output(result, !!flags.pretty);
}

async function cmdFeedback(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  const endpointId = flags.endpoint as string;
  const rating = Number(flags.rating);
  if (!skillId || !endpointId || !rating) die("--skill, --endpoint, and --rating are required");

  const body: Record<string, unknown> = {
    skill_id: skillId,
    endpoint_id: endpointId,
    rating,
  };
  if (flags.outcome) body.outcome = flags.outcome;
  if (flags.diagnostics) body.diagnostics = JSON.parse(flags.diagnostics as string);

  output(await api("POST", "/v1/feedback", body), !!flags.pretty);
}

async function cmdLogin(flags: Record<string, string | boolean>): Promise<void> {
  const url = flags.url as string;
  if (!url) die("--url is required");
  output(await api("POST", "/v1/auth/login", { url }), !!flags.pretty);
}

async function cmdSkills(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("GET", "/v1/skills"), !!flags.pretty);
}

async function cmdSkill(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const id = args[0] ?? flags.id as string;
  if (!id) die("skill <id> or --id required");
  output(await api("GET", `/v1/skills/${id}`), !!flags.pretty);
}

async function cmdSearch(flags: Record<string, string | boolean>): Promise<void> {
  const intent = flags.intent as string;
  if (!intent) die("--intent is required");
  const domain = flags.domain as string | undefined;
  const path = domain ? "/v1/search/domain" : "/v1/search";
  const body: Record<string, unknown> = { intent, k: Number(flags.k) || 5 };
  if (domain) body.domain = domain;
  output(await api("POST", path, body), !!flags.pretty);
}

async function cmdRecipe(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  const endpointId = flags.endpoint as string;
  if (!skillId || !endpointId) die("--skill and --endpoint are required");

  const recipe: Record<string, unknown> = {};
  if (flags.source) recipe.source = flags.source;
  if (flags.fields) {
    // Parse "alias:path,alias:path" into { alias: "path" }
    const fields: Record<string, string> = {};
    for (const pair of (flags.fields as string).split(",")) {
      const [key, ...rest] = pair.trim().split(":");
      fields[key] = rest.join(":") || key;
    }
    recipe.fields = fields;
  }
  if (flags.filter) recipe.filter = JSON.parse(flags.filter as string);
  if (flags.require) recipe.require = (flags.require as string).split(",");
  if (flags.compact) recipe.compact = true;
  if (flags.description) recipe.description = flags.description;

  output(await api("POST", `/v1/skills/${skillId}/endpoints/${endpointId}/recipe`, { recipe }), !!flags.pretty);
}

async function cmdSessions(flags: Record<string, string | boolean>): Promise<void> {
  const domain = flags.domain as string;
  if (!domain) die("--domain is required");
  const limit = flags.limit ?? "10";
  output(await api("GET", `/v1/sessions/${domain}?limit=${limit}`), !!flags.pretty);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  const help = `unbrowse — shell-safe CLI for the local API

Commands:
  health                                       Server health check
  resolve  --intent "..." --url "..." [opts]   Resolve intent → search/capture/execute
  execute  --skill ID --endpoint ID [opts]     Execute a specific endpoint
  feedback --skill ID --endpoint ID --rating N Submit feedback (mandatory after resolve)
  login    --url "..."                         Interactive browser login
  skills                                       List all skills
  skill    <id>                                Get skill details
  search   --intent "..." [--domain "..."]     Search marketplace
  recipe   --skill ID --endpoint ID [opts]     Submit extraction recipe
  sessions --domain "..." [--limit N]          Debug session logs

Global flags:
  --pretty          Indented JSON output
  --no-auto-start   Don't auto-start server
  --raw             Skip extraction recipes, return raw data

resolve/execute flags:
  --extract "field1,field2,alias:deep.path"   Ad-hoc field extraction from result
  --endpoint-id ID                            Pick a specific endpoint
  --dry-run                                   Preview mutations
  --force-capture                             Bypass caches, re-capture
  --params '{...}'                            Extra params as JSON

recipe flags:
  --source "data.items"                       Dot-path to source array
  --fields "name:user.name,text:body.text"    Field mappings (alias:path)
  --filter '{"field":"type","equals":"post"}' Filter criteria as JSON
  --require "id,text"                         Required non-null fields
  --compact                                   Strip nulls/empties
  --description "..."                         Human description

Examples:
  unbrowse resolve --intent "get timeline" --url "https://x.com"
  unbrowse execute --skill abc --endpoint def --pretty
  unbrowse execute --skill abc --endpoint def --extract "user,text,likes"
  unbrowse feedback --skill abc --endpoint def --rating 5
  unbrowse recipe --skill abc --endpoint def --source "included" --fields "author:actor.name,text:commentary.text" --compact
`;
  process.stderr.write(help);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv);
  const pretty = !!flags.pretty;
  const noAutoStart = !!flags["no-auto-start"];

  if (command === "help" || flags.help) {
    printHelp();
    process.exit(0);
  }

  // Health check doesn't need auto-start
  if (command !== "health") {
    await ensureServer(noAutoStart);
  }

  switch (command) {
    case "health": return cmdHealth(flags);
    case "resolve": return cmdResolve(flags);
    case "execute": case "exec": return cmdExecute(flags);
    case "feedback": case "fb": return cmdFeedback(flags);
    case "login": return cmdLogin(flags);
    case "skills": return cmdSkills(flags);
    case "skill": return cmdSkill(args, flags);
    case "search": return cmdSearch(flags);
    case "recipe": return cmdRecipe(flags);
    case "sessions": return cmdSessions(flags);
    default: info(`Unknown command: ${command}`); printHelp(); process.exit(1);
  }
}

main().catch((err) => {
  die((err as Error).message);
});
