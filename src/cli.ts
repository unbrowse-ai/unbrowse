#!/usr/bin/env bun
/**
 * Unbrowse CLI — shell-safe wrapper for the local API.
 * Eliminates curl + jq escaping issues. All JSON is constructed
 * and parsed in TypeScript, never through shell interpolation.
 *
 * Usage: unbrowse <command> [flags]
 */

import { config as loadEnv } from "dotenv";
import { spawn } from "node:child_process";
import {
  detectTelemetryHostType,
  ensureCliInstallTracked,
  ensureRegistered,
  fetchAccountPreferences,
  getAgentId,
  getApiKey,
  getCreatorEarnings,
  getFlywheelPulse,
  getMyProfile,
  getTransactionHistory,
  loadConfig,
  magicRegister,
  pushAccountPreferences,
  recordFunnelTelemetryEvent,
  recordInstallTelemetryEvent,
  saveConfig,
} from "./client/index.js";
import { appendImpact, getImpactLogPath, impactFromResult, readImpactSummary } from "./impact-log.js";
import { findSitePack, findTask, allSitePacks, buildDepsGraph, planExecution, buildDepsMetadata, type SitePack } from "./cli/shortcuts.js";
import { ensureLocalServer, checkServerVersion, stopServer, restartServer } from "./runtime/local-server.js";
import { isBundledVirtualEntrypoint, isMainModule, resolveSiblingEntrypoint, runtimeArgsForEntrypoint } from "./runtime/paths.js";
import { drainPendingIndexJobs } from "./indexer/index.js";
import { drainPendingPassivePublishes } from "./orchestrator/passive-publish.js";
import { runSetup, type SetupReport, type SetupScope } from "./runtime/setup.js";
import { checkForUpdates, recordUpdateHint } from "./runtime/update-hints.js";
import { promptContributionMode, maybeShowContributionNotice } from "./cli-setup.js";
import { getContributionConfig, setContributionConfig } from "./config/contribution.js";

loadEnv({ quiet: true });
loadEnv({ path: ".env.runtime", quiet: true });

const BASE_URL = process.env.UNBROWSE_URL || "http://localhost:6969";
const CLI_CLIENT_ID = process.env.UNBROWSE_CLIENT_ID || `cli-${process.ppid || process.pid}`;
let walletNudgeShown = false;

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean>; params: Record<string, string> } {
  const raw = argv.slice(2); // skip runtime + script
  const command = raw[0] && !raw[0].startsWith("--") ? raw[0] : "help";
  const rest = command === "help" ? raw : raw.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const params: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-p" || a === "--param") {
      const next = rest[i + 1];
      if (next && next.includes("=")) {
        const eq = next.indexOf("=");
        params[next.slice(0, eq)] = next.slice(eq + 1);
        i++;
      } else {
        die(`-p requires key=value, got: ${next ?? "<end of args>"}`);
      }
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      // Flags that always consume the next arg as their value (even if it
      // starts with -- because nanoid IDs can begin with `-` / `--`).
      const valueExpectedFlags = new Set(["skill", "endpoint", "intent", "url", "domain", "params", "path", "extract", "limit"]);
      if (valueExpectedFlags.has(key)) {
        // Don't consume the next arg if it's clearly another flag (-p, --foo).
        // nanoid IDs may start with `-` but never `-p` or `--`.
        if (next === undefined) die(`--${key} requires a value`);
        if (next === "-p" || next === "--param" || next.startsWith("--")) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      } else if (!next || next.startsWith("--") || next === "-p" || next === "--param") {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, args: positional, flags, params };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api(method: string, path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
  let target = `${BASE_URL}${path}`;
  let requestBody = body;
  if (method === "GET" && body && typeof body === "object") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        params.set(key, String(value));
      }
    }
    const query = params.toString();
    if (query) target += `${target.includes("?") ? "&" : "?"}${query}`;
    requestBody = undefined;
  }
  const ctrl = new AbortController();
  const timeoutMs = opts?.timeoutMs;
  const timer = typeof timeoutMs === "number" && timeoutMs > 0
    ? setTimeout(() => ctrl.abort(), timeoutMs)
    : null;
  let res: Response;
  try {
    res = await fetch(target, {
      method,
      headers: {
        ...(requestBody ? { "Content-Type": "application/json" } : {}),
        "x-unbrowse-client-id": CLI_CLIENT_ID,
      },
      body: requestBody ? JSON.stringify(requestBody) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if ((err as Error)?.name === "AbortError") {
      return {
        error: "cli_timeout",
        message: `CLI gave up waiting on local server after ${timeoutMs}ms. Try: pkill -9 -f 'unbrowse|kuri'`,
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
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

function resolveResultError(result: Record<string, unknown>): string | undefined {
  return (result.result as Record<string, unknown> | undefined)?.error as string | undefined
    ?? result.error as string | undefined;
}

function resolveLoginUrl(result: Record<string, unknown>, fallbackUrl?: string): string {
  return (result.result as Record<string, unknown> | undefined)?.login_url as string
    ?? fallbackUrl
    ?? "";
}

function isResolveSuccessResult(result: Record<string, unknown>): boolean {
  if (resolveResultError(result)) return false;
  return !!result.result || Array.isArray(result.available_endpoints);
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
          ...(typeof trace.error === "string" ? { error: trace.error } : {}),
          ...(trace.schema_backfilled ? { schema_backfilled: true } : {}),
        }
      : undefined,
  };
  if (typeof obj.error === "string") out.error = obj.error;
  if (typeof obj.message === "string") out.message = obj.message;
  if (typeof obj.hint === "string") out.hint = obj.hint;
  if (typeof obj.login_url === "string") out.login_url = obj.login_url;
  if (typeof obj.provider === "string") out.provider = obj.provider;
  if ("result" in obj) out.result = obj.result;
  if (Array.isArray(obj.decision_trace)) out.decision_trace = obj.decision_trace;
  if (obj.available_endpoints) out.available_endpoints = obj.available_endpoints;
  if (obj.impact) out.impact = obj.impact;
  if (obj.next_actions) out.next_actions = obj.next_actions;
  if (obj.next_step) out.next_step = obj.next_step;
  if (obj.source) out.source = obj.source;
  if (obj.skill) out.skill = obj.skill;
  return out;
}

function formatSavedDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatCostUsd(uc: number): string {
  // uc = micro-USD (1e-6 USD). 1M uc = $1.
  const usd = uc / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function emitImpactSummary(result: Record<string, unknown>): void {
  const impact = result.impact as Record<string, unknown> | undefined;
  if (!impact) return;

  const timeSavedMs = typeof impact.time_saved_ms === "number" ? impact.time_saved_ms : 0;
  const tokensSaved = typeof impact.tokens_saved === "number" ? impact.tokens_saved : 0;
  const timeSavedPct = typeof impact.time_saved_pct === "number" ? impact.time_saved_pct : 0;
  const tokensSavedPct = typeof impact.tokens_saved_pct === "number" ? impact.tokens_saved_pct : 0;
  const costSavedUc = typeof impact.cost_saved_uc === "number" ? impact.cost_saved_uc : 0;
  const browserAvoided = impact.browser_avoided === true;
  if (timeSavedMs <= 0 && tokensSaved <= 0 && costSavedUc <= 0 && !browserAvoided) return;

  const parts: string[] = [];
  if (timeSavedMs > 0) parts.push(`${formatSavedDuration(timeSavedMs)} saved (${timeSavedPct}% faster)`);
  if (tokensSaved > 0) parts.push(`${tokensSaved.toLocaleString("en-US")} tokens saved (${tokensSavedPct}% less context)`);
  if (costSavedUc > 0) parts.push(`${formatCostUsd(costSavedUc)} saved`);
  if (browserAvoided) parts.push("browser avoided");
  info(parts.join(" • "));
}

function emitNextActionSummary(result: Record<string, unknown>): void {
  const nextActions = Array.isArray(result.next_actions)
    ? result.next_actions as Array<Record<string, unknown>>
    : [];
  if (nextActions.length === 0) return;
  info("Likely next actions:");
  for (const action of nextActions.slice(0, 3)) {
    const command = typeof action.command === "string" ? action.command : "";
    const title = typeof action.title === "string" ? action.title : (action.endpoint_id as string | undefined) ?? "next step";
    const why = typeof action.why === "string" ? action.why : "";
    info(`  ${command || title}${why ? `  # ${why}` : ""}`);
  }
}


async function cmdHealth(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("GET", "/health"), !!flags.pretty);
}

function telemetryDomainFromInput(domain?: string, url?: string): string | null {
  if (domain?.trim()) return domain.trim().replace(/^www\./, "");
  if (!url?.trim()) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}


async function cmdExplain(flags: Record<string, string | boolean>): Promise<void> {
  const intent = flags.intent as string | undefined;
  const url = flags.url as string | undefined;
  const top = parseInt((flags.top as string) ?? "5", 10) || 5;
  if (!intent || !url) {
    process.stderr.write("usage: unbrowse explain --intent \"...\" --url \"...\" [--top N]\n");
    process.exit(2);
  }
  const body: Record<string, unknown> = {
    intent,
    params: { url },
    context: { url },
    projection: { raw: true },
  };
  let result: Record<string, unknown>;
  try {
    result = (await api("POST", "/v1/intent/resolve", body)) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`explain failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const r = (result.result as Record<string, unknown>) ?? result;
  const ae = (r.available_endpoints as Array<Record<string, unknown>> | undefined) ?? [];
  const ao = (r.available_operations as Array<Record<string, unknown>> | undefined) ?? [];
  const out = {
    intent,
    context_url: url,
    diagnostic: r.diagnostic,
    shortlist_for_judgment: ae.slice(0, top).map((ep, i) => ({
      rank: i,
      endpoint_id: ep.endpoint_id,
      method: ep.method,
      url: ep.url,
      score: ep.score,
      description: ep.description,
      input_params: ep.input_params,
      schema_summary: ep.schema_summary,
      example_fields: ep.example_fields,
      sample_values: ep.sample_values,
      needs_params: ep.needs_params,
      trigger_url: ep.trigger_url,
    })),
    agent_facing_shortlist: ao.slice(0, top).map((op, i) => ({
      rank: i,
      endpoint_id: op.endpoint_id,
      method: op.method,
      url_template: op.url_template ?? op.url,
      description: op.description_out ?? op.description,
    })),
    judgment_question:
      `Given the intent ${JSON.stringify(intent)} on ${JSON.stringify(url)}, ` +
      `which of the candidate endpoints in shortlist_for_judgment best satisfies the intent? ` +
      `Reply with the endpoint_id of the best match and a one-line reason. ` +
      `If none match, say defer_to_capture.`,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

async function cmdResolve(flags: Record<string, string | boolean>): Promise<void> {
  const intent = flags.intent as string;
  if (!intent) die("--intent is required");
  maybeShowContributionNotice();
  const hostType = detectTelemetryHostType();
  await ensureCliInstallTracked(hostType);
  await recordFunnelTelemetryEvent("cli_invoked", {
    source: "cli",
    hostType,
    properties: { command: "resolve" },
  });
  await recordFunnelTelemetryEvent("resolve_started", {
    source: "cli",
    hostType,
    properties: {
      command: "resolve",
      intent,
      domain: telemetryDomainFromInput(flags.domain as string | undefined, flags.url as string | undefined),
      url: typeof flags.url === "string" ? flags.url : null,
      has_url: typeof flags.url === "string",
      has_domain: typeof flags.domain === "string",
      auto_execute: !!flags.execute,
    },
  });

  try {
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
    if (flags["confirm-third-party-terms"]) body.confirm_third_party_terms = true;
    if (flags["force-capture"]) body.force_capture = true;
    if (flags["skip-robots"]) body.skip_robots_check = true;
    // Phase 8.1 — per-call latency budget for the parallel resolve race.
    // Default 8000ms when unset; sub-probe values (<200ms) return no_match fast.
    const budgetFlag = flags.budget;
    if (typeof budgetFlag === "string") {
      const parsed = parseInt(budgetFlag, 10);
      if (Number.isFinite(parsed) && parsed > 0) body.budget_ms = parsed;
    } else if (typeof budgetFlag === "number" && Number.isFinite(budgetFlag) && (budgetFlag as number) > 0) {
      body.budget_ms = budgetFlag as number;
    }
    body.projection = { raw: true };

    function execBody(endpointId: string): Record<string, unknown> {
      return {
        params: { endpoint_id: endpointId, ...extraParams },
        intent,
        projection: { raw: true },
        ...(flags["confirm-third-party-terms"] ? { confirm_third_party_terms: true } : {}),
        ...(flags["skip-robots"] ? { skip_robots_check: true } : {}),
      };
    }

    function endpointNeedsThirdPartyTermsConfirmation(endpoint: Record<string, unknown>): boolean {
      return endpoint.requires_third_party_terms_confirmation === true;
    }

    function resolveSkillId(): string | undefined {
      return (result.skill as Record<string, unknown>)?.skill_id as string
        ?? (result as Record<string, unknown>).skill_id as string;
    }

    const startedAt = Date.now();
    async function resolveOnce(message = "Still working. Searching cached routes..."): Promise<Record<string, unknown>> {
      // CLI guard: never wait longer than budget + 30s slack on the local
      // daemon. Fixes silent hangs where pkill races with daemon startup.
      const cliTimeoutMs = (typeof body.budget_ms === "number" ? body.budget_ms : 8000) + 30_000;
      return withPendingNotice(
        api("POST", "/v1/intent/resolve", body, { timeoutMs: cliTimeoutMs }) as Promise<Record<string, unknown>>,
        message,
      );
    }

    let result = await resolveOnce();
    const resultError = resolveResultError(result);
    if (resultError === "auth_required") {
      const loginUrl = resolveLoginUrl(result, url);
      if (loginUrl) info(`Authentication required. Run: unbrowse login --url "${loginUrl}"`);
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
        // Policy gate: never auto-execute a third-party-terms-flagged endpoint
        // without explicit confirmation. The agent must opt in via
        // --confirm-third-party-terms after reading the policy.
        if (
          endpointNeedsThirdPartyTermsConfirmation(bestEndpoint) &&
          !flags["confirm-third-party-terms"]
        ) {
          process.stderr.write(
            `Skipping auto-execute: endpoint ${bestEndpoint.endpoint_id ?? "?"} ` +
            `requires explicit third-party terms confirmation. ` +
            `Re-run with --confirm-third-party-terms to proceed.\n`,
          );
        } else {
          info(`Auto-executing endpoint: ${bestEndpoint.description ?? bestEndpoint.endpoint_id}`);
          result = await withPendingNotice(
            api("POST", `/v1/skills/${skillId}/execute`, execBody(bestEndpoint.endpoint_id as string)) as Promise<Record<string, unknown>>,
            "Executing best endpoint...",
          );
        }
      }
    }

    if (Date.now() - startedAt > 3_000 && result.source === "live-capture") {
      info("Live capture finished. Future runs against this site should be much faster.");
    }

    if (isResolveSuccessResult(result)) {
      await recordFunnelTelemetryEvent("resolve_completed", {
        source: "cli",
        hostType,
        properties: {
          command: "resolve",
          intent,
          domain: telemetryDomainFromInput(domain, url),
          url: url ?? null,
          source: result.source,
          auto_execute: autoExecute,
          explicit_endpoint: explicitEndpointId ?? null,
        },
      });
    }

    result = slimTrace(result);
    emitImpactSummary(result);
    {
      const entry = impactFromResult("resolve", result, { intent, domain, });
      if (entry) appendImpact(entry);
    }
    emitNextActionSummary(result);

    const skill = result.skill as Record<string, unknown> | undefined;
    const trace = result.trace as Record<string, unknown> | undefined;

    // Nudge wallet setup after successful resolve that indexed routes
    if (trace?.success && !walletNudgeShown) {
      try {
        const { checkWalletConfigured } = await import("./payments/wallet.js");
        const wallet = checkWalletConfigured();
        if (!wallet.configured) {
          info("No payout wallet — you won't earn when others reuse your routes. Run: npx @crossmint/lobster-cli setup");
          walletNudgeShown = true;
        }
      } catch (_e) { /* non-fatal */ }
    }

    if (skill?.skill_id && trace) {
      (result as Record<string, unknown>)._feedback = `unbrowse feedback --skill ${skill.skill_id} --endpoint ${trace.endpoint_id || "?"} --rating <1-5>`;
    }

    output(result, !!flags.pretty);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordFunnelTelemetryEvent("resolve_failed", {
      source: "cli",
      hostType,
      properties: {
        command: "resolve",
        intent,
        domain: telemetryDomainFromInput(flags.domain as string | undefined, flags.url as string | undefined),
        url: typeof flags.url === "string" ? flags.url : null,
        failure_stage: "resolve",
        failure_reason: message,
      },
    });
    throw error;
  }
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
  maybeShowContributionNotice();
  const hostType = detectTelemetryHostType();
  await ensureCliInstallTracked(hostType);
  await recordFunnelTelemetryEvent("cli_invoked", {
    source: "cli",
    hostType,
    properties: { command: "execute" },
  });
  await recordFunnelTelemetryEvent("resolve_started", {
    source: "cli",
    hostType,
    properties: {
      command: "execute",
      intent: typeof flags.intent === "string" ? flags.intent : null,
      domain: telemetryDomainFromInput(undefined, flags.url as string | undefined),
      url: typeof flags.url === "string" ? flags.url : null,
      skill_id: skillId,
      endpoint_id: typeof flags.endpoint === "string" ? flags.endpoint : null,
    },
  });

  if (flags.curl) {
    die("--curl has been removed. Use `unbrowse execute` to run endpoints through Unbrowse.");
    return;
  }

  try {
    const body: Record<string, unknown> = { params: {} };
    if (flags.endpoint) {
      (body.params as Record<string, unknown>).endpoint_id = flags.endpoint;
    }
    if (flags.params) {
      body.params = { ...(body.params as Record<string, unknown>), ...JSON.parse(flags.params as string) };
    }
    // Merge -p key=val flags (parsed in parseArgs, stashed on flags._params).
    const cliKv = (flags as Record<string, unknown>)._params as Record<string, string> | undefined;
    if (cliKv && Object.keys(cliKv).length > 0) {
      body.params = { ...(body.params as Record<string, unknown>), ...cliKv };
    }
    if (flags.url) {
      body.context_url = flags.url;
      (body.params as Record<string, unknown>).url = flags.url;
    }
    if (flags.intent) body.intent = flags.intent;
    if (flags["dry-run"]) body.dry_run = true;
    if (flags["confirm-unsafe"]) body.confirm_unsafe = true;
    if (flags["confirm-third-party-terms"]) body.confirm_third_party_terms = true;
    if (flags["skip-robots"]) body.skip_robots_check = true;
    body.projection = { raw: true };

    let result = await withPendingNotice(
      api("POST", `/v1/skills/${skillId}/execute`, body) as Promise<Record<string, unknown>>,
      "Still working. This endpoint may require browser replay or first-time auth/capture setup.",
    );

    if (isResolveSuccessResult(result)) {
      await recordFunnelTelemetryEvent("resolve_completed", {
        source: "cli",
        hostType,
        properties: {
          command: "execute",
          intent: typeof flags.intent === "string" ? flags.intent : null,
          domain: telemetryDomainFromInput(undefined, flags.url as string | undefined),
          url: typeof flags.url === "string" ? flags.url : null,
          skill_id: skillId,
          endpoint_id: typeof flags.endpoint === "string" ? flags.endpoint : null,
        },
      });
    }

    // Strip metadata bloat
    result = slimTrace(result);
    emitImpactSummary(result);
    {
      const entry = impactFromResult("execute", result, {
        skill_id: skillId,
        endpoint_id: typeof flags.endpoint === "string" ? flags.endpoint : undefined,
      });
      if (entry) appendImpact(entry);
    }
    emitNextActionSummary(result);

    const pathFlag = flags.path as string | undefined;
    const extractFlag = flags.extract as string | undefined;
    const limitFlag = flags.limit ? Number(flags.limit) : undefined;
    const schemaFlag = !!flags.schema;
    const rawFlag = !!flags.raw;
    // --schema: show response structure without data
    if (schemaFlag && !rawFlag) {
      const data = result.result;
      output({
        trace: result.trace,
        schema: schemaOf(data),
        ...(result.impact ? { impact: result.impact } : {}),
        ...(result.next_actions ? { next_actions: result.next_actions } : {}),
      }, !!flags.pretty);
      return;
    }

    // Apply --path, --extract, --limit when not --raw
    if (!rawFlag && (pathFlag || extractFlag || limitFlag)) {
      const data = pathFlag ? drillPath(result.result, pathFlag) : result.result;

      // Ensure array for extract/limit
      const items = Array.isArray(data) ? data : data != null ? [data] : [];

      // Apply --extract
      const extracted = extractFlag ? applyExtract(items, extractFlag) : items;

      // Apply --limit
      const limited = limitFlag ? extracted.slice(0, limitFlag) : extracted;

      const trace = result.trace as Record<string, unknown> | undefined;
      const out: Record<string, unknown> = {
        trace: result.trace,
        data: limited,
        count: limited.length,
        ...(result.impact ? { impact: result.impact } : {}),
        ...(result.next_actions ? { next_actions: result.next_actions } : {}),
      };

      // Prompt agent to review when this is likely a first-time execute
      if (trace?.skill_id && trace?.endpoint_id && limited.length > 0) {
        out._review_hint =
          `After presenting results, review this endpoint's contract: description plus request/response schema notes where needed. Example: unbrowse review --skill ${trace.skill_id} --endpoints '[{"endpoint_id":"${trace.endpoint_id}","description":"DESCRIBE WHAT THIS RETURNS AND ANY IMPORTANT CONSTRAINTS","action_kind":"ACTION","resource_kind":"RESOURCE","parameter_reviews":[{"location":"query","name":"q","description":"Search query text","type":"string","required":true}],"response_reviews":[{"path":"items[].url","description":"Canonical result URL","type":"string"}]}]'`;
      }

      output(out, !!flags.pretty);
      return;
    }

    // Auto-wrap VERY-large responses with extraction_hints when no flags given.
    // Per CLAUDE.md Agent UX North Star "Works for what was asked: --raw is
    // the default truth" — agents calling execute with no flags expect data,
    // not a schema preview. The previous 2KB threshold was too aggressive: a
    // 30-row JSON list (~5KB) would fire extraction_hints, forcing the agent
    // to retry with --raw or --extract. Bumped to 64KB so only genuinely huge
    // responses (full HTML pages, mega-arrays) trigger the hint path.
    const AUTOEXTRACT_HINT_THRESHOLD = 65_536;
    if (!rawFlag && !pathFlag && !extractFlag && !schemaFlag) {
      const raw = JSON.stringify(result.result);
      if (raw && raw.length > AUTOEXTRACT_HINT_THRESHOLD) {
        const schema = schemaOf(result.result);
        output({
          trace: result.trace,
          ...(result.impact ? { impact: result.impact } : {}),
          ...(result.next_actions ? { next_actions: result.next_actions } : {}),
          extraction_hints: {
            message: `Response is ${Math.round(raw.length / 1024)}KB (over ${AUTOEXTRACT_HINT_THRESHOLD / 1024}KB). Use --path/--extract/--limit to filter, --schema for structure, or --raw for full response.`,
            schema_tree: schema,
            response_bytes: raw.length,
          },
        }, !!flags.pretty);
        return;
      }
    }

    output(result, !!flags.pretty);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordFunnelTelemetryEvent("resolve_failed", {
      source: "cli",
      hostType,
      properties: {
        command: "execute",
        intent: typeof flags.intent === "string" ? flags.intent : null,
        domain: telemetryDomainFromInput(undefined, flags.url as string | undefined),
        url: typeof flags.url === "string" ? flags.url : null,
        skill_id: skillId,
        failure_stage: "execute",
        failure_reason: message,
      },
    });
    throw error;
  }
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

async function cmdAnnotate(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  const endpointId = flags.endpoint as string;
  if (!skillId || !endpointId) die("--skill and --endpoint are required");

  const body: Record<string, unknown> = {};

  if (flags.text) {
    body.annotations = [{ text: flags.text as string }];
  }

  if (flags.constraint) {
    const parts = (flags.constraint as string).split(":");
    if (parts.length >= 3) {
      body.constraints = [{ param: parts[0], rule: parts[1], message: parts.slice(2).join(":") }];
    }
  }

  if (!body.annotations && !body.constraints) die("--text or --constraint required");

  output(await api("POST", `/v1/skills/${skillId}/endpoints/${endpointId}/annotate`, body), !!flags.pretty);
}
async function cmdReview(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");
  const endpointsJson = flags.endpoints as string;
  if (!endpointsJson) die("--endpoints is required (JSON array of {endpoint_id, description?, action_kind?, resource_kind?, parameter_reviews?, response_reviews?})");
  const endpoints = JSON.parse(endpointsJson) as Array<Record<string, unknown>>;
  if (!Array.isArray(endpoints) || endpoints.length === 0) die("--endpoints must be a non-empty JSON array");
  output(await api("POST", `/v1/skills/${skillId}/review`, { endpoints }), !!flags.pretty);
}

function parseCsvFlag(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [];
}

async function cmdIndex(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");
  output(await api("POST", `/v1/skills/${skillId}/index`, {}), !!flags.pretty);
}

async function cmdPublish(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");
  const endpointsJson = flags.endpoints as string | undefined;
  const confirmPublish = flags["confirm-publish"] === true;
  if (endpointsJson) {
    // Phase 2: merge descriptions + publish
    const endpoints = JSON.parse(endpointsJson) as Array<Record<string, unknown>>;
    if (!Array.isArray(endpoints) || endpoints.length === 0) die("--endpoints must be a non-empty JSON array");
    output(await api("POST", `/v1/skills/${skillId}/publish`, {
      endpoints,
      ...(confirmPublish ? { confirm_publish: true } : {}),
    }), !!flags.pretty);
  } else {
    // Phase 1: return endpoints needing descriptions
    output(await api("POST", `/v1/skills/${skillId}/publish`, {
      ...(confirmPublish ? { confirm_publish: true } : {}),
    }), !!flags.pretty);
  }
}

async function cmdPublishBundle(flags: Record<string, string | boolean>): Promise<void> {
  const presetPath = flags.preset as string;
  if (!presetPath) die("--preset is required");
  const hosts = typeof flags.hosts === "string"
    ? flags.hosts.split(",").map((host) => host.trim()).filter(Boolean)
    : undefined;
  output(await api("POST", "/v1/foundry/publish-bundle", {
    preset_path: presetPath,
    ...(typeof flags["site-url"] === "string" ? { site_url: flags["site-url"] } : {}),
    ...(hosts?.length ? { hosts } : {}),
  }), !!flags.pretty);
}

async function cmdSettings(flags: Record<string, string | boolean>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (typeof flags["auto-publish"] === "string") {
    const normalized = String(flags["auto-publish"]).trim().toLowerCase();
    if (normalized !== "on" && normalized !== "off") die("--auto-publish must be on or off");
    body.auto_publish_checkpoints = normalized === "on";
  }

  const blacklist = parseCsvFlag(flags["publish-blacklist"]);
  if (blacklist) body.publish_domain_blacklist = blacklist;
  const promptlist = parseCsvFlag(flags["publish-promptlist"]);
  if (promptlist) body.publish_domain_promptlist = promptlist;
  if (flags["clear-publish-blacklist"] === true) body.clear_publish_domain_blacklist = true;
  if (flags["clear-publish-promptlist"] === true) body.clear_publish_domain_promptlist = true;

  const hasMutation = Object.keys(body).length > 0;
  output(
    await api(hasMutation ? "POST" : "GET", "/v1/settings", hasMutation ? body : undefined),
    !!flags.pretty,
  );
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

async function cmdCleanupStale(flags: Record<string, string | boolean>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (typeof flags.skill === "string") body.skill_id = flags.skill;
  if (typeof flags.domain === "string") body.domain = flags.domain;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  output(
    await withPendingNotice(api("POST", "/v1/stale/cleanup", body), "Cleaning stale endpoints..."),
    !!flags.pretty,
  );
}

async function cmdSearch(flags: Record<string, string | boolean>): Promise<void> {
  // The `search` command emits funnel telemetry (search_started /
  // search_completed) so the agent acquisition story stays measurable.
  // cmdResolve also fires resolve_* under the hood — both events are recorded.
  const intent = flags.intent as string | undefined;
  const hostType = detectTelemetryHostType();
  const { decodeTelemetryAttribution } = await import("./telemetry-attribution.js");
  const attr = decodeTelemetryAttribution(process.env.UNBROWSE_ATTRIBUTION_B64) ?? {};
  const attrProps: Record<string, unknown> = {};
  for (const k of ["channel", "campaign_id", "content_id", "variant_id"] as const) {
    const v = (attr as Record<string, unknown>)[k];
    if (v != null) attrProps[k] = v;
  }
  const domain = telemetryDomainFromInput(flags.domain as string | undefined, flags.url as string | undefined);
  if (intent) {
    await recordFunnelTelemetryEvent("search_started", {
      source: "cli",
      hostType,
      properties: {
        command: "search",
        intent,
        domain,
        url: typeof flags.url === "string" ? flags.url : null,
        ...attrProps,
      },
    });
  }
  let resultCount = 0;
  try {
    if (intent && domain) {
      try {
        const searchRes = await api(
          "GET",
          `/v1/search/domain?intent=${encodeURIComponent(intent)}&domain=${encodeURIComponent(domain)}`,
        ) as { results?: unknown[] };
        resultCount = Array.isArray(searchRes?.results) ? searchRes.results.length : 0;
      } catch { /* search/domain optional — fall through to resolve */ }
    }
    await cmdResolve(flags);
    if (intent) {
      await recordFunnelTelemetryEvent("search_completed", {
        source: "cli",
        hostType,
        properties: {
          command: "search",
          intent,
          domain,
          result_count: resultCount,
          ...attrProps,
        },
      });
    }
  } catch (err) {
    if (intent) {
      await recordFunnelTelemetryEvent("search_failed", {
        source: "cli",
        hostType,
        properties: {
          command: "search",
          intent,
          error: err instanceof Error ? err.message : String(err),
          ...attrProps,
        },
      });
    }
    throw err;
  }
}

async function cmdSessions(flags: Record<string, string | boolean>): Promise<void> {
  const domain = flags.domain as string;
  if (!domain) die("--domain is required");
  const limit = flags.limit ?? "10";
  output(await api("GET", `/v1/sessions/${domain}?limit=${limit}`), !!flags.pretty);
}

async function cmdSetup(flags: Record<string, string | boolean>): Promise<void> {
  const hostType = detectTelemetryHostType();
  await ensureCliInstallTracked(hostType);
  await recordFunnelTelemetryEvent("cli_invoked", {
    source: "setup",
    hostType,
    properties: { command: "setup" },
  });
  info("Running setup checks");

  // Registration is optional — setup no longer registers implicitly. Users
  // can opt in later with `unbrowse register` if they want to publish, earn,
  // or access server-side analytics.

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
  for (const hook of report.update_hints) {
    if (hook.action === "installed" || hook.action === "updated") {
      info(`${hook.host} update hint hook ${hook.action} at ${hook.config_file}`);
    }
  }

  // Wallet status — tell the user if they're missing payout config
  if (report.wallet.configured) {
    info(`Wallet configured (${report.wallet.provider}): ${(report.wallet as Record<string, unknown>).wallet_address ?? "linked"}`);
  } else if ((report.wallet as Record<string, unknown>).lobster_installed) {
    info("Wallet not paired — you won't earn when other agents use routes you discovered.");
    info("Run: npx @crossmint/lobster-cli setup");
  } else {
    info("No wallet configured — you earn when other agents reuse routes you discovered.");
    info("Set up a wallet to start earning:");
    info("  npx @crossmint/lobster-cli setup");
  }

  const hasGcloud = (() => { try { const { existsSync } = require("fs"); const { homedir } = require("os"); const { join } = require("path"); return existsSync(join(homedir(), ".config", "gcloud", "application_default_credentials.json")); } catch { return false; } })();
  if (hasGcloud) {
    info("Email provider: Gmail (via GWS) — autonomous login enabled");
  }

  await recordInstallTelemetryEvent("setup", {
    hostType,
    status: report.browser_engine.action === "failed" ? "failed" : "installed",
    properties: {
      browser_engine_action: report.browser_engine.action,
      opencode_action: report.opencode.action,
      no_start: !!flags["no-start"],
      skip_browser: !!flags["skip-browser"],
    },
  });
  await recordFunnelTelemetryEvent("setup_completed", {
    source: "setup",
    hostType,
    properties: {
      browser_engine_action: report.browser_engine.action,
      opencode_action: report.opencode.action,
      no_start: !!flags["no-start"],
    },
  });

  if (flags["no-start"]) {
    report.server = { started: false, skipped: true, base_url: BASE_URL };
    output(report, true);
    if (report.browser_engine.action === "failed") process.exit(1);
    return;
  }

  // Registration is optional. Skip during setup — users can run `unbrowse
  // register` later if they want to publish, earn, or access server-side
  // analytics. Setup just installs deps and starts the local server.

  try {
    await ensureLocalServer(BASE_URL, false, import.meta.url);
    report.server = { started: true, base_url: BASE_URL };
    await recordFunnelTelemetryEvent("server_autostart_succeeded", {
      source: "setup",
      hostType,
      properties: {
        base_url: BASE_URL,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordFunnelTelemetryEvent("server_autostart_failed", {
      source: "setup",
      hostType,
      properties: {
        failure_stage: "server_autostart",
        failure_reason: message,
      },
    });
    report.server = { started: false, error: message, base_url: BASE_URL };
    output(report, true);
    process.exit(1);
  }

  output(report, true);
  if (report.browser_engine.action === "failed") process.exit(1);

  // --- Guided first resolve ---
  // After setup succeeds, auto-run a resolve so the user sees what unbrowse
  // does. This directly attacks the 82% drop-off at registration→first_resolve.
  try {
    info("Trying your first resolve...");
    const demoUrl = "https://jsonplaceholder.typicode.com";
    const demoIntent = "list all posts";
    await recordFunnelTelemetryEvent("resolve_started", {
      source: "setup",
      hostType,
      properties: { command: "guided-first-resolve", intent: demoIntent, url: demoUrl },
    });

    const resolveResult = await api("POST", "/v1/intent/resolve", {
      intent: demoIntent,
      params: { url: demoUrl },
      context: { url: demoUrl },
      projection: { raw: true },
    }) as Record<string, unknown>;

    if (isResolveSuccessResult(resolveResult)) {
      await recordFunnelTelemetryEvent("resolve_completed", {
        source: "setup",
        hostType,
        properties: { command: "guided-first-resolve", intent: demoIntent, url: demoUrl, source: resolveResult.source },
      });
      const endpoints = resolveResult.available_endpoints as Array<Record<string, unknown>> | undefined;
      if (endpoints && endpoints.length > 0) {
        info(`Found ${endpoints.length} API endpoint${endpoints.length > 1 ? "s" : ""} on ${demoUrl}:`);
        for (const ep of endpoints.slice(0, 5)) {
          const method = ep.method ?? "GET";
          const desc = ep.description ?? ep.url_template ?? ep.endpoint_id ?? "";
          info(`  ${method} ${desc}`);
        }
      } else {
        info(`Resolve succeeded on ${demoUrl}`);
      }
      info("");
      info("That's unbrowse. Try your own:");
      info('  unbrowse resolve --intent "search for shoes" --url "https://amazon.com"');
    } else {
      info("Guided resolve returned no results — try manually:");
      info('  unbrowse resolve --intent "list posts" --url "https://jsonplaceholder.typicode.com"');
    }
  } catch {
    // Guided resolve is best-effort — never fail setup because of it
    info("Setup complete. Try your first resolve:");
    info('  unbrowse resolve --intent "list posts" --url "https://jsonplaceholder.typicode.com"');
  }
}

// ---------------------------------------------------------------------------
// Phase 8.2 — `unbrowse mode` standalone command + contribution prompt at end
// of `unbrowse setup`. The prompt is no-op when the user already chose; `mode`
// always re-prompts.
// ---------------------------------------------------------------------------

async function cmdMode(_flags: Record<string, string | boolean>): Promise<void> {
  await promptContributionMode({ force: true });
  await syncContributionPreferenceToServer();
}

/**
 * Best-effort sync of the local share_pointers preference up to the backend
 * for account-bound API keys. Anonymous keys silently skip; offline / 5xx
 * surface a single info() warning so the user knows the local change is fine
 * but server didn't pick it up.
 */
async function syncContributionPreferenceToServer(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg?.api_key) return;
  const share_pointers = !!getContributionConfig().contribution.share_pointers;
  try {
    await pushAccountPreferences({ share_pointers });
    info("Synced preference to your account.");
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // Anonymous keys get 403 account_required — silent in that case.
    if (msg.includes("account_required") || msg.includes("HTTP 403")) return;
    info(`Local mode set, but server sync failed: ${msg}`);
  }
}


// Hook the contribution prompt onto the tail of cmdSetup. Called from main()
// right after cmdSetup runs.
async function runPostSetupContributionPrompt(): Promise<void> {
  try {
    await promptContributionMode({ force: false });
  } catch {
    // Never fail setup because of the prompt.
  }
}

// ---------------------------------------------------------------------------
// Phase 8.2 — `unbrowse capture` standalone verb.
//
// Live-browser capture is no longer triggered implicitly from resolve. The
// agent calls `unbrowse capture --url <url> --intent <intent>` explicitly
// when it has decided the cost (5–15s) is worth it. Server side wraps the
// existing executeBrowserCapture pipeline at POST /v1/capture.
// ---------------------------------------------------------------------------

async function cmdCapture(flags: Record<string, string | boolean>): Promise<void> {
  const url = flags.url as string;
  const intent = (flags.intent as string) || "capture";
  if (!url) die("--url is required");
  maybeShowContributionNotice();

  const t0 = Date.now();
  const result = await api("POST", "/v1/capture", { url, intent }) as Record<string, unknown>;

  const endpoints = Array.isArray(result.endpoints)
    ? (result.endpoints as unknown[])
    : (Array.isArray(result.available_endpoints) ? (result.available_endpoints as unknown[]) : []);
  const skill = (result.skill as Record<string, unknown> | undefined) ?? null;
  const skillId = (result.skill_id as string | undefined)
    ?? (skill?.skill_id as string | undefined)
    ?? (typeof result.learned_skill_id === "string" ? (result.learned_skill_id as string) : undefined);

  // Detect "lazy-loading SPA" shape: only one endpoint surfaced and it's the
  // document URL itself (no XHR fired during the auto-capture window). The
  // agent should drive interaction (scroll/click) so HAR catches the lazy
  // fetches. Pure structural shape — no per-host check.
  const isThinDocumentOnly = endpoints.length === 1 && (() => {
    const e0 = endpoints[0] as { method?: string; url_template?: string };
    if (!e0 || e0.method !== "GET") return false;
    const tmpl = (e0.url_template ?? "").split("?")[0].replace(/\/$/, "");
    const target = url.split("?")[0].replace(/\/$/, "");
    return tmpl === target;
  })();

  const escapedIntent = intent.replace(/"/g, "\\\"");
  const escapedUrl = url.replace(/"/g, "\\\"");

  const envelope = {
    skill_id: skillId,
    endpoints_discovered: typeof result.endpoints_discovered === "number"
      ? (result.endpoints_discovered as number)
      : endpoints.length,
    marketplace_published: !!result.marketplace_published,
    ms: typeof result.ms === "number" ? (result.ms as number) : Date.now() - t0,
    next_step: endpoints.length === 0
      ? "no endpoints discovered; site may need authentication or different intent"
      : `unbrowse resolve --intent "${escapedIntent}" --url "${escapedUrl}"`,
    ...(isThinDocumentOnly
      ? { capture_pattern: "doc_only", capture_observation: "only the input URL was captured (1 GET, no XHR fired during the auto-capture window)" }
      : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.prior_domain_note ? { prior_domain_note: result.prior_domain_note } : {}),
    ...(result.note_evidence ? { note_evidence: result.note_evidence } : {}),
  };

  output(envelope, !!flags.pretty);
}

async function cmdNote(flags: Record<string, string | boolean>, args?: string[]): Promise<void> {
  const subRaw = (args?.[0] ?? flags.action) as string | undefined;
  const sub = (typeof subRaw === "string" ? subRaw : "").toLowerCase();
  if (!sub || !["read", "write", "list"].includes(sub)) {
    die("usage: unbrowse note <read|write|list> --domain <domain> [--body \"...\"]");
  }
  if (sub === "list") {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { readdirSync, existsSync } = await import("node:fs");
    const profile = process.env.UNBROWSE_PROFILE ?? "";
    const dir = process.env.UNBROWSE_DOMAIN_NOTES_DIR
      ?? (profile
        ? join(homedir(), ".unbrowse", "profiles", profile, "domain-notes")
        : join(homedir(), ".unbrowse", "domain-notes"));
    if (!existsSync(dir)) { output({ notes: [], dir }, !!flags.pretty); return; }
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    output({ dir, notes: files.map((f) => f.replace(/\.md$/, "")) }, !!flags.pretty);
    return;
  }
  const domain = flags.domain as string | undefined;
  if (!domain) die("--domain required");
  if (sub === "read") {
    const res = await api("GET", `/v1/domain-notes/${encodeURIComponent(domain!)}`).catch((err) => ({
      error: (err as Error).message,
    }));
    output(res, !!flags.pretty);
    return;
  }
  const body = flags.body as string | undefined;
  if (typeof body !== "string" || body.trim().length === 0) {
    die("--body required (non-empty markdown string)");
  }
  const res = await api("POST", `/v1/domain-notes/${encodeURIComponent(domain!)}`, { body });
  output(res, !!flags.pretty);
}
// ---------------------------------------------------------------------------
// CLI Reference — single source of truth for help text AND SKILL.md
// ---------------------------------------------------------------------------

export const CLI_REFERENCE = {
  commands: [
    { name: "health", usage: "", desc: "Server health check" },
    { name: "mcp", usage: "[--no-auto-start]", desc: "Run the stdio MCP server" },
    { name: "setup", usage: "[--opencode auto|global|project|off] [--no-start]", desc: "Bootstrap browser deps + Open Code command" },
    { name: "upgrade", usage: "", desc: "Check latest release and print the right upgrade command" },
    { name: "resolve", usage: '--intent "..." [--domain "..."] [--url "..."] [opts]', desc: "Returns ranked shortlist of endpoints for an intent. Pick one and call execute. (Two tool calls is the contract — autoexec is opt-in via --execute, not the default.)" },
    { name: "explain", usage: '--intent "..." --url "..." [--top N]', desc: "Emit top-N candidate endpoints + evidence for an LLM judge to pick from (no heuristic verdict — primitives + agent judgment)" },
    { name: "execute", usage: "--skill ID --endpoint ID [-p key=val ...] [--params '{json}'] [opts]", desc: "Execute a specific endpoint. Pass replay params via repeated -p key=val flags or --params with a JSON object" },
    { name: "feedback", usage: "--skill ID --endpoint ID --rating N", desc: "Submit feedback (mandatory after resolve)" },
    { name: "annotate", usage: "--skill ID --endpoint ID --text 'tip' [--constraint 'param:rule:message']", desc: "Contribute best practices or constraints for an endpoint" },
    { name: "review", usage: "--skill ID --endpoints '[...]'", desc: "Push reviewed descriptions/schema metadata back to a captured skill before publish" },
    { name: "index", usage: "--skill ID", desc: "Recompute local graph/contracts/export from cached skill state only" },
    { name: "publish", usage: "--skill ID [--confirm-publish] [--endpoints '[...]']", desc: "Re-index locally, inspect publish-review metadata, then publish/share from cached skill state" },
    { name: "publish-bundle", usage: "--preset path [--hosts codex,claude,openclaw] [--site-url https://www.unbrowse.ai]", desc: "Derive foundry bundle/share/host artifacts from one preset and write the public share manifest" },
    { name: "settings", usage: "[--auto-publish on|off] [--publish-blacklist domains] [--publish-promptlist domains]", desc: "Show or update local capture/publish policy settings" },
    { name: "login", usage: '--url "..."', desc: "Interactive browser login" },
    { name: "skills", usage: "", desc: "List all skills" },
    { name: "skill", usage: "<id>", desc: "Get skill details" },
    { name: "cleanup-stale", usage: "[--skill ID] [--domain host] [--limit N]", desc: "Verify skills and evict stale cached endpoints" },
    { name: "sessions", usage: '--domain "..." [--limit N]', desc: "Debug session logs" },
    { name: "go", usage: '<url> [--session id]', desc: "Open a fresh Kuri browser tab, or reuse explicit --session" },
    { name: "submit", usage: "[--session id] [--form-selector sel] [--submit-selector sel] [--wait-for hint] [--assist-site-state]", desc: "Submit current form. Thin browser-native proxy by default; site-state assist and same-origin rehydrate are explicit opt-ins" },
    { name: "snap", usage: "[--session id] [--filter interactive]", desc: "A11y snapshot with @eN refs" },
    { name: "click", usage: "[--session id] <ref>", desc: "Click element by ref (e.g. e5)" },
    { name: "fill", usage: "[--session id] <ref> <value>", desc: "Fill input by ref" },
    { name: "type", usage: "<text>", desc: "Type text with key events" },
    { name: "press", usage: "<key>", desc: "Press key (Enter, Tab, Escape)" },
    { name: "select", usage: "<ref> <value>", desc: "Select option by ref" },
    { name: "scroll", usage: "[up|down|left|right]", desc: "Scroll the page" },
    { name: "screenshot", usage: "[--session id]", desc: "Capture screenshot (base64 PNG)" },
    { name: "text", usage: "[--session id]", desc: "Get page text content" },
    { name: "markdown", usage: "[--session id]", desc: "Get page as Markdown" },
    { name: "cookies", usage: "[--session id]", desc: "Get page cookies" },
    { name: "eval", usage: "[--session id] <expression>", desc: "Evaluate JavaScript" },
    { name: "back", usage: "[--session id]", desc: "Navigate back" },
    { name: "forward", usage: "[--session id]", desc: "Navigate forward" },
    { name: "sync", usage: "[--session id]", desc: "Checkpoint current capture, keep tab open, queue background index + publish, then inspect via skill/publish review" },
    { name: "close", usage: "[--session id]", desc: "Checkpoint capture, queue background index + publish, close browse session, then inspect via skill/publish review" },
    { name: "stats", usage: "[--json] [--pretty]", desc: "Show lifetime time/tokens/cost saved and marketplace earnings/spending" },
    { name: "flywheel", usage: "[--json] [--pretty]", desc: "Flywheel pulse: funnel, credits, index health, economics, conversions" },
    { name: "earnings", usage: "[--json]", desc: "Show your credit balance, earnings from indexing, and spending" },
    { name: "corpus-test", usage: "--url <url> [--id <id>] [--retries N]", desc: "Capture a single URL with retry logic; keeps best result across N attempts" },
    { name: "corpus-run", usage: "--corpus <file> --out <file> [--retries N]", desc: "Run corpus-test over all cases in a corpus JSON file and write a comparable snapshot" },
    { name: "register", usage: "[--email lewis@example.com] [--no-prompt]", desc: "Register an API key. With --email, sends a magic link via Resend; otherwise creates an anonymous key." },
    { name: "mode", usage: "", desc: "Re-prompt for contribution mode (private / share / share + earn)" },
    { name: "capture", usage: "--url <url> --intent <intent>", desc: "Live-browser capture for a single URL — discovers + indexes API endpoints. Marketplace publish gated by `unbrowse mode`." },
    { name: "note", usage: "<read|write|list> --domain <domain> [--body \"...\"]", desc: "Read/write per-domain LLM-prose notes consumed by augment on next capture. Agent populates after reading capture's note_evidence." },
  ],
  globalFlags: [
    { flag: "--pretty", desc: "Indented JSON output" },
    { flag: "--no-auto-start", desc: "Don't auto-start server" },
    { flag: "--raw", desc: "Return raw response data (skip server-side projection)" },
    { flag: "--skip-browser", desc: "setup: skip browser-engine install" },
    { flag: "--opencode auto|global|project|off", desc: "setup: install /unbrowse command for Open Code" },
  ],
  resolveExecuteFlags: [
    { flag: "--execute", desc: "Auto-execute the top trusted endpoint from resolve" },
    { flag: "--schema", desc: "Show response schema + extraction hints only (no data)" },
    { flag: '--path "data.items[]"', desc: "Drill into result before extract/output" },
    { flag: '--extract "field1,alias:deep.path.to.val"', desc: "Pick specific fields (no piping needed)" },
    { flag: "--limit N", desc: "Cap array output to N items" },
    { flag: "--endpoint-id ID", desc: "Pick a specific endpoint" },
    { flag: "--dry-run", desc: "Preview mutations" },
    { flag: "--params '{...}'", desc: "Extra params as JSON" },
  ],
  examples: [
    "unbrowse setup",
    "unbrowse mcp",
    'unbrowse resolve --intent "top stories" --domain "news.ycombinator.com" --url "https://news.ycombinator.com" --execute',
    'unbrowse resolve --intent "get timeline" --url "https://x.com"',
    'unbrowse go "https://www.mandai.com/en/ticketing/admission-and-rides/parks-selection.html"',
    'unbrowse snap --filter interactive',
    'unbrowse submit --wait-for "/time-selection.html"',
    'unbrowse sync',
    "unbrowse execute --skill abc --endpoint def --pretty",
    "unbrowse execute --skill abc --endpoint def --schema --pretty",
    'unbrowse execute --skill abc --endpoint def --path "data.items[]" --extract "name,url" --limit 10 --pretty',
    "unbrowse feedback --skill abc --endpoint def --rating 5",
    'unbrowse review --skill abc --endpoints \'[{"endpoint_id":"def","description":"...","parameter_reviews":[{"location":"query","name":"q","description":"Search query","type":"string","required":true}],"response_reviews":[{"path":"items[].title","description":"Listing title","type":"string"}]}]\'',
    "unbrowse index --skill abc --pretty",
    "unbrowse publish --skill abc --pretty",
    "unbrowse publish --skill abc --confirm-publish --pretty",
    "unbrowse publish-bundle --preset skills/x-account-operator/foundry-preset.json --pretty",
    'unbrowse settings --auto-publish off --publish-blacklist "linkedin.com,x.com" --publish-promptlist "github.com" --pretty',
    'unbrowse publish --skill abc --endpoints \'[{"endpoint_id":"def","description":"Search court judgments by keywords","action_kind":"search","resource_kind":"judgment"}]\'',
  ],
};


// ---------------------------------------------------------------------------
// stats — show lifetime impact (savings + earnings) for the current agent
// ---------------------------------------------------------------------------

function formatTotalDuration(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

async function cmdStats(flags: Record<string, string | boolean>): Promise<void> {
  const pretty = !!flags.pretty;
  const jsonOnly = !!flags.json;
  const local = readImpactSummary();
  const agentId = getAgentId();

  type EarningsLedger = { total_earned_uc: number; total_earned_usd: number; transaction_count: number; last_transaction_at?: string } | null;
  type SpendingLedger = { total_spent_uc: number; total_spent_usd: number; transaction_count: number; last_transaction_at?: string } | null;

  let profile: Awaited<ReturnType<typeof getMyProfile>> | null = null;
  let earnings: { ledger: EarningsLedger; transactions: unknown[] } | null = null;
  let spending: { ledger: SpendingLedger; transactions: unknown[] } | null = null;
  const remoteErrors: Record<string, string> = {};

  if (agentId) {
    const results = await Promise.allSettled([
      getMyProfile(),
      getCreatorEarnings(agentId),
      getTransactionHistory(agentId),
    ]);
    if (results[0].status === "fulfilled") profile = results[0].value;
    else remoteErrors.profile = (results[0].reason as Error)?.message ?? String(results[0].reason);
    if (results[1].status === "fulfilled") earnings = results[1].value as { ledger: EarningsLedger; transactions: unknown[] };
    else remoteErrors.earnings = (results[1].reason as Error)?.message ?? String(results[1].reason);
    if (results[2].status === "fulfilled") spending = results[2].value as { ledger: SpendingLedger; transactions: unknown[] };
    else remoteErrors.spending = (results[2].reason as Error)?.message ?? String(results[2].reason);
  } else {
    remoteErrors.profile = "No agent_id in local config. Run `unbrowse setup` to register.";
  }

  const earnedUsd = earnings?.ledger?.total_earned_usd ?? 0;
  const spentUsd = spending?.ledger?.total_spent_usd ?? 0;
  const netUsd = earnedUsd - spentUsd;
  const savedUsd = local.total_cost_saved_uc / 1_000_000;

  const payload = {
    agent_id: agentId,
    profile,
    impact: {
      total_runs: local.total_runs,
      successful_runs: local.successful_runs,
      browser_avoided_runs: local.browser_avoided_runs,
      total_time_saved_ms: local.total_time_saved_ms,
      total_time_saved_human: formatTotalDuration(local.total_time_saved_ms),
      total_tokens_saved: local.total_tokens_saved,
      total_cost_saved_usd: Number(savedUsd.toFixed(6)),
      avg_time_saved_pct: local.avg_time_saved_pct,
      avg_tokens_saved_pct: local.avg_tokens_saved_pct,
      by_source: local.by_source,
      first_entry_at: local.first_entry_at,
      last_entry_at: local.last_entry_at,
      log_path: getImpactLogPath(),
    },
    earnings: {
      total_earned_usd: earnedUsd,
      total_earned_uc: earnings?.ledger?.total_earned_uc ?? 0,
      transaction_count: earnings?.ledger?.transaction_count ?? 0,
      last_transaction_at: earnings?.ledger?.last_transaction_at ?? null,
    },
    spending: {
      total_spent_usd: spentUsd,
      total_spent_uc: spending?.ledger?.total_spent_uc ?? 0,
      transaction_count: spending?.ledger?.transaction_count ?? 0,
      last_transaction_at: spending?.ledger?.last_transaction_at ?? null,
    },
    net_usd: netUsd,
    ...(Object.keys(remoteErrors).length > 0 ? { remote_errors: remoteErrors } : {}),
  };

  if (jsonOnly) {
    output(payload, pretty);
    return;
  }

  // Human-readable view (to stderr like other info) + JSON to stdout for piping.
  const lines: string[] = [];
  lines.push("Unbrowse stats");
  lines.push(`  agent_id: ${agentId ?? "(not registered — run `unbrowse setup`)"}`);
  if (profile?.name) lines.push(`  name: ${profile.name}`);
  lines.push("");
  lines.push("Impact (local, this machine):");
  if (local.total_runs === 0) {
    lines.push("  No resolve/execute runs recorded yet.");
    lines.push(`  Log file: ${getImpactLogPath()}`);
  } else {
    lines.push(`  Runs: ${local.total_runs} (${local.successful_runs} successful, ${local.browser_avoided_runs} browser-avoided)`);
    if (local.total_time_saved_ms > 0) {
      lines.push(`  Time saved: ${formatTotalDuration(local.total_time_saved_ms)} (avg ${local.avg_time_saved_pct}% faster)`);
    }
    if (local.total_tokens_saved > 0) {
      lines.push(`  Tokens saved: ${local.total_tokens_saved.toLocaleString("en-US")} (avg ${local.avg_tokens_saved_pct}% less context)`);
    }
    if (savedUsd > 0) {
      lines.push(`  Cost saved: ${formatCostUsd(local.total_cost_saved_uc)}`);
    }
    if (Object.keys(local.by_source).length > 0) {
      const topSources = Object.entries(local.by_source)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`  By source: ${topSources}`);
    }
  }
  lines.push("");
  lines.push("Money (backend ledger):");
  if (!agentId) {
    lines.push("  (not registered — earnings/spending unavailable)");
  } else if (remoteErrors.earnings || remoteErrors.spending) {
    if (remoteErrors.earnings) lines.push(`  earnings: error — ${remoteErrors.earnings}`);
    if (remoteErrors.spending) lines.push(`  spending: error — ${remoteErrors.spending}`);
  } else {
    lines.push(`  Earned:  $${earnedUsd.toFixed(4)} (${earnings?.ledger?.transaction_count ?? 0} payouts)`);
    lines.push(`  Spent:   $${spentUsd.toFixed(4)} (${spending?.ledger?.transaction_count ?? 0} payments)`);
    lines.push(`  Net:     ${netUsd >= 0 ? "+" : ""}$${netUsd.toFixed(4)}`);
  }
  lines.push("");
  info(lines.join("\n"));
  output(payload, pretty);
}

// ---------------------------------------------------------------------------
// flywheel — full flywheel state in one call (funnel + credits + index + econ)
// ---------------------------------------------------------------------------

async function cmdFlywheel(flags: Record<string, string | boolean>): Promise<void> {
  const pretty = !!flags.pretty;
  const jsonOnly = !!flags.json;

  let pulse: Awaited<ReturnType<typeof getFlywheelPulse>>;
  try {
    pulse = await getFlywheelPulse();
  } catch (err) {
    die(`Failed to fetch flywheel pulse: ${(err as Error).message}`);
  }

  if (jsonOnly) {
    output(pulse, pretty);
    return;
  }

  const f = pulse.funnel;
  const cr = pulse.conversion;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const ucToUsd = (uc: number): string => formatCostUsd(uc);
  const comma = (n: number): string => n.toLocaleString("en-US");

  const lines: string[] = [];
  lines.push("=== Unbrowse Flywheel (7d) ===");
  lines.push(
    `Installs: ${f.installs_7d} -> Register: ${f.registrations_7d} (${pct(cr.install_to_register)})` +
    ` -> Resolve: ${f.first_resolve_7d} (${pct(cr.register_to_first_resolve)})` +
    ` -> Repeat: ${f.repeat_users_7d} (${pct(cr.first_resolve_to_repeat)})`,
  );

  const c = pulse.credits;
  lines.push(
    `Credits pool: ${ucToUsd(c.pool_remaining_uc)} remaining` +
    ` | ${c.agents_subsidized} agents subsidized` +
    ` | ${c.agents_self_sustaining} self-sustaining`,
  );

  const idx = pulse.index;
  lines.push(
    `Index: ${comma(idx.total_endpoints)} endpoints (+${idx.new_endpoints_7d} this week)` +
    ` | ${pct(idx.marketplace_hit_rate)} hit rate`,
  );

  const e = pulse.economics;
  lines.push(
    `Revenue: ${ucToUsd(e.total_revenue_uc)}` +
    ` | ${ucToUsd(e.revenue_per_install_uc)}/install` +
    ` | LTV ${ucToUsd(e.ltv_per_agent_uc)}/agent`,
  );

  lines.push("");
  lines.push("=== 30d totals ===");
  lines.push(
    `Installs: ${f.installs_30d} | Registrations: ${f.registrations_30d}` +
    ` | Resolves: ${f.first_resolve_30d} | Repeat: ${f.repeat_users_30d}`,
  );
  lines.push(
    `Agent earnings: ${ucToUsd(e.total_earned_by_agents_uc)}` +
    ` | Domains: ${idx.total_domains}`,
  );
  if (c.avg_time_to_self_sustaining_hours > 0) {
    lines.push(`Avg time to self-sustaining: ${c.avg_time_to_self_sustaining_hours}h`);
  }

  lines.push("");
  info(lines.join("\n"));
  output(pulse, pretty);
}

async function cmdEarnings(flags: Record<string, string | boolean>): Promise<void> {
  const jsonOnly = !!flags.json;
  const apiKey = getApiKey();
  if (!apiKey) {
    die("No API key found. Run `unbrowse setup` first.");
  }

  try {
    const { DEFAULT_BACKEND_URL } = await import("./version.js");
    const backendUrl = process.env.UNBROWSE_BACKEND_URL || DEFAULT_BACKEND_URL;
    const resp = await fetch(`${backendUrl}/v1/credits/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) {
      die(`Failed to fetch earnings: ${resp.status}`);
    }
    const data = await resp.json() as {
      granted_uc: number; earned_uc: number; consumed_uc: number;
      balance_uc: number; is_self_sustaining: boolean;
    };

    if (jsonOnly) {
      output(data, false);
      return;
    }

    const usd = (uc: number): string => `$${(uc / 1_000_000).toFixed(4)}`;
    const lines: string[] = [];
    lines.push("=== Unbrowse Earnings ===");
    lines.push(`Balance:    ${usd(data.balance_uc)}`);
    lines.push(`  Granted:  ${usd(data.granted_uc)} (welcome credits)`);
    lines.push(`  Earned:   ${usd(data.earned_uc)} (from other agents using your routes)`);
    lines.push(`  Spent:    ${usd(data.consumed_uc)}`);
    lines.push(`  Status:   ${data.is_self_sustaining ? "Self-sustaining" : "Subsidized"}`);
    if (!data.is_self_sustaining && data.earned_uc > 0) {
      const pct = Math.round((data.earned_uc / Math.max(data.consumed_uc, 1)) * 100);
      lines.push(`  Progress: ${pct}% to self-sustaining`);
    }
    lines.push("");
    lines.push("Every resolve discovers routes — you earn when other agents reuse them.");
    info(lines.join("\n"));
  } catch (err) {
    die(`Failed to fetch earnings: ${(err as Error).message}`);
  }
}

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
    "  4. submit -> prefer DOM submit; keep traversal browser-native; opt into same-origin rehydrate only for explicit replay/recovery debugging",
    "  5. sync -> checkpoint the current step and queue background index + publish",
    "  6. close -> final checkpoint + queue background index + publish, then close the session",
    "  7. skill/publish --pretty -> inspect the fresh captured endpoints and review context",
    "  8. review/publish -> annotate and share the contract; resolve is for later reuse, not first-pass capture validation",
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
  const hintOnly = !!flags["hint-only"];
  if (!hintOnly) info("Checking for updates...");

  try {
    const result = await checkForUpdates(import.meta.url, { force: !hintOnly });
    if (!result.latest) {
      if (!hintOnly) info("Could not check for updates right now.");
      return;
    }

    if (!result.has_update) {
      if (!hintOnly) info(`Already at latest version: ${result.installed}`);
      return;
    }

    info(`Update available: ${result.installed} -> ${result.latest}`);
    info(`Run: ${result.command}`);
    if (!hintOnly) {
      info("Tip: `unbrowse setup` now installs session-start update hints for Codex and Claude when those hosts are present.");
    }
    recordUpdateHint(result.latest);
  } catch (err) {
    if (!hintOnly) info(`Could not check for updates: ${(err as Error).message}`);
  }
}

async function cmdMcp(flags: Record<string, string | boolean>): Promise<void> {
  const entrypoint = resolveSiblingEntrypoint(import.meta.url, "mcp");
  const childArgs = isBundledVirtualEntrypoint(entrypoint)
    ? ["mcp-serve", ...(flags["no-auto-start"] ? ["--no-auto-start"] : [])]
    : [...runtimeArgsForEntrypoint(import.meta.url, entrypoint), ...(flags["no-auto-start"] ? ["--no-auto-start"] : [])];
  const child = spawn(
    process.execPath,
    childArgs,
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        MCP_SERVER_MODE: "1",
      },
    },
  );

  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(exitCode ?? 1);
    });
  });

  if (code !== 0) process.exit(code);
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
  maybeShowContributionNotice();
  output(await api("POST", "/v1/browse/go", {
    url,
    ...(typeof flags.session === "string" ? { session_id: flags.session } : {}),
  }), !!flags.pretty);
}

async function cmdSubmit(flags: Record<string, string | boolean>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (typeof flags.session === "string") body.session_id = flags.session;
  if (typeof flags["form-selector"] === "string") body.form_selector = flags["form-selector"];
  if (typeof flags["submit-selector"] === "string") body.submit_selector = flags["submit-selector"];
  if (typeof flags["wait-for"] === "string") body.wait_for = flags["wait-for"];
  if (typeof flags["timeout-ms"] === "string") body.timeout_ms = Number(flags["timeout-ms"]);
  if (flags["assist-site-state"] !== undefined) {
    body.assist_site_state = flags["assist-site-state"] !== "false";
  }
  if (flags["same-origin-fetch-fallback"] !== undefined) {
    body.same_origin_fetch_fallback = flags["same-origin-fetch-fallback"] !== "false";
  }
  output(await api("POST", "/v1/browse/submit", body), !!flags.pretty);
}

async function cmdSnap(flags: Record<string, string | boolean>): Promise<void> {
  const filter = flags.filter as string | undefined;
  const result = await api("POST", "/v1/browse/snap", {
    ...(filter ? { filter } : {}),
    ...(typeof flags.session === "string" ? { session_id: flags.session } : {}),
  }) as { snapshot?: string };
  if (result.snapshot && !flags.pretty) {
    console.log(result.snapshot);
  } else {
    output(result, !!flags.pretty);
  }
}

async function cmdClick(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const ref = args[0];
  if (!ref) die("Usage: unbrowse click <ref>");
  output(await api("POST", "/v1/browse/click", {
    ref,
    ...(typeof flags.session === "string" ? { session_id: flags.session } : {}),
  }), false);
}

async function cmdFill(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const ref = args[0];
  const value = args.slice(1).join(" ");
  if (!ref || !value) die("Usage: unbrowse fill <ref> <value>");
  output(await api("POST", "/v1/browse/fill", {
    ref,
    value,
    ...(typeof flags.session === "string" ? { session_id: flags.session } : {}),
  }), false);
}

async function cmdType(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const text = args.join(" ");
  if (!text) die("Usage: unbrowse type <text>");
  output(await api("POST", "/v1/browse/type", {
    text,
    ...(typeof flags.session === "string" ? { session_id: flags.session } : {}),
  }), false);
}

async function cmdPress(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const key = args[0];
  if (!key) die("Usage: unbrowse press <key>");
  output(await api("POST", "/v1/browse/press", {
    key,
    ...(typeof flags.session === "string" ? { session_id: flags.session } : {}),
  }), false);
}

async function cmdSelect(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const ref = args[0];
  const value = args.slice(1).join(" ");
  if (!ref || !value) die("Usage: unbrowse select <ref> <value>");
  output(await api("POST", "/v1/browse/select", {
    ref,
    value,
    ...(typeof flags.session === "string" ? { session_id: flags.session } : {}),
  }), false);
}

async function cmdScroll(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const direction = args[0] ?? "down";
  output(await api("POST", "/v1/browse/scroll", {
    direction,
    ...(typeof flags.session === "string" ? { session_id: flags.session } : {}),
  }), false);
}

async function cmdScreenshot(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("GET", "/v1/browse/screenshot", typeof flags.session === "string" ? { session_id: flags.session } : undefined), !!flags.pretty);
}

async function cmdText(flags: Record<string, string | boolean>): Promise<void> {
  const result = await api("GET", "/v1/browse/text", typeof flags.session === "string" ? { session_id: flags.session } : undefined) as { text?: string };
  if (result.text && !flags.pretty) {
    console.log(result.text);
  } else {
    output(result, !!flags.pretty);
  }
}

async function cmdMarkdown(flags: Record<string, string | boolean>): Promise<void> {
  const result = await api("GET", "/v1/browse/markdown", typeof flags.session === "string" ? { session_id: flags.session } : undefined) as { markdown?: string };
  if (result.markdown && !flags.pretty) {
    console.log(result.markdown);
  } else {
    output(result, !!flags.pretty);
  }
}

async function cmdCookies(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("GET", "/v1/browse/cookies", typeof flags.session === "string" ? { session_id: flags.session } : undefined), !!flags.pretty);
}

async function cmdEval(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const expression = args.join(" ");
  if (!expression) die("Usage: unbrowse eval <expression>");
  output(await api("POST", "/v1/browse/eval", {
    expression,
    ...(typeof flags.session === "string" ? { session_id: flags.session } : {}),
  }), !!flags.pretty);
}

async function cmdBack(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/back", typeof flags.session === "string" ? { session_id: flags.session } : undefined), false);
}

async function cmdForward(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/forward", typeof flags.session === "string" ? { session_id: flags.session } : undefined), false);
}

async function cmdSync(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/sync", typeof flags.session === "string" ? { session_id: flags.session } : undefined), !!flags.pretty);
}

async function cmdClose(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/close", typeof flags.session === "string" ? { session_id: flags.session } : undefined), false);
}

// ---------------------------------------------------------------------------
// register — opt-in registration for publishing, earnings, and backend analytics
// ---------------------------------------------------------------------------

async function cmdRegister(flags: Record<string, unknown>) {
  if (typeof flags.email === "string" && flags.email.length > 0) {
    const email = flags.email;
    if (getApiKey()) {
      info("Already registered. Re-running with --email will mint a new key and overwrite ~/.unbrowse/config.json.");
    }
    info(`Sending magic link to ${email}…`);
    const result = await magicRegister({
      email,
      openBrowser: (url) => {
        info(`Opening browser: ${url}`);
        try {
          const cmd = process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
          spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
        } catch { /* best-effort; user can copy/paste */ }
      },
    });
    saveConfig({
      api_key: result.api_key,
      agent_id: result.agent_id,
      agent_name: result.email,
      registered_at: new Date().toISOString(),
      tos_accepted_version: null,
      tos_accepted_at: null,
    });
    process.env.UNBROWSE_API_KEY = result.api_key;
    info(`Signed in as ${result.email}. API key saved to ~/.unbrowse/config.json.`);
    // Mirror server-side preference into local contribution block so the
    // capture pipeline picks it up. Best-effort — never blocks register.
    try {
      const serverPrefs = await fetchAccountPreferences();
      if (serverPrefs) {
        setContributionConfig({
          contribution: { share_pointers: serverPrefs.share_pointers, set_via: "mode-command" },
        });
        info(`Auto-publish to marketplace: ${serverPrefs.share_pointers ? "ON" : "off"} (synced from your account).`);
      }
    } catch { /* best-effort */ }
    return;
  }
  if (getApiKey()) {
    info("Already registered. API key loaded from env or ~/.unbrowse/config.json");
    return;
  }
  await ensureRegistered({ promptForEmail: !flags["no-prompt"], exitOnFailure: false });
  if (getApiKey()) {
    info("Registration complete. You can now publish skills and check earnings.");
  } else {
    info("Registration skipped or failed. Unbrowse still works locally — publish/earnings are disabled.");
  }
}
// ---------------------------------------------------------------------------
// sessions-scan — discover logged-in sessions across all browsers
// ---------------------------------------------------------------------------

async function cmdSessionsScan(flags: Record<string, unknown>) {
  const domain = flags.domain as string | undefined;
  const { scanAllBrowserSessions, findBestBrowserSession } = await import("./auth/browser-cookies.js");
  const { execFileSync, existsSync } = await import("./cli-imports.js").catch(() => ({ execFileSync: require("child_process").execFileSync, existsSync: require("fs").existsSync }));

  if (domain) {
    // Scan for a specific domain
    const sessions = scanAllBrowserSessions(domain);
    if (sessions.length === 0) {
      info(`No browser has a session for ${domain}`);
      output({ domain, sessions: [], best: null });
      return;
    }
    const best = sessions[0];
    info(`Best session for ${domain}: ${best.browser} (${best.sessionCookies} session cookies)`);
    output({
      domain,
      sessions: sessions.map(s => ({
        browser: s.browser,
        cookies: s.cookies.length,
        session_cookies: s.sessionCookies,
      })),
      best: { browser: best.browser, session_cookies: best.sessionCookies },
    });
    return;
  }

  // Scan ALL domains across all browsers — discover what you're logged into
  const home = require("os").homedir();
  const { join } = require("path");
  const browsers = [
    { name: "Chrome", path: join(home, "Library/Application Support/Google/Chrome/Default/Cookies") },
    { name: "Dia", path: join(home, "Library/Application Support/Dia/User Data/Default/Cookies") },
    { name: "Arc", path: join(home, "Library/Application Support/Arc/User Data/Default/Cookies") },
    { name: "Brave", path: join(home, "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies") },
    { name: "Edge", path: join(home, "Library/Application Support/Microsoft Edge/Default/Cookies") },
  ];

  const allSessions: Array<{ browser: string; domain: string; session_cookies: number }> = [];

  for (const b of browsers) {
    if (!require("fs").existsSync(b.path)) continue;
    try {
      const tmp = `/tmp/unbrowse-scan-${b.name}.db`;
      require("child_process").execFileSync("cp", [b.path, tmp]);
      const result = require("child_process").execFileSync("sqlite3", [tmp,
        `SELECT host_key, COUNT(*) as c FROM cookies WHERE is_httponly=1 OR is_secure=1 GROUP BY host_key HAVING c >= 2 ORDER BY c DESC LIMIT 50;`,
      ], { encoding: "utf8" });
      for (const line of result.trim().split("\n")) {
        if (!line) continue;
        const [d, count] = line.split("|");
        // Skip trackers
        if (/google|facebook|doubleclick|rubiconproject|demdex|hcaptcha|protechts/.test(d)) continue;
        allSessions.push({ browser: b.name, domain: d, session_cookies: parseInt(count) || 0 });
      }
      require("child_process").execFileSync("rm", [tmp]);
    } catch { /* skip */ }
  }

  // Dedupe by domain, keep browser with most cookies
  const byDomain = new Map<string, typeof allSessions[0]>();
  for (const s of allSessions) {
    const existing = byDomain.get(s.domain);
    if (!existing || s.session_cookies > existing.session_cookies) {
      byDomain.set(s.domain, s);
    }
  }
  const sorted = [...byDomain.values()].sort((a, b) => b.session_cookies - a.session_cookies);

  info(`Found ${sorted.length} logged-in domains across ${browsers.filter(b => require("fs").existsSync(b.path)).length} browsers`);
  output({ sessions: sorted.slice(0, 30) });
}

// ---------------------------------------------------------------------------
// corpus-test — capture a single URL with retry logic for deterministic benchmarking
// ---------------------------------------------------------------------------

interface CorpusCaptureResult {
  capture: "ok" | "error";
  endpoints: number;
  requests: number;
  error?: string;
  raw?: unknown;
}

async function captureOnce(url: string): Promise<CorpusCaptureResult> {
  try {
    const goResult = await api("POST", "/v1/browse/go", { url }) as Record<string, unknown>;
    if (goResult.error) {
      return { capture: "error", endpoints: 0, requests: 0, error: String(goResult.error) };
    }
    // Wait a moment for page to load and capture traffic
    await new Promise(r => setTimeout(r, 6000));
    const closeResult = await api("POST", "/v1/browse/close", {}) as Record<string, unknown>;
    if (closeResult.error) {
      return { capture: "error", endpoints: 0, requests: 0, error: String(closeResult.error) };
    }
    return {
      capture: "ok",
      endpoints: (closeResult.endpoint_count as number) ?? 0,
      requests: (closeResult.request_count as number) ?? 0,
      raw: closeResult,
    };
  } catch (err) {
    return { capture: "error", endpoints: 0, requests: 0, error: (err as Error).message };
  }
}

async function cmdCorpusTest(flags: Record<string, string | boolean>): Promise<void> {
  const url = flags.url as string;
  if (!url) die("--url is required for corpus-test");
  const id = (flags.id as string) || new URL(url).hostname;
  const retries = flags.retries ? parseInt(flags.retries as string, 10) : 3;

  let best: CorpusCaptureResult = { capture: "error", endpoints: 0, requests: 0 };
  let attempts = 0;

  for (let attempt = 0; attempt < retries; attempt++) {
    attempts++;
    info(`corpus-test [${id}] attempt ${attempt + 1}/${retries}`);
    const result = await captureOnce(url);
    if (result.endpoints > best.endpoints) best = result;
    if (best.endpoints > 0) break;
    // Kill kuri/chrome between retries for a clean state
    if (attempt < retries - 1) {
      try { spawn("pkill", ["-9", "-f", "kuri|chrome-profile"], { stdio: "ignore" }); } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  output({
    id,
    url,
    capture: best.capture,
    endpoints: best.endpoints,
    requests: best.requests,
    attempts,
    best_of: retries,
    ...(best.error ? { error: best.error } : {}),
  }, !!flags.pretty);
}

// ---------------------------------------------------------------------------
// corpus-run — run corpus-test over a corpus file, write a comparable snapshot
// ---------------------------------------------------------------------------

interface CorpusCase {
  id: string;
  intent?: string;
  url: string;
  [key: string]: unknown;
}

interface CorpusFile {
  cases: CorpusCase[];
}

interface CorpusRunResult {
  id: string;
  capture: "ok" | "error";
  endpoints: number;
  requests: number;
  resolve_endpoints: number;
  verdict: "pass" | "fail" | "skip";
  attempts: number;
  notes: string;
}

async function cmdCorpusRun(flags: Record<string, string | boolean>): Promise<void> {
  const corpusPath = flags.corpus as string;
  const outPath = flags.out as string;
  if (!corpusPath) die("--corpus is required for corpus-run");
  if (!outPath) die("--out is required for corpus-run");
  const retries = flags.retries ? parseInt(flags.retries as string, 10) : 3;

  // Read corpus file
  let corpus: CorpusFile;
  try {
    const raw = require("node:fs").readFileSync(corpusPath, "utf-8");
    corpus = JSON.parse(raw) as CorpusFile;
  } catch (err) {
    die(`Failed to read corpus file: ${(err as Error).message}`);
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    die("Corpus file must have a non-empty 'cases' array");
  }

  // Capture git SHA for metadata
  let gitSha = "unknown";
  try {
    const { execSync } = require("node:child_process");
    gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {}

  const startTime = Date.now();
  const results: CorpusRunResult[] = [];

  info(`corpus-run: ${corpus.cases.length} cases, retries=${retries}`);

  for (const c of corpus.cases) {
    const caseId = c.id || new URL(c.url).hostname;
    info(`corpus-run [${caseId}] starting`);

    // Kill kuri/chrome before each site for clean state
    try { spawn("pkill", ["-9", "-f", "kuri|chrome-profile"], { stdio: "ignore" }); } catch {}
    await new Promise(r => setTimeout(r, 1500));

    let best: CorpusCaptureResult = { capture: "error", endpoints: 0, requests: 0 };
    let attempts = 0;

    for (let attempt = 0; attempt < retries; attempt++) {
      attempts++;
      const result = await captureOnce(c.url);
      if (result.endpoints > best.endpoints) best = result;
      if (best.endpoints > 0) break;
      if (attempt < retries - 1) {
        try { spawn("pkill", ["-9", "-f", "kuri|chrome-profile"], { stdio: "ignore" }); } catch {}
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Try a quick resolve to count resolve_endpoints
    let resolveEndpoints = 0;
    if (best.capture === "ok" && best.endpoints > 0) {
      try {
        const resolveResult = await api("GET", "/v1/resolve", {
          intent: c.intent ?? `get data from ${caseId}`,
          url: c.url,
          domain: new URL(c.url).hostname,
        }) as Record<string, unknown>;
        const endpoints = (resolveResult.endpoints as unknown[]) ?? (resolveResult.results as unknown[]) ?? [];
        resolveEndpoints = Array.isArray(endpoints) ? endpoints.length : 0;
      } catch {}
    }

    const verdict: "pass" | "fail" | "skip" = best.capture === "error" ? "fail"
      : best.endpoints > 0 ? "pass"
      : "fail";

    results.push({
      id: caseId,
      capture: best.capture,
      endpoints: best.endpoints,
      requests: best.requests,
      resolve_endpoints: resolveEndpoints,
      verdict,
      attempts,
      notes: best.error ?? "",
    });

    // Save incrementally after each site
    const snapshot = {
      git_sha: gitSha,
      timestamp: new Date().toISOString(),
      total_runtime_ms: Date.now() - startTime,
      results,
    };
    try {
      require("node:fs").writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
    } catch {}

    info(`corpus-run [${caseId}] done: endpoints=${best.endpoints} verdict=${verdict} attempts=${attempts}`);
  }

  const totalRuntime = Date.now() - startTime;
  const pass = results.filter(r => r.verdict === "pass").length;
  const fail = results.filter(r => r.verdict === "fail").length;

  const snapshot = {
    git_sha: gitSha,
    timestamp: new Date().toISOString(),
    total_runtime_ms: totalRuntime,
    results,
  };

  require("node:fs").writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  info(`corpus-run complete: ${pass} pass, ${fail} fail of ${results.length} total`);
  output(snapshot, !!flags.pretty);
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
  const { command, args, flags, params: cliParams } = parseArgs(process.argv);
  // Stash CLI -p key=val params on flags object so command handlers can read them.
  if (Object.keys(cliParams).length > 0) {
    (flags as Record<string, unknown>)._params = cliParams;
  }
  const noAutoStart = !!flags["no-auto-start"];

  if (command === "help" || flags.help) {
    printHelp();
    process.exit(0);
  }

  if (command === "setup") {
    await cmdSetup(flags);
    await runPostSetupContributionPrompt();
    return;
  }

  if (command === "mode") {
    await cmdMode(flags);
    return;
  }

  // Server lifecycle commands (don't need ensureLocalServer)
  if (command === "mcp") return cmdMcp(flags);
  if (command === "status") return cmdStatus(flags);
  if (command === "stop") { cmdStop(flags); return; }
  if (command === "restart") return cmdRestart(flags);
  if (command === "upgrade" || command === "update") return cmdUpgrade(flags);
  if (command === "connect-chrome") return cmdConnectChrome();
  if (command === "stats") return cmdStats(flags);
  if (command === "flywheel") return cmdFlywheel(flags);
  if (command === "earnings") return cmdEarnings(flags);
  if (command === "sessions-scan") return cmdSessionsScan(flags);
  if (command === "register") return cmdRegister(flags);

  // --- Shortcut resolution: unbrowse <site> [task] [flags] ---
  const KNOWN_COMMANDS = new Set([
    "health", "mcp", "setup", "resolve", "execute", "exec",
    "feedback", "fb", "annotate", "review", "index", "publish", "publish-bundle", "settings", "login", "skills", "skill", "cleanup-stale", "search", "sessions",
    "status", "stop", "restart", "upgrade", "update",
    "go", "submit", "snap", "click", "fill", "type", "press", "select", "scroll",
    "screenshot", "text", "markdown", "cookies", "eval", "back", "forward", "sync", "close",
    "connect-chrome", "stats", "flywheel", "earnings", "corpus-test", "corpus-run", "sessions-scan", "cache-clear", "register", "mode", "capture",
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
    case "mcp": return cmdMcp(flags);
    case "setup": return cmdSetup(flags);
    case "resolve": return cmdResolve(flags);
    case "explain": return cmdExplain(flags);
    case "execute": case "exec": return cmdExecute(flags);
    case "feedback": case "fb": return cmdFeedback(flags);
    case "annotate": return cmdAnnotate(flags);
    case "review": return cmdReview(flags);
    case "index": return cmdIndex(flags);
    case "publish": return cmdPublish(flags);
    case "publish-bundle": return cmdPublishBundle(flags);
    case "settings": return cmdSettings(flags);
    case "login": return cmdLogin(flags);
    case "skills": return cmdSkills(flags);
    case "skill": return cmdSkill(args, flags);
    case "cleanup-stale": return cmdCleanupStale(flags);
    case "search": return cmdSearch(flags);
    case "sessions": return cmdSessions(flags);
    // Browse commands — Kuri browser actions with passive indexing
    case "go": return cmdGo(args, flags);
    case "submit": return cmdSubmit(flags);
    case "snap": return cmdSnap(flags);
    case "click": return cmdClick(args, flags);
    case "fill": return cmdFill(args, flags);
    case "type": return cmdType(args, flags);
    case "press": return cmdPress(args, flags);
    case "select": return cmdSelect(args, flags);
    case "scroll": return cmdScroll(args, flags);
    case "screenshot": return cmdScreenshot(flags);
    case "text": return cmdText(flags);
    case "markdown": return cmdMarkdown(flags);
    case "cookies": return cmdCookies(flags);
    case "eval": return cmdEval(args, flags);
    case "back": return cmdBack(flags);
    case "forward": return cmdForward(flags);
    case "sync": return cmdSync(flags);
    case "close": return cmdClose(flags);
    case "connect-chrome": return cmdConnectChrome();
    case "stats": return cmdStats(flags);
    case "flywheel": return cmdFlywheel(flags);
    case "earnings": return cmdEarnings(flags);
    case "corpus-test": return cmdCorpusTest(flags);
    case "corpus-run": return cmdCorpusRun(flags);
    case "sessions-scan": return cmdSessionsScan(flags);
    case "register": return cmdRegister(flags);
    case "mode": return cmdMode(flags);
    case "capture": return cmdCapture(flags);
    case "note": return cmdNote(flags, args);
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
