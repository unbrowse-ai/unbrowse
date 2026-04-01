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

/** Detect if an object contains a normalized entity array and build the index.
 *  Searches all top-level and one-level-nested arrays for entityUrn-keyed items,
 *  picking the largest qualifying array. Works for any normalized API shape. */
function detectEntityIndex(data: unknown): Map<string, unknown> | null {
  if (data == null || typeof data !== "object") return null;

  let best: unknown[] | null = null;

  const check = (arr: unknown[]) => {
    if (arr.length < 2) return;
    const sample = arr.slice(0, 10);
    const withUrn = sample.filter(
      (i) => i != null && typeof i === "object" && typeof (i as Record<string, unknown>).entityUrn === "string"
    ).length;
    if (withUrn >= sample.length * 0.5 && (!best || arr.length > best.length)) {
      best = arr;
    }
  };

  const obj = data as Record<string, unknown>;
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      check(val);
    } else if (val != null && typeof val === "object" && !Array.isArray(val)) {
      // One level deep: { data: { included: [...] } }, { response: { entities: [...] } }, etc.
      for (const nested of Object.values(val as Record<string, unknown>)) {
        if (Array.isArray(nested)) check(nested);
      }
    }
  }

  return best ? buildEntityIndex(best) : null;
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

    // URN reference resolution: if direct lookup fails (or is null), check for "*key" reference.
    // Normalized APIs (LinkedIn Voyager, Facebook Graph) set inline fields to null when
    // the value is stored as a URN reference: e.g. socialDetail: null + *socialDetail: "urn:li:..."
    if (val == null && entityIndex) {
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
 *  When processing arrays, rows where ALL extracted fields are null/undefined/empty are dropped.
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
      const resolved = resolvePath(item, path, entityIndex ?? undefined) ?? [];
      // Unwrap single-element arrays to scalar values
      out[alias] = Array.isArray(resolved)
        ? resolved.length === 0
          ? null
          : resolved.length === 1
            ? resolved[0]
            : resolved
        : resolved;
    }
    return out;
  }

  /** Check if a value is "present" (non-null, non-empty) */
  function hasValue(v: unknown): boolean {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }

  if (Array.isArray(data)) {
    return data.map(mapItem).filter((row) => Object.values(row).some(hasValue));
  }
  return mapItem(data);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulValue(item));
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some((item) => hasMeaningfulValue(item));
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isScalarLike(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((item) => item == null || typeof item === "string" || typeof item === "number" || typeof item === "boolean");
  }
  return false;
}

function looksStructuredForDirectOutput(value: unknown): boolean {
  if (Array.isArray(value)) {
    const sample = value.filter(isPlainRecord).slice(0, 3);
    if (sample.length === 0) return false;
    const simpleRows = sample.filter((row) => {
      const keys = Object.keys(row);
      const scalarFields = Object.values(row).filter(isScalarLike).length;
      return keys.length > 0 && keys.length <= 20 && scalarFields >= 2;
    });
    return simpleRows.length >= Math.ceil(sample.length / 2);
  }

  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 20) return false;
  const scalarFields = Object.values(value).filter(isScalarLike).length;
  return scalarFields >= 2;
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

  // Server-side intent projection can already return clean rows while raw endpoint
  // hints still describe the pre-projection payload. Preserve the structured rows.
  if (looksStructuredForDirectOutput(obj.result)) {
    return slimTrace({ ...obj, extraction_hints: undefined, response_schema: undefined });
  }

  // No hints: can't auto-extract, return as-is (raw will be big but we have no better option)
  if (!hints) return obj;

  // High confidence only: medium confidence still too error-prone for first-try correctness.
  if (hints.confidence === "high") {
    const syntheticFlags: Record<string, string | boolean> = {};
    if (hints.path) syntheticFlags.path = hints.path;
    if (hints.fields.length > 0) syntheticFlags.extract = hints.fields.join(",");
    syntheticFlags.limit = "20";

    const extracted = applyTransforms(obj.result, syntheticFlags);
    if (!hasMeaningfulValue(extracted)) return wrapWithHints(obj);
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
  const explicitEndpointId = flags["endpoint-id"] as string | undefined;

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
    body.params = { ...(body.params as Record<string, unknown> ?? {}), ...JSON.parse(flags.params as string) };
  }
  if (flags["dry-run"]) body.dry_run = true;
  if (flags["force-capture"]) body.force_capture = true;
  // Always get raw data — agent handles extraction via --path/--extract
  const hasTransforms = !!(flags.path || flags.extract);
  body.projection = { raw: true };

  const startedAt = Date.now();
  let result = await withPendingNotice(
    api("POST", "/v1/intent/resolve", body) as Promise<Record<string, unknown>>,
    "Still working. First-time capture/indexing for a site can take 20-80s. Waiting is usually better than falling back.",
  );

  // When agent explicitly picked an endpoint but resolve deferred, execute it directly
  if (explicitEndpointId && result.available_endpoints) {
    const skillId = (result.skill as Record<string, unknown>)?.skill_id as string
      ?? (result as Record<string, unknown>).skill_id as string;
    if (skillId) {
      const execBody: Record<string, unknown> = {
        params: { endpoint_id: explicitEndpointId, ...(flags.params ? JSON.parse(flags.params as string) : {}) },
        intent,
        projection: { raw: true },
      };
      result = await withPendingNotice(
        api("POST", `/v1/skills/${skillId}/execute`, execBody) as Promise<Record<string, unknown>>,
        "Executing selected endpoint...",
      );
    }
  }

  if (Date.now() - startedAt > 3_000 && result.source === "live-capture") {
    info("Live capture finished. Future runs against this site should be much faster.");
  }

  // --schema: return only schema + extraction hints (no data)
  if (flags.schema) {
    output(schemaOnly(result), !!flags.pretty);
    return;
  }

  // --path / --extract / --limit: transform .result in-place
  if (hasTransforms && result.result != null) {
    result = slimTrace({ ...result, result: applyTransforms(result.result, flags) });
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
  if (flags.url) {
    body.context_url = flags.url;
    (body.params as Record<string, unknown>).url = flags.url;
  }
  if (flags.intent) body.intent = flags.intent;
  if (flags["dry-run"]) body.dry_run = true;
  if (flags["confirm-unsafe"]) body.confirm_unsafe = true;
  // Always get raw data — agent handles extraction via --path/--extract
  const hasTransforms = !!(flags.path || flags.extract);
  body.projection = { raw: true };

  let result = await withPendingNotice(
    api("POST", `/v1/skills/${skillId}/execute`, body) as Promise<Record<string, unknown>>,
    "Still working. This endpoint may require browser replay or first-time auth/capture setup.",
  );

  // --schema: return only schema + extraction hints (no data)
  if (flags.schema) {
    output(schemaOnly(result), !!flags.pretty);
    return;
  }

  // --path / --extract / --limit: transform .result in-place
  if (hasTransforms && result.result != null) {
    result = slimTrace({ ...result, result: applyTransforms(result.result, flags) });
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
  const hasTransforms = !!(flags.path || flags.extract);
  if (flags.raw || hasTransforms) body.projection = { raw: true };

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

  if (flags.schema) {
    output(schemaOnly(result), !!flags.pretty);
    return;
  }

  if (hasTransforms && result.result != null) {
    result = slimTrace({ ...result, result: applyTransforms(result.result, flags) });
  } else if (!flags.raw && result.result != null) {
    result = autoExtractOrWrap(result);
  }

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
      const hasTransforms = !!(flags.path || flags.extract);
      if (flags.raw || hasTransforms) body.projection = { raw: true };
      let res = await api("POST", "/v1/intent/resolve", body) as Record<string, unknown>;
      if (!flags.raw && res.result != null) {
        res = autoExtractOrWrap(res);
      }
      return { task, result: res };
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

  // --- Shortcut resolution: unbrowse <site> [task] [flags] ---
  const KNOWN_COMMANDS = new Set([
    "health", "setup", "resolve", "execute", "exec",
    "feedback", "fb", "login", "skills", "skill", "search", "sessions",
    "status", "stop", "restart", "upgrade", "update",
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
    case "login": return cmdLogin(flags);
    case "skills": return cmdSkills(flags);
    case "skill": return cmdSkill(args, flags);
    case "search": return cmdSearch(flags);
    case "sessions": return cmdSessions(flags);
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
