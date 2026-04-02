#!/usr/bin/env bun
/**
 * Unbrowse CLI — shell-safe wrapper for the local API.
 * Eliminates curl + jq escaping issues. All JSON is constructed
 * and parsed in TypeScript, never through shell interpolation.
 *
 * Usage: unbrowse <command> [flags]
 */

import { config as loadEnv } from "dotenv";
import { ensureRegistered, getApiKey } from "./client/index.js";
import { findSitePack, findTask, allSitePacks, buildDepsGraph, planExecution, buildDepsMetadata, type SitePack } from "./cli/shortcuts.js";
import { ensureLocalServer, checkServerVersion, stopServer, restartServer } from "./runtime/local-server.js";
import { isMainModule } from "./runtime/paths.js";
import { drainPendingIndexJobs } from "./indexer/index.js";
import { drainPendingPassivePublishes } from "./orchestrator/passive-publish.js";
import { runSetup, type SetupReport, type SetupScope } from "./runtime/setup.js";

loadEnv({ quiet: true });
loadEnv({ path: ".env.runtime", quiet: true });

const BASE_URL = process.env.UNBROWSE_URL || "http://localhost:6969";
const CLI_CLIENT_ID = process.env.UNBROWSE_CLIENT_ID || `cli-${process.ppid || process.pid}`;

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
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      "x-unbrowse-client-id": CLI_CLIENT_ID,
    },
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

async function withPendingNotice<T>(promise: Promise<T>, message: string, delayMs = 3_000): Promise<T> {
  let done = false;
  const timer = setTimeout(() => {
    if (!done) info(message);
  }, delayMs);
  try {
    return await promise;
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

function normalizeSetupScope(value: string | boolean | undefined): SetupScope {
  if (value === true || value == null) return "auto";
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "global" || normalized === "project" || normalized === "off") return normalized;
  return "auto";
}

// ---------------------------------------------------------------------------
// Slim output — keep only essential trace metadata + result
// ---------------------------------------------------------------------------

function slimTrace(obj: Record<string, unknown>): Record<string, unknown> {
  const trace = obj.trace as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {
    trace: trace
      ? {
          trace_id: trace.trace_id,
          skill_id: trace.skill_id,
          endpoint_id: trace.endpoint_id,
          success: trace.success,
          status_code: trace.status_code,
          trace_version: trace.trace_version,
          ...(trace.schema_backfilled ? { schema_backfilled: true } : {}),
        }
      : undefined,
  };
  if ("result" in obj) out.result = obj.result;
  if (obj.available_endpoints) out.available_endpoints = obj.available_endpoints;
  if (obj.source) out.source = obj.source;
  if (obj.skill) out.skill = obj.skill;
  return out;
}


async function cmdHealth(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("GET", "/health"), !!flags.pretty);
}

async function cmdResolve(flags: Record<string, string | boolean>): Promise<void> {
  const intent = flags.intent as string;
  if (!intent) die("--intent is required");

  const body: Record<string, unknown> = { intent };
  const url = flags.url as string | undefined;
  const domain = flags.domain as string | undefined;
  const explicitEndpointId = flags["endpoint-id"] as string | undefined;
  const autoExecute = !!flags.execute;
  const extraParams = flags.params ? JSON.parse(flags.params as string) : {};

  if (url) {
    body.params = { url };
    body.context = { url };
  }
  if (domain) {
    body.context = { ...(body.context as Record<string, unknown> ?? {}), domain };
  }
  if (explicitEndpointId) {
    body.params = { ...(body.params as Record<string, unknown> ?? {}), endpoint_id: explicitEndpointId };
  }
  if (flags.params) {
    body.params = { ...(body.params as Record<string, unknown> ?? {}), ...extraParams };
  }
  if (flags["dry-run"]) body.dry_run = true;
  if (flags["force-capture"]) body.force_capture = true;
  body.projection = { raw: true };

  function execBody(endpointId: string): Record<string, unknown> {
    return { params: { endpoint_id: endpointId, ...extraParams }, intent, projection: { raw: true } };
  }

  function resolveSkillId(): string | undefined {
    return (result.skill as Record<string, unknown>)?.skill_id as string
      ?? (result as Record<string, unknown>).skill_id as string;
  }

  const startedAt = Date.now();
  let result = await withPendingNotice(
    api("POST", "/v1/intent/resolve", body) as Promise<Record<string, unknown>>,
    "Still working. First-time capture/indexing for a site can take 20-80s. Waiting is usually better than falling back.",
  );

  // Auto-handle auth: if site requires login, trigger interactive login and retry
  const resultError = (result.result as Record<string, unknown>)?.error
    ?? (result as Record<string, unknown>).error;
  if (resultError === "auth_required") {
    const loginUrl = (result.result as Record<string, unknown>)?.login_url as string
      ?? url ?? "";
    if (loginUrl) {
      info("Site requires authentication. Opening browser for login...");
      try {
        await api("POST", "/v1/auth/login", { url: loginUrl });
        info("Login complete. Retrying...");
        result = await withPendingNotice(
          api("POST", "/v1/intent/resolve", body) as Promise<Record<string, unknown>>,
          "Retrying after login...",
        );
      } catch (err) {
        die(`Login failed: ${(err as Error).message}. Run: unbrowse login --url "${loginUrl}"`);
      }
    }
  }

  // When agent explicitly picked an endpoint but resolve deferred, execute it directly
  if (explicitEndpointId && result.available_endpoints) {
    const skillId = resolveSkillId();
    if (skillId) {
      result = await withPendingNotice(
        api("POST", `/v1/skills/${skillId}/execute`, execBody(explicitEndpointId)) as Promise<Record<string, unknown>>,
        "Executing selected endpoint...",
      );
    }
  }

  // --execute: auto-pick best endpoint and return data in one step
  if (autoExecute && result.available_endpoints && !result.result) {
    const endpoints = result.available_endpoints as Array<Record<string, unknown>>;
    const skillId = resolveSkillId();
    if (skillId && endpoints.length > 0) {
      const bestEndpoint = endpoints[0];
      info(`Auto-executing endpoint: ${bestEndpoint.description ?? bestEndpoint.endpoint_id}`);
      result = await withPendingNotice(
        api("POST", `/v1/skills/${skillId}/execute`, execBody(bestEndpoint.endpoint_id as string)) as Promise<Record<string, unknown>>,
        "Executing best endpoint...",
      );
    }
  }

  // Browse session handoff
  const resultObj = result.result as Record<string, unknown> | undefined;
  if (resultObj?.status === "browse_session_open") {
    info(`No cached API. Browser session open on ${resultObj.domain ?? resultObj.url}.`);
    info(`Preferred flow: snap -> click/fill/eval -> submit -> sync -> close.`);
    info(`Use these commands to get your data:`);
    const commands = resultObj.commands as string[] ?? [
      "unbrowse snap --filter interactive",
      "unbrowse click <ref>",
      "unbrowse fill <ref> <value>",
      "unbrowse submit --wait-for \"/next-step\"",
      "unbrowse sync",
      "unbrowse close",
    ];
    for (const cmd of commands) info(`  ${cmd}`);
    info(`For JS-heavy forms: prefer real date/time clicks first, inspect hidden inputs with eval when needed, then submit.`);
    info(`All traffic is being passively captured. Run "unbrowse close" when done.`);
    output(slimTrace(result), !!flags.pretty);
    return;
  }

  if (Date.now() - startedAt > 3_000 && result.source === "live-capture") {
    info("Live capture finished. Future runs against this site should be much faster.");
  }

  result = slimTrace(result);

  const skill = result.skill as Record<string, unknown> | undefined;
  const trace = result.trace as Record<string, unknown> | undefined;
  if (skill?.skill_id && trace) {
    (result as Record<string, unknown>)._feedback = `unbrowse feedback --skill ${skill.skill_id} --endpoint ${trace.endpoint_id || "?"} --rating <1-5>`;
  }

  output(result, !!flags.pretty);
}

// ---------------------------------------------------------------------------
// Post-processing helpers for --path, --extract, --limit, --schema
// ---------------------------------------------------------------------------

/** Drill into a value using a dot-path like "data.items[].name".
 *  `[]` flattens arrays at that level so nested arrays become flat collections. */
function drillPath(data: unknown, path: string): unknown {
  const segments = path.split(/\./).flatMap((s) => {
    // "items[]" → ["items", "[]"]
    const m = s.match(/^(.+)\[\]$/);
    return m ? [m[1], "[]"] : [s];
  });
  // Work with an array of "current values" to handle multi-level flattening
  let values: unknown[] = [data];
  for (const seg of segments) {
    if (values.length === 0) return [];
    if (seg === "[]") {
      // Flatten: each value that is an array gets its elements spread out
      values = values.flatMap((v) => (Array.isArray(v) ? v : [v]));
      continue;
    }
    // Drill into each value
    values = values.flatMap((v) => {
      if (v == null) return [];
      if (Array.isArray(v)) {
        // Auto-flatten arrays even without explicit []
        return v.map((item) => (item as Record<string, unknown>)?.[seg]).filter((x) => x !== undefined);
      }
      if (typeof v === "object") {
        const val = (v as Record<string, unknown>)[seg];
        return val !== undefined ? [val] : [];
      }
      return [];
    });
  }
  return values;
}

/** Resolve a dot-path on a single object, e.g. "core.user_results.result.core.screen_name" */
function resolveDotPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Apply --extract field spec: "alias:deep.path,field2,alias2:path" */
function applyExtract(items: unknown[], extractSpec: string): unknown[] {
  const fields = extractSpec.split(",").map((f) => {
    const colon = f.indexOf(":");
    if (colon > 0) return { alias: f.slice(0, colon), path: f.slice(colon + 1) };
    return { alias: f, path: f };
  });
  return items
    .map((item) => {
      const row: Record<string, unknown> = {};
      let hasValue = false;
      for (const { alias, path } of fields) {
        const val = resolveDotPath(item, path);
        row[alias] = val ?? null;
        if (val != null) hasValue = true;
      }
      return hasValue ? row : null;
    })
    .filter((row): row is Record<string, unknown> => row !== null);
}

/** Build a compact schema tree from a value (depth-limited). */
function schemaOf(value: unknown, depth = 4): unknown {
  if (value == null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return ["unknown"];
    return [schemaOf(value[0], depth - 1)];
  }
  if (typeof value === "object") {
    if (depth <= 0) return "object";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = schemaOf(v, depth - 1);
    }
    return out;
  }
  return typeof value;
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
  if (flags.url) {
    body.context_url = flags.url;
    (body.params as Record<string, unknown>).url = flags.url;
  }
  if (flags.intent) body.intent = flags.intent;
  if (flags["dry-run"]) body.dry_run = true;
  if (flags["confirm-unsafe"]) body.confirm_unsafe = true;
  body.projection = { raw: true };

  let result = await withPendingNotice(
    api("POST", `/v1/skills/${skillId}/execute`, body) as Promise<Record<string, unknown>>,
    "Still working. This endpoint may require browser replay or first-time auth/capture setup.",
  );

  // Strip metadata bloat
  result = slimTrace(result);

  const pathFlag = flags.path as string | undefined;
  const extractFlag = flags.extract as string | undefined;
  const limitFlag = flags.limit ? Number(flags.limit) : undefined;
  const schemaFlag = !!flags.schema;
  const rawFlag = !!flags.raw;

  // --schema: show response structure without data
  if (schemaFlag && !rawFlag) {
    const data = result.result;
    output({ trace: result.trace, schema: schemaOf(data) }, !!flags.pretty);
    return;
  }

  // Apply --path, --extract, --limit when not --raw
  if (!rawFlag && (pathFlag || extractFlag || limitFlag)) {
    let data = pathFlag ? drillPath(result.result, pathFlag) : result.result;

    // Ensure array for extract/limit
    const items = Array.isArray(data) ? data : data != null ? [data] : [];

    // Apply --extract
    const extracted = extractFlag ? applyExtract(items, extractFlag) : items;

    // Apply --limit
    const limited = limitFlag ? extracted.slice(0, limitFlag) : extracted;

    const trace = result.trace as Record<string, unknown> | undefined;
    const out: Record<string, unknown> = { trace: result.trace, data: limited, count: limited.length };

    // Prompt agent to review when this is likely a first-time execute
    if (trace?.skill_id && trace?.endpoint_id && limited.length > 0) {
      out._review_hint = `After presenting results, improve this endpoint's description: unbrowse review --skill ${trace.skill_id} --endpoints '[{"endpoint_id":"${trace.endpoint_id}","description":"DESCRIBE WHAT THIS RETURNS","action_kind":"ACTION","resource_kind":"RESOURCE"}]'`;
    }

    output(out, !!flags.pretty);
    return;
  }

  // Auto-wrap large responses with extraction_hints when no flags given
  if (!rawFlag && !pathFlag && !extractFlag && !schemaFlag) {
    const raw = JSON.stringify(result.result);
    if (raw && raw.length > 2048) {
      const schema = schemaOf(result.result);
      output({
        trace: result.trace,
        extraction_hints: {
          message: "Response is large. Use --path/--extract/--limit to filter, or --schema to see structure, or --raw for full response.",
          schema_tree: schema,
          response_bytes: raw.length,
        },
      }, !!flags.pretty);
      return;
    }
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

async function cmdReview(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");
  const endpointsJson = flags.endpoints as string;
  if (!endpointsJson) die("--endpoints is required (JSON array of {endpoint_id, description?, action_kind?, resource_kind?})");
  const endpoints = JSON.parse(endpointsJson) as Array<Record<string, unknown>>;
  if (!Array.isArray(endpoints) || endpoints.length === 0) die("--endpoints must be a non-empty JSON array");
  output(await api("POST", `/v1/skills/${skillId}/review`, { endpoints }), !!flags.pretty);
}

async function cmdPublish(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");
  const endpointsJson = flags.endpoints as string | undefined;
  if (endpointsJson) {
    // Phase 2: merge descriptions + publish
    const endpoints = JSON.parse(endpointsJson) as Array<Record<string, unknown>>;
    if (!Array.isArray(endpoints) || endpoints.length === 0) die("--endpoints must be a non-empty JSON array");
    output(await api("POST", `/v1/skills/${skillId}/publish`, { endpoints }), !!flags.pretty);
  } else {
    // Phase 1: return endpoints needing descriptions
    output(await api("POST", `/v1/skills/${skillId}/publish`, {}), !!flags.pretty);
  }
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

async function cmdSessions(flags: Record<string, string | boolean>): Promise<void> {
  const domain = flags.domain as string;
  if (!domain) die("--domain is required");
  const limit = flags.limit ?? "10";
  output(await api("GET", `/v1/sessions/${domain}?limit=${limit}`), !!flags.pretty);
}

async function cmdSetup(flags: Record<string, string | boolean>): Promise<void> {
  info("Running setup checks");
  const report = await runSetup({
    cwd: process.cwd(),
    opencode: normalizeSetupScope(flags.opencode),
    installBrowser: !flags["skip-browser"],
  }) as SetupReport & {
    server?: {
      started: boolean;
      skipped?: boolean;
      base_url?: string;
      error?: string;
    };
  };

  if (report.browser_engine.action === "failed") {
    info("Browser engine install failed");
  } else if (report.browser_engine.action === "installed") {
    info("Browser engine installed");
  }

  if (report.opencode.action === "installed" || report.opencode.action === "updated") {
    info(`Open Code command installed at ${report.opencode.command_file}`);
  }

  if (flags["no-start"]) {
    report.server = { started: false, skipped: true, base_url: BASE_URL };
    output(report, true);
    if (report.browser_engine.action === "failed") process.exit(1);
    return;
  }

  if (!getApiKey()) {
    await ensureRegistered({ promptForEmail: true });
  }

  try {
    await ensureLocalServer(BASE_URL, false, import.meta.url);
    report.server = { started: true, base_url: BASE_URL };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.server = { started: false, error: message, base_url: BASE_URL };
    output(report, true);
    process.exit(1);
  }

  output(report, true);
  if (report.browser_engine.action === "failed") process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI Reference — single source of truth for help text AND SKILL.md
// ---------------------------------------------------------------------------

export const CLI_REFERENCE = {
  commands: [
    { name: "health", usage: "", desc: "Server health check" },
    { name: "setup", usage: "[--opencode auto|global|project|off] [--no-start]", desc: "Bootstrap browser deps + Open Code command" },
    { name: "resolve", usage: '--intent "..." --url "..." [opts]', desc: "Resolve intent → search/capture/execute" },
    { name: "execute", usage: "--skill ID --endpoint ID [opts]", desc: "Execute a specific endpoint" },
    { name: "feedback", usage: "--skill ID --endpoint ID --rating N", desc: "Submit feedback (mandatory after resolve)" },
    { name: "review", usage: "--skill ID --endpoints '[...]'", desc: "Push reviewed descriptions/metadata back to skill" },
    { name: "publish", usage: "--skill ID [--endpoints '[...]']", desc: "Describe + publish skill to marketplace (two-phase)" },
    { name: "login", usage: '--url "..."', desc: "Interactive browser login" },
    { name: "skills", usage: "", desc: "List all skills" },
    { name: "skill", usage: "<id>", desc: "Get skill details" },
    { name: "search", usage: '--intent "..." [--domain "..."]', desc: "Search marketplace" },
    { name: "sessions", usage: '--domain "..." [--limit N]', desc: "Debug session logs" },
    { name: "go", usage: '<url>', desc: "Open a live Kuri browser tab for capture-first workflows" },
    { name: "submit", usage: "[--form-selector sel] [--submit-selector sel] [--wait-for hint]", desc: "Submit current form with DOM-first + same-origin rehydrate fallback for JS-heavy flows" },
    { name: "snap", usage: "[--filter interactive]", desc: "A11y snapshot with @eN refs" },
    { name: "click", usage: "<ref>", desc: "Click element by ref (e.g. e5)" },
    { name: "fill", usage: "<ref> <value>", desc: "Fill input by ref" },
    { name: "type", usage: "<text>", desc: "Type text with key events" },
    { name: "press", usage: "<key>", desc: "Press key (Enter, Tab, Escape)" },
    { name: "select", usage: "<ref> <value>", desc: "Select option by ref" },
    { name: "scroll", usage: "[up|down|left|right]", desc: "Scroll the page" },
    { name: "screenshot", usage: "", desc: "Capture screenshot (base64 PNG)" },
    { name: "text", usage: "", desc: "Get page text content" },
    { name: "markdown", usage: "", desc: "Get page as Markdown" },
    { name: "cookies", usage: "", desc: "Get page cookies" },
    { name: "eval", usage: "<expression>", desc: "Evaluate JavaScript" },
    { name: "back", usage: "", desc: "Navigate back" },
    { name: "forward", usage: "", desc: "Navigate forward" },
    { name: "sync", usage: "", desc: "Flush the current step's captured traffic into route cache without closing tab" },
    { name: "close", usage: "", desc: "Close browse session, flush + index traffic" },
  ],
  globalFlags: [
    { flag: "--pretty", desc: "Indented JSON output" },
    { flag: "--no-auto-start", desc: "Don't auto-start server" },
    { flag: "--raw", desc: "Return raw response data (skip server-side projection)" },
    { flag: "--skip-browser", desc: "setup: skip browser-engine install" },
    { flag: "--opencode auto|global|project|off", desc: "setup: install /unbrowse command for Open Code" },
  ],
  resolveExecuteFlags: [
    { flag: "--schema", desc: "Show response schema + extraction hints only (no data)" },
    { flag: '--path "data.items[]"', desc: "Drill into result before extract/output" },
    { flag: '--extract "field1,alias:deep.path.to.val"', desc: "Pick specific fields (no piping needed)" },
    { flag: "--limit N", desc: "Cap array output to N items" },
    { flag: "--endpoint-id ID", desc: "Pick a specific endpoint" },
    { flag: "--dry-run", desc: "Preview mutations" },
    { flag: "--force-capture", desc: "Bypass caches, re-capture" },
    { flag: "--params '{...}'", desc: "Extra params as JSON" },
  ],
  examples: [
    "unbrowse setup",
    'unbrowse resolve --intent "top stories" --url "https://news.ycombinator.com" --execute',
    'unbrowse resolve --intent "get timeline" --url "https://x.com"',
    'unbrowse go "https://www.mandai.com/en/ticketing/admission-and-rides/parks-selection.html"',
    'unbrowse snap --filter interactive',
    'unbrowse submit --wait-for "/time-selection.html"',
    'unbrowse sync',
    "unbrowse execute --skill abc --endpoint def --pretty",
    "unbrowse execute --skill abc --endpoint def --schema --pretty",
    'unbrowse execute --skill abc --endpoint def --path "data.items[]" --extract "name,url" --limit 10 --pretty',
    "unbrowse feedback --skill abc --endpoint def --rating 5",
    'unbrowse review --skill abc --endpoints \'[{"endpoint_id":"def","description":"..."}]\'',
    "unbrowse publish --skill abc --pretty",
    'unbrowse publish --skill abc --endpoints \'[{"endpoint_id":"def","description":"Search court judgments by keywords","action_kind":"search","resource_kind":"judgment"}]\'',
  ],
};

function printHelp(): void {
  const r = CLI_REFERENCE;
  const lines: string[] = ["unbrowse \u2014 shell-safe CLI for the local API", ""];

  // Commands
  lines.push("Commands:");
  const cmdPad = Math.max(...r.commands.map((c) => `  ${c.name}  ${c.usage}`.length)) + 2;
  for (const c of r.commands) {
    const left = `  ${c.name}  ${c.usage}`;
    lines.push(left.padEnd(cmdPad) + c.desc);
  }

  // Global flags
  lines.push("", "Global flags:");
  const gPad = Math.max(...r.globalFlags.map((f) => `  ${f.flag}`.length)) + 2;
  for (const f of r.globalFlags) {
    lines.push(`  ${f.flag}`.padEnd(gPad) + f.desc);
  }

  // resolve/execute flags
  lines.push("", "resolve/execute flags:");
  const rPad = Math.max(...r.resolveExecuteFlags.map((f) => `  ${f.flag}`.length)) + 2;
  for (const f of r.resolveExecuteFlags) {
    lines.push(`  ${f.flag}`.padEnd(rPad) + f.desc);
  }

  // Examples
  lines.push("", "Examples:");
  for (const e of r.examples) {
    lines.push(`  ${e}`);
  }

  lines.push(
    "",
    "Browser workflow:",
    "  1. go -> open the live tab you want to work in",
    "  2. snap -> inspect refs and confirm the page state",
    "  3. click/fill/eval -> set real page state",
    "  4. submit -> prefer DOM submit; auto-falls back to same-origin rehydrate",
    "  5. sync -> flush captured routes after a successful step",
    "  6. close -> finish capture + indexing",
  );

  lines.push(
    "",
    "JS-heavy forms:",
    "  Prefer real calendar/time clicks before submit.",
    "  If the UI is flaky, inspect hidden inputs/cookies with eval, then submit the real form.",
  );

  lines.push("");
  process.stderr.write(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Server lifecycle commands
// ---------------------------------------------------------------------------

async function cmdStatus(flags: Record<string, string | boolean>): Promise<void> {
  const healthy = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2_000) })
    .then((r) => r.ok).catch(() => false);
  const versionInfo = checkServerVersion(BASE_URL, import.meta.url);
  output({
    server: healthy ? "running" : "stopped",
    url: BASE_URL,
    ...(versionInfo ?? {}),
  }, !!flags.pretty);
}

async function cmdRestart(flags: Record<string, string | boolean>): Promise<void> {
  info("Restarting server...");
  await restartServer(BASE_URL, import.meta.url);
  info("Server restarted.");
  await cmdStatus(flags);
}

function cmdStop(flags: Record<string, string | boolean>): void {
  const stopped = stopServer(BASE_URL);
  if (stopped) info("Server stopped.");
  else info("No server running.");
}

async function cmdUpgrade(flags: Record<string, string | boolean>): Promise<void> {
  info("Checking for updates...");
  const { execSync } = await import("node:child_process");
  try {
    const result = execSync("npm view unbrowse version", { encoding: "utf-8", timeout: 10_000 }).trim();
    const versionInfo = checkServerVersion(BASE_URL, import.meta.url);
    const installed = versionInfo?.installed ?? "unknown";
    if (result === installed) {
      info(`Already at latest version: ${installed}`);
      return;
    }
    info(`Update available: ${installed} -> ${result}`);
    info("Run: npm install -g unbrowse@latest");
    info("Then: unbrowse restart");
  } catch (err) {
    info(`Could not check for updates: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Site/task shortcut commands
// ---------------------------------------------------------------------------

async function cmdSiteHelp(pack: SitePack, flags: Record<string, string | boolean>): Promise<void> {
  // --deps: return dependency graph as JSON
  if (flags.deps) {
    const graph = buildDepsGraph(pack);
    output({ site: pack.site, tasks: graph }, !!flags.pretty);
    return;
  }
  // --plan: return execution plan for a set of tasks
  if (flags.plan) {
    const taskNames = (flags.plan as string).split(",").map((s) => s.trim());
    const waves = planExecution(pack, taskNames);
    output({ site: pack.site, waves }, !!flags.pretty);
    return;
  }
  // Default: human-readable help
  const lines: string[] = [
    `unbrowse ${pack.site} — ${pack.description}`,
    "",
    "Tasks:",
  ];
  for (const t of pack.tasks) {
    const aliases = t.match.length > 1 ? ` (${t.match.slice(1).join(", ")})` : "";
    const auth = t.needs_auth ? " [auth]" : "";
    lines.push(`  ${t.match[0]}${aliases}${auth}  ${t.description}`);
  }
  lines.push(
    "",
    "Examples:",
    `  unbrowse ${pack.site} login`,
    `  unbrowse ${pack.site} ${pack.tasks.find((t) => t.match[0] !== "login")?.match[0] || "help"} --pretty`,
    `  unbrowse ${pack.site} --batch ${pack.tasks.filter((t) => t.parallel_safe).map((t) => t.match[0]).join(",")}`,
    `  unbrowse ${pack.site} help --deps`,
    `  unbrowse ${pack.site} help --plan feed,notifications`,
    "",
    "Flags: --pretty --raw --path --extract --limit --force-capture --dry-run --batch --deps --plan",
  );
  process.stderr.write(lines.join("\n") + "\n");
}

async function cmdSiteLogin(pack: SitePack, flags: Record<string, string | boolean>): Promise<void> {
  const result = await api("POST", "/v1/auth/login", { url: pack.login_url });
  const deps = buildDepsMetadata(pack, "login");
  output({ ...result as Record<string, unknown>, _deps: deps, _shortcut: `${pack.site} login` }, !!flags.pretty);
}

async function cmdSiteTask(pack: SitePack, taskName: string, flags: Record<string, string | boolean>): Promise<void> {
  const task = findTask(pack, taskName);
  if (!task) {
    info(`Unknown task "${taskName}" for ${pack.site}. Run: unbrowse ${pack.site} help`);
    process.exit(1);
  }

  // Compile to resolve call
  const body: Record<string, unknown> = {
    intent: task.intent,
    params: { url: task.url },
    context: { url: task.url },
  };
  if (flags.params) {
    body.params = { ...(body.params as Record<string, unknown>), ...JSON.parse(flags.params as string) };
  }
  if (flags["dry-run"]) body.dry_run = true;
  if (flags["force-capture"]) body.force_capture = true;
  body.projection = { raw: true };

  const startedAt = Date.now();
  let result = await withPendingNotice(
    api("POST", "/v1/intent/resolve", body) as Promise<Record<string, unknown>>,
    "Still working. First-time capture/indexing for a site can take 20-80s.",
  );

  // Check for auth-required response
  if (result && typeof result === "object" && (result as Record<string, unknown>).error === "auth_required") {
    info(`Authentication required. Run: unbrowse ${pack.site} login`);
    const deps = buildDepsMetadata(pack, taskName);
    output({ ...(result as Record<string, unknown>), _deps: { ...deps, requires: ["login"] }, _next: [`unbrowse ${pack.site} login`] }, !!flags.pretty);
    process.exit(2);
  }

  // Strip metadata bloat
  result = slimTrace(result);

  const deps = buildDepsMetadata(pack, taskName);
  (result as Record<string, unknown>)._deps = deps;
  (result as Record<string, unknown>)._shortcut = `${pack.site} ${taskName}`;

  if (Date.now() - startedAt > 3_000 && result.source === "live-capture") {
    info("Live capture finished. Future runs should be much faster.");
  }

  output(result, !!flags.pretty);
}

async function cmdSiteBatch(pack: SitePack, batchArg: string, flags: Record<string, string | boolean>): Promise<void> {
  const taskNames = batchArg.split(",").map((s) => s.trim());
  const waves = planExecution(pack, taskNames);
  const results: Record<string, unknown> = { site: pack.site, waves: [], _deps: { parallel_safe: true } };
  const waveResults: unknown[] = [];

  for (const wave of waves) {
    const waveStart = Date.now();
    const promises = wave.commands.map(async (cmd) => {
      const parts = cmd.split(" ");
      const task = parts[parts.length - 1];
      const taskDef = findTask(pack, task);
      if (!taskDef) return { task, error: "unknown task" };

      if (task === "login") {
        return { task, result: await api("POST", "/v1/auth/login", { url: pack.login_url }) };
      }
      const body: Record<string, unknown> = {
        intent: taskDef.intent,
        params: { url: taskDef.url },
        context: { url: taskDef.url },
      };
      if (flags["force-capture"]) body.force_capture = true;
      body.projection = { raw: true };
      const res = await api("POST", "/v1/intent/resolve", body) as Record<string, unknown>;
      return { task, result: slimTrace(res) };
    });

    const waveResult = await Promise.all(promises);
    waveResults.push({
      wave: wave.wave,
      reason: wave.reason,
      elapsed_ms: Date.now() - waveStart,
      tasks: waveResult,
    });
  }

  (results as Record<string, unknown>).waves = waveResults;
  output(results, !!flags.pretty);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Browse commands — Kuri browser actions with passive indexing via server
// ---------------------------------------------------------------------------

async function cmdGo(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = args[0] ?? flags.url as string;
  if (!url) die("Usage: unbrowse go <url>");
  output(await api("POST", "/v1/browse/go", { url }), !!flags.pretty);
}

async function cmdSubmit(flags: Record<string, string | boolean>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (typeof flags["form-selector"] === "string") body.form_selector = flags["form-selector"];
  if (typeof flags["submit-selector"] === "string") body.submit_selector = flags["submit-selector"];
  if (typeof flags["wait-for"] === "string") body.wait_for = flags["wait-for"];
  if (typeof flags["timeout-ms"] === "string") body.timeout_ms = Number(flags["timeout-ms"]);
  if (flags["same-origin-fetch-fallback"] !== undefined) {
    body.same_origin_fetch_fallback = flags["same-origin-fetch-fallback"] !== "false";
  }
  output(await api("POST", "/v1/browse/submit", body), !!flags.pretty);
}

async function cmdSnap(flags: Record<string, string | boolean>): Promise<void> {
  const filter = flags.filter as string | undefined;
  const result = await api("POST", "/v1/browse/snap", { filter }) as { snapshot?: string };
  if (result.snapshot && !flags.pretty) {
    console.log(result.snapshot);
  } else {
    output(result, !!flags.pretty);
  }
}

async function cmdClick(args: string[]): Promise<void> {
  const ref = args[0];
  if (!ref) die("Usage: unbrowse click <ref>");
  output(await api("POST", "/v1/browse/click", { ref }), false);
}

async function cmdFill(args: string[]): Promise<void> {
  const ref = args[0];
  const value = args.slice(1).join(" ");
  if (!ref || !value) die("Usage: unbrowse fill <ref> <value>");
  output(await api("POST", "/v1/browse/fill", { ref, value }), false);
}

async function cmdType(args: string[]): Promise<void> {
  const text = args.join(" ");
  if (!text) die("Usage: unbrowse type <text>");
  output(await api("POST", "/v1/browse/type", { text }), false);
}

async function cmdPress(args: string[]): Promise<void> {
  const key = args[0];
  if (!key) die("Usage: unbrowse press <key>");
  output(await api("POST", "/v1/browse/press", { key }), false);
}

async function cmdSelect(args: string[]): Promise<void> {
  const ref = args[0];
  const value = args.slice(1).join(" ");
  if (!ref || !value) die("Usage: unbrowse select <ref> <value>");
  output(await api("POST", "/v1/browse/select", { ref, value }), false);
}

async function cmdScroll(args: string[]): Promise<void> {
  const direction = args[0] ?? "down";
  output(await api("POST", "/v1/browse/scroll", { direction }), false);
}

async function cmdScreenshot(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("GET", "/v1/browse/screenshot"), !!flags.pretty);
}

async function cmdText(flags: Record<string, string | boolean>): Promise<void> {
  const result = await api("GET", "/v1/browse/text") as { text?: string };
  if (result.text && !flags.pretty) {
    console.log(result.text);
  } else {
    output(result, !!flags.pretty);
  }
}

async function cmdMarkdown(flags: Record<string, string | boolean>): Promise<void> {
  const result = await api("GET", "/v1/browse/markdown") as { markdown?: string };
  if (result.markdown && !flags.pretty) {
    console.log(result.markdown);
  } else {
    output(result, !!flags.pretty);
  }
}

async function cmdCookies(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("GET", "/v1/browse/cookies"), !!flags.pretty);
}

async function cmdEval(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const expression = args.join(" ");
  if (!expression) die("Usage: unbrowse eval <expression>");
  output(await api("POST", "/v1/browse/eval", { expression }), !!flags.pretty);
}

async function cmdBack(): Promise<void> {
  output(await api("POST", "/v1/browse/back"), false);
}

async function cmdForward(): Promise<void> {
  output(await api("POST", "/v1/browse/forward"), false);
}

async function cmdSync(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/sync"), !!flags.pretty);
}

async function cmdClose(): Promise<void> {
  output(await api("POST", "/v1/browse/close"), false);
}

async function cmdConnectChrome(): Promise<void> {
  const { execSync, spawn: spawnProc } = require("child_process");
  
  // Check if Chrome already has CDP
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const data = await res.json() as { "User-Agent"?: string };
      if (!data["User-Agent"]?.includes("Headless")) {
        console.log("Your Chrome is already connected with CDP on port 9222.");
        console.log("Browse commands will use your real browser with all your sessions.");
        return;
      }
    }
  } catch { /* not running */ }

  // Kill any Kuri-managed Chrome
  try { execSync("pkill -f kuri/chrome-profile", { stdio: "ignore" }); } catch {}

  // Quit Chrome fully — can't add debugging port to running instance
  console.log("Quitting Chrome to relaunch with remote debugging...");
  if (process.platform === "darwin") {
    try { execSync('osascript -e "quit app \\"Google Chrome\\""', { stdio: "ignore", timeout: 5000 }); } catch {}
  } else {
    try { execSync("pkill -f chrome", { stdio: "ignore" }); } catch {}
  }
  await new Promise(r => setTimeout(r, 2000));

  console.log("Launching Chrome with remote debugging on port 9222...");
  if (process.platform === "darwin") {
    spawnProc("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", 
      ["--remote-debugging-port=9222", "--no-first-run", "--no-default-browser-check"],
      { stdio: "ignore", detached: true }).unref();
  } else {
    spawnProc("google-chrome", ["--remote-debugging-port=9222"], { stdio: "ignore", detached: true }).unref();
  }

  // Wait for CDP
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        console.log("Connected. Your real Chrome is now available for browse commands.");
        console.log("All your logged-in sessions (LinkedIn, X, etc.) will work.");
        console.log('Run: unbrowse go "https://linkedin.com/feed/"');
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  console.error("Could not connect to Chrome. Make sure all Chrome windows are closed and try again.");
}
async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv);
  const noAutoStart = !!flags["no-auto-start"];

  if (command === "help" || flags.help) {
    printHelp();
    process.exit(0);
  }

  if (command === "setup") {
    await cmdSetup(flags);
    return;
  }

  // Server lifecycle commands (don't need ensureLocalServer)
  if (command === "status") return cmdStatus(flags);
  if (command === "stop") { cmdStop(flags); return; }
  if (command === "restart") return cmdRestart(flags);
  if (command === "upgrade" || command === "update") return cmdUpgrade(flags);
  if (command === "connect-chrome") return cmdConnectChrome();

  // --- Shortcut resolution: unbrowse <site> [task] [flags] ---
  const KNOWN_COMMANDS = new Set([
    "health", "setup", "resolve", "execute", "exec",
    "feedback", "fb", "review", "publish", "login", "skills", "skill", "search", "sessions",
    "status", "stop", "restart", "upgrade", "update",
    "go", "submit", "snap", "click", "fill", "type", "press", "select", "scroll",
    "screenshot", "text", "markdown", "cookies", "eval", "back", "forward", "sync", "close",
    "connect-chrome",
  ]);

  if (!KNOWN_COMMANDS.has(command)) {
    const pack = findSitePack(command);
    if (pack) {
      await ensureLocalServer(BASE_URL, noAutoStart, import.meta.url);
      const taskName = args[0];
      if (!taskName || taskName === "help") {
        return cmdSiteHelp(pack, flags);
      }
      if (taskName === "login") {
        return cmdSiteLogin(pack, flags);
      }
      const batchArg = flags.batch as string | undefined;
      if (batchArg) {
        return cmdSiteBatch(pack, batchArg, flags);
      }
      return cmdSiteTask(pack, taskName, flags);
    }
  }

  await ensureLocalServer(BASE_URL, noAutoStart, import.meta.url);

  switch (command) {
    case "health": return cmdHealth(flags);
    case "setup": return cmdSetup(flags);
    case "resolve": return cmdResolve(flags);
    case "execute": case "exec": return cmdExecute(flags);
    case "feedback": case "fb": return cmdFeedback(flags);
    case "review": return cmdReview(flags);
    case "publish": return cmdPublish(flags);
    case "login": return cmdLogin(flags);
    case "skills": return cmdSkills(flags);
    case "skill": return cmdSkill(args, flags);
    case "search": return cmdSearch(flags);
    case "sessions": return cmdSessions(flags);
    // Browse commands — Kuri browser actions with passive indexing
    case "go": return cmdGo(args, flags);
    case "submit": return cmdSubmit(flags);
    case "snap": return cmdSnap(flags);
    case "click": return cmdClick(args);
    case "fill": return cmdFill(args);
    case "type": return cmdType(args);
    case "press": return cmdPress(args);
    case "select": return cmdSelect(args);
    case "scroll": return cmdScroll(args);
    case "screenshot": return cmdScreenshot(flags);
    case "text": return cmdText(flags);
    case "markdown": return cmdMarkdown(flags);
    case "cookies": return cmdCookies(flags);
    case "eval": return cmdEval(args, flags);
    case "back": return cmdBack();
    case "forward": return cmdForward();
    case "sync": return cmdSync(flags);
    case "close": return cmdClose();
    case "connect-chrome": return cmdConnectChrome();
    default: info(`Unknown command: ${command}`); printHelp(); process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main()
    .then(() => Promise.all([drainPendingIndexJobs(), drainPendingPassivePublishes()]))
    .catch((err) => {
      die((err as Error).message);
    });
}
