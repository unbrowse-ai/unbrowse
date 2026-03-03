#!/usr/bin/env bun
/**
 * Unbrowse CLI — shell-safe wrapper for the local API.
 * Eliminates curl + jq escaping issues. All JSON is constructed
 * and parsed in TypeScript, never through shell interpolation.
 *
 * Usage: unbrowse <command> [flags]
 */

import { maybeAutoUpdate } from "./auto-update.js";

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
// Path resolution — drill into nested structures with [] array expansion
// ---------------------------------------------------------------------------

/** Build entityUrn → object index for normalized APIs (LinkedIn, Facebook, etc.) */
function buildEntityIndex(items: unknown[]): Map<string, unknown> {
  const index = new Map<string, unknown>();
  for (const item of items) {
    if (item != null && typeof item === "object") {
      const urn = (item as Record<string, unknown>).entityUrn;
      if (typeof urn === "string") index.set(urn, item);
    }
  }
  return index;
}

/** Detect if an object contains a normalized entity array and build the index. */
function detectEntityIndex(data: unknown): Map<string, unknown> | null {
  if (data == null || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  // Check common locations: { included: [...] }, { data: { included: [...] } }
  const candidates: unknown[][] = [];
  if (Array.isArray(obj.included)) candidates.push(obj.included);
  if (obj.data && typeof obj.data === "object") {
    const d = obj.data as Record<string, unknown>;
    if (Array.isArray(d.included)) candidates.push(d.included);
  }

  for (const arr of candidates) {
    if (arr.length < 2) continue;
    const sample = arr.slice(0, 5);
    const withUrn = sample.filter(
      (i) => i != null && typeof i === "object" && typeof (i as Record<string, unknown>).entityUrn === "string"
    ).length;
    if (withUrn >= sample.length * 0.5) return buildEntityIndex(arr);
  }
  return null;
}

/** Resolve a dot-path like "data.items[].name" against an object.
 *  When entityIndex is provided, transparently follows *-prefixed URN references. */
function resolvePath(obj: unknown, path: string, entityIndex?: Map<string, unknown> | null): unknown {
  if (!path || obj == null) return obj;
  const segments = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < segments.length; i++) {
    if (cur == null) return undefined;
    const seg = segments[i];
    if (seg.endsWith("[]")) {
      const key = seg.slice(0, -2);
      const arr = key ? (cur as Record<string, unknown>)[key] : cur;
      if (!Array.isArray(arr)) return undefined;
      const remaining = segments.slice(i + 1).join(".");
      if (!remaining) return arr;
      return arr.flatMap((item) => {
        const v = resolvePath(item, remaining, entityIndex);
        return v === undefined ? [] : Array.isArray(v) ? v : [v];
      });
    }
    const rec = cur as Record<string, unknown>;
    let val = rec[seg];

    // URN reference resolution: if direct lookup fails, check for "*key" reference
    if (val === undefined && entityIndex) {
      const ref = rec[`*${seg}`];
      if (typeof ref === "string") {
        val = entityIndex.get(ref);
      }
    }

    cur = val;
  }
  return cur;
}

/** Apply --extract fields to data. Each field is "alias:deep.path" or just "field".
 *  When processing arrays, rows where ALL extracted fields are null/undefined are dropped.
 *  This handles decorator-pattern APIs (e.g. LinkedIn included[]) where heterogeneous
 *  item types coexist and only some items match the requested fields. */
function extractFields(data: unknown, fields: string[], entityIndex?: Map<string, unknown> | null): unknown {
  if (data == null) return data;

  function mapItem(item: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const colonIdx = f.indexOf(":");
      const alias = colonIdx >= 0 ? f.slice(0, colonIdx) : f.split(".").pop()!;
      const path = colonIdx >= 0 ? f.slice(colonIdx + 1) : f;
      out[alias] = resolvePath(item, path, entityIndex);
    }
    return out;
  }

  if (Array.isArray(data)) {
    return data.map(mapItem).filter((row) => Object.values(row).some((v) => v != null));
  }
  return mapItem(data);
}

/** Apply --path, --extract, --limit to a result object. */
function applyTransforms(result: unknown, flags: Record<string, string | boolean>): unknown {
  let data = result;

  // Build entity index from the full response before drilling into it
  const entityIndex = detectEntityIndex(result);

  // --path: drill into nested structure
  const pathFlag = flags.path as string | undefined;
  if (pathFlag) {
    data = resolvePath(data, pathFlag, entityIndex);
    if (data === undefined) {
      // Path didn't match — warn so the user knows to fix it
      process.stderr.write(`[unbrowse] warning: --path "${pathFlag}" resolved to undefined. Check path against response structure.\n`);
      return [];
    }
  }

  // --extract: pick specific fields (with entity index for URN resolution)
  const extractFlag = flags.extract as string | undefined;
  if (extractFlag) {
    const fields = extractFlag.split(",").map((f) => f.trim());
    data = extractFields(data, fields, entityIndex);
  }

  // --limit: cap array output
  const limitFlag = flags.limit as string | undefined;
  if (limitFlag && Array.isArray(data)) {
    data = data.slice(0, Number(limitFlag));
  }

  return data;
}

/** Slim down output when transforms are applied — keep only essential trace metadata
 *  and drop the response_schema (it's noise once extraction is done). */
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
  // Carry over result (even if empty array — don't silently drop it)
  if ("result" in obj) out.result = obj.result;
  // Keep extraction_hints — agents need them for --path/--extract guidance
  if (obj.extraction_hints) out.extraction_hints = obj.extraction_hints;
  return out;
}

/** When a response is large and has extraction_hints, replace the full result
 *  with a compact summary + the hints so agents know how to extract. */
function wrapWithHints(obj: Record<string, unknown>): Record<string, unknown> {
  const hints = obj.extraction_hints as { path: string; fields: string[]; item_field_count: number; confidence: string; cli_args?: string; schema_tree?: Record<string, string> } | undefined;
  if (!hints) return obj;

  const resultStr = JSON.stringify(obj.result ?? "");
  // Only wrap when response is large enough that raw output would overwhelm context
  if (resultStr.length < 2000) return obj;

  const trace = obj.trace as Record<string, unknown> | undefined;

  return {
    trace: trace
      ? {
          trace_id: trace.trace_id,
          skill_id: trace.skill_id,
          endpoint_id: trace.endpoint_id,
          success: trace.success,
          status_code: trace.status_code,
        }
      : undefined,
    _response_too_large: `${resultStr.length} bytes — use extraction flags below to get structured data`,
    extraction_hints: hints,
  };
}

/** When --schema is used, return only the schema tree + extraction hints */
function schemaOnly(obj: Record<string, unknown>): Record<string, unknown> {
  const trace = obj.trace as Record<string, unknown> | undefined;
  return {
    trace: trace
      ? { trace_id: trace.trace_id, skill_id: trace.skill_id, endpoint_id: trace.endpoint_id, success: trace.success }
      : undefined,
    extraction_hints: obj.extraction_hints ?? null,
    response_schema: obj.response_schema ?? null,
  };
}

/** Auto-extract when hints have high confidence, otherwise wrap with hints.
 *  This is the "right first try" path — agents get clean data without a second call. */
function autoExtractOrWrap(obj: Record<string, unknown>): Record<string, unknown> {
  const hints = obj.extraction_hints as { path: string; fields: string[]; confidence: string; cli_args?: string; schema_tree?: Record<string, string> } | undefined;
  const resultStr = JSON.stringify(obj.result ?? "");

  // Small responses: return as-is
  if (resultStr.length < 2000) return obj;

  // No hints: can't auto-extract, return as-is (raw will be big but we have no better option)
  if (!hints) return obj;

  // High/medium confidence: auto-apply extraction
  if (hints.confidence === "high" || hints.confidence === "medium") {
    const syntheticFlags: Record<string, string | boolean> = {};
    if (hints.path) syntheticFlags.path = hints.path;
    if (hints.fields.length > 0) syntheticFlags.extract = hints.fields.join(",");
    syntheticFlags.limit = "20";

    const extracted = applyTransforms(obj.result, syntheticFlags);
    const slimmed = slimTrace({ ...obj, result: extracted });

    // Include the hints so the agent knows what was auto-applied and can adjust
    (slimmed as Record<string, unknown>)._auto_extracted = {
      applied: hints.cli_args,
      confidence: hints.confidence,
      all_fields: hints.schema_tree,
      note: "Auto-extracted using response_schema. Add/remove fields with --extract, change array with --path, or use --raw for full response.",
    };
    return slimmed;
  }

  // Low confidence: wrap with hints, let agent decide
  return wrapWithHints(obj);
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
  // When explicit CLI transforms are present, get raw data for client-side extraction
  const hasTransforms = !!(flags.path || flags.extract);
  if (flags.raw || hasTransforms) body.projection = { raw: true };

  let result = await api("POST", "/v1/intent/resolve", body) as Record<string, unknown>;

  // --schema: return only schema + extraction hints (no data)
  if (flags.schema) {
    output(schemaOnly(result), !!flags.pretty);
    return;
  }

  // --path / --extract / --limit: transform .result in-place
  if (hasTransforms && result.result != null) {
    result = slimTrace({ ...result, result: applyTransforms(result.result, flags) });
  } else if (!flags.raw && result.result != null) {
    // No transforms requested — try auto-extraction from hints
    result = autoExtractOrWrap(result);
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
  // When explicit CLI transforms are present, get raw data for client-side extraction
  const hasTransforms = !!(flags.path || flags.extract);
  if (flags.raw || hasTransforms) body.projection = { raw: true };

  let result = await api("POST", `/v1/skills/${skillId}/execute`, body) as Record<string, unknown>;

  // --schema: return only schema + extraction hints (no data)
  if (flags.schema) {
    output(schemaOnly(result), !!flags.pretty);
    return;
  }

  // --path / --extract / --limit: transform .result in-place
  if (hasTransforms && result.result != null) {
    result = slimTrace({ ...result, result: applyTransforms(result.result, flags) });
  } else if (!flags.raw && result.result != null) {
    // No transforms requested — try auto-extraction from hints
    result = autoExtractOrWrap(result);
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

async function cmdSessions(flags: Record<string, string | boolean>): Promise<void> {
  const domain = flags.domain as string;
  if (!domain) die("--domain is required");
  const limit = flags.limit ?? "10";
  output(await api("GET", `/v1/sessions/${domain}?limit=${limit}`), !!flags.pretty);
}

// ---------------------------------------------------------------------------
// CLI Reference — single source of truth for help text AND SKILL.md
// ---------------------------------------------------------------------------

export const CLI_REFERENCE = {
  commands: [
    { name: "health", usage: "", desc: "Server health check" },
    { name: "resolve", usage: '--intent "..." --url "..." [opts]', desc: "Resolve intent \u2192 search/capture/execute" },
    { name: "execute", usage: "--skill ID --endpoint ID [opts]", desc: "Execute a specific endpoint" },
    { name: "feedback", usage: "--skill ID --endpoint ID --rating N", desc: "Submit feedback (mandatory after resolve)" },
    { name: "login", usage: '--url "..."', desc: "Interactive browser login" },
    { name: "skills", usage: "", desc: "List all skills" },
    { name: "skill", usage: "<id>", desc: "Get skill details" },
    { name: "search", usage: '--intent "..." [--domain "..."]', desc: "Search marketplace" },
    { name: "sessions", usage: '--domain "..." [--limit N]', desc: "Debug session logs" },
  ],
  globalFlags: [
    { flag: "--pretty", desc: "Indented JSON output" },
    { flag: "--no-auto-start", desc: "Don't auto-start server" },
    { flag: "--raw", desc: "Return raw response data (skip server-side projection)" },
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
    'unbrowse resolve --intent "get timeline" --url "https://x.com"',
    "unbrowse execute --skill abc --endpoint def --pretty",
    'unbrowse execute --skill abc --endpoint def --extract "user,text,likes" --limit 10',
    'unbrowse execute --skill abc --endpoint def --path "data.included[]" --extract "name:actor.name,text:commentary.text" --limit 20',
    "unbrowse feedback --skill abc --endpoint def --rating 5",
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

  lines.push("");
  process.stderr.write(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  maybeAutoUpdate();

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
    case "sessions": return cmdSessions(flags);
    default: info(`Unknown command: ${command}`); printHelp(); process.exit(1);
  }
}

// Only run when this file is the entry point (not when imported by sync script etc.)
if (import.meta.main !== false) {
  main().catch((err) => {
    die((err as Error).message);
  });
}
