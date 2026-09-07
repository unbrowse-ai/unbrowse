import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

export type IssueCategory = "broken" | "wrong_data" | "needs_auth" | "rate_limited" | "stale_schema" | "missing_endpoint" | "other";
export type IssueStatus = "open" | "acknowledged" | "resolved";

export interface IssueReport {
  issue_id: string;
  skill_id: string;
  agent_id: string;
  endpoint_id?: string;
  category: IssueCategory;
  description: string;
  status: IssueStatus;
  created_at: string;
  trace_id?: string;
}

function generateId(len = 12): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let id = "";
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

export async function createIssue(
  env: Env,
  skillId: string,
  agentId: string,
  category: IssueCategory,
  description: string,
  endpointId?: string,
  traceId?: string
): Promise<IssueReport> {
  const kv = statsKV(env);
  const issue: IssueReport = {
    issue_id: generateId(),
    skill_id: skillId,
    agent_id: agentId,
    endpoint_id: endpointId,
    category,
    description,
    status: "open",
    created_at: new Date().toISOString(),
    trace_id: traceId,
  };

  // Store the issue
  await kv.put(`issue:${skillId}:${issue.issue_id}`, JSON.stringify(issue));

  // Update the index (most recent 100)
  const idxKey = `issue-idx:${skillId}`;
  const raw = await kv.get(idxKey) as string | null;
  const ids: string[] = raw ? JSON.parse(raw) : [];
  ids.unshift(issue.issue_id);
  if (ids.length > 100) ids.length = 100;
  await kv.put(idxKey, JSON.stringify(ids));

  return issue;
}

export async function listIssues(
  env: Env,
  skillId: string,
  status?: IssueStatus,
  limit = 20
): Promise<IssueReport[]> {
  const kv = statsKV(env);
  const idxKey = `issue-idx:${skillId}`;
  const raw = await kv.get(idxKey) as string | null;
  if (!raw) return [];

  const ids: string[] = JSON.parse(raw);
  const issues = await Promise.all(
    ids.slice(0, limit).map((id) => kv.get(`issue:${skillId}:${id}`, "json"))
  );

  let result = issues.filter(Boolean) as IssueReport[];
  if (status) result = result.filter((i) => i.status === status);
  return result;
}

export async function updateIssueStatus(
  env: Env,
  skillId: string,
  issueId: string,
  status: IssueStatus
): Promise<void> {
  const kv = statsKV(env);
  const key = `issue:${skillId}:${issueId}`;
  const raw = await kv.get(key, "json");
  if (!raw) throw new Error("Issue not found");
  const issue = raw as IssueReport;
  issue.status = status;
  await kv.put(key, JSON.stringify(issue));
}

// --- Telemetry-driven issue filing ---

export interface ReproBundle {
  skill_id: string;
  endpoint_id: string;
  intent: string;
  error_message: string;
  error_count: number;
  first_seen: string;
  last_seen: string;
  sample_trace_ids: string[];
}

export interface IssueTemplate {
  title: string;
  body: string;
  labels: string[];
  repo: string;
}

export const ISSUE_FILING_THRESHOLD = 3;

export function buildReproBundle(
  skillId: string,
  endpointId: string,
  errors: Array<{ message: string; trace_id: string; timestamp: string }>,
  intent: string,
): ReproBundle {
  return {
    skill_id: skillId,
    endpoint_id: endpointId,
    intent,
    error_message: errors[0]?.message ?? "unknown",
    error_count: errors.length,
    first_seen: errors[0]?.timestamp ?? new Date().toISOString(),
    last_seen: errors[errors.length - 1]?.timestamp ?? new Date().toISOString(),
    sample_trace_ids: errors.slice(0, 5).map((e) => e.trace_id),
  };
}

export function buildIssueTemplate(bundle: ReproBundle): IssueTemplate {
  const isBackend = bundle.error_message.includes("500") || bundle.error_message.includes("timeout");
  return {
    title: `[auto] ${bundle.endpoint_id}: ${bundle.error_message.slice(0, 80)}`,
    body: [
      "## Auto-filed from telemetry",
      "",
      `**Skill:** ${bundle.skill_id}`,
      `**Endpoint:** ${bundle.endpoint_id}`,
      `**Intent:** ${bundle.intent}`,
      `**Error:** ${bundle.error_message}`,
      `**Occurrences:** ${bundle.error_count}`,
      `**First seen:** ${bundle.first_seen}`,
      `**Last seen:** ${bundle.last_seen}`,
      `**Sample traces:** ${bundle.sample_trace_ids.join(", ")}`,
    ].join("\n"),
    labels: ["auto-filed", "bug"],
    repo: isBackend ? "unbrowse-ai/unbrowse-dev" : "unbrowse-ai/unbrowse",
  };
}

export function shouldFileIssue(errorCount: number): boolean {
  return errorCount >= ISSUE_FILING_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Surface-error feed — the "secret faults" (): the errors users
// actually hit across CLI / frontend / backend (cli_timeout, 426
// client_update_required, ECONNREFUSED, no_route, captcha_block, …), made
// visible on the internal dashboard. Distinct from the agent-filed skill
// IssueReport above (that is per-skill bug reports; this is surface telemetry).
// Low-volume by nature, so it reuses the funnel KV pattern (statsKV) — it does
// NOT re-open the retired high-volume session store (a Neon→IQ non-goal).
// Time-keyed (`error-event:<iso>:<id>`) so listWithValues yields newest-first.
// ---------------------------------------------------------------------------

const ERROR_EVENT_PREFIX = "error-event:";
const SAFE_ERROR_KINDS = new Set([
  "captcha_block", "cli_timeout", "client_update_required", "econnrefused", "http_error", "no_route", "unknown",
]);
const SAFE_ERROR_SURFACES = new Set(["backend", "cli", "frontend", "local-http", "mcp", "sdk", "unknown"]);

export interface SurfaceErrorEvent {
  event_id: string;
  created_at: string;
  /** "cli" | "frontend" | "backend" */
  surface: string;
  /** error kind/code (cli_timeout | client_update_required | ECONNREFUSED | no_route | captcha_block | …) */
  kind: string;
  /** Legacy read shape only. New category-only events never persist diagnostics. */
  message?: string;
  /** Legacy read shape only; never written by recordSurfaceError. */
  context?: Record<string, unknown>;
  install_id?: string;
  session_id?: string;
  version?: string;
  agent_id?: string | null;
}

export async function recordSurfaceError(
  env: Env,
  ev: Omit<SurfaceErrorEvent, "event_id" | "created_at"> &
    Partial<Pick<SurfaceErrorEvent, "event_id" | "created_at">>,
): Promise<SurfaceErrorEvent> {
  const rawSurface = ev.surface.trim().toLowerCase();
  const rawKind = ev.kind.trim().toLowerCase();
  // Error telemetry is category-only. In particular, message/context often
  // contain paths, URLs, selectors, or upstream bodies and are never stored.
  const stored: SurfaceErrorEvent = {
    event_id: generateId(),
    created_at: new Date().toISOString(),
    surface: SAFE_ERROR_SURFACES.has(rawSurface) ? rawSurface : "unknown",
    kind: SAFE_ERROR_KINDS.has(rawKind) ? rawKind : "unknown",
    version: /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,48})?$/.test(ev.version ?? "") ? ev.version!.slice(0, 64) : "unknown",
  };
  await statsKV(env).put(
    `${ERROR_EVENT_PREFIX}${stored.created_at}:${stored.event_id}`,
    JSON.stringify(stored),
  );
  return stored;
}

function tally<T>(items: T[], pick: (e: T) => string): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const e of items) {
    const k = pick(e) || "unknown";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
}

export interface SurfaceErrorSummary {
  total: number;
  by_kind: { key: string; count: number }[];
  by_surface: { key: string; count: number }[];
  by_version: { key: string; count: number }[];
  recent: SurfaceErrorEvent[];
}

/** Load + aggregate recent surface errors (newest-first) for the dashboard. */
export async function loadSurfaceErrors(env: Env, days: number, limit = 200): Promise<SurfaceErrorSummary> {
  const clampedDays = Math.max(1, Math.min(365, Math.trunc(Number.isFinite(days) ? days : 7)));
  const cutoffMs = Date.now() - clampedDays * 86_400_000;
  const entries = await statsKV(env).listWithValues(ERROR_EVENT_PREFIX);
  const events = entries
    .map((e) => {
      try {
        return JSON.parse(e.value) as SurfaceErrorEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is SurfaceErrorEvent => !!e?.kind && !!e?.created_at && Date.parse(e.created_at) >= cutoffMs)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return {
    total: events.length,
    by_kind: tally(events, (event) => {
      const kind = event.kind.trim().toLowerCase();
      return SAFE_ERROR_KINDS.has(kind) ? kind : "unknown";
    }),
    by_surface: tally(events, (event) => {
      const surface = event.surface.trim().toLowerCase();
      return SAFE_ERROR_SURFACES.has(surface) ? surface : "unknown";
    }),
    by_version: tally(events, (event) =>
      /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,48})?$/.test(event.version ?? "") ? event.version!.slice(0, 64) : "unknown",
    ),
    // Retained only for service compatibility; callers must not expose these
    // legacy rows. New events contain categories and timestamp only.
    recent: events.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// Usage-ping feed — answers "is anyone using it?" The CLI fires one ping per
// invocation ({verb, operation, version, install_id}); the rich per-session
// store stays retired (Neon→IQ non-goal). Low-volume KV, time-keyed, same
// pattern as the error feed. Aggregates include operation/use-case, install,
// client, surface/scope, and daily/weekly/monthly trends.
// ---------------------------------------------------------------------------

const USAGE_PING_PREFIX = "usage-ping:";

const SAFE_USAGE_ACTIONS = new Set([
  "account", "act", "agents", "annotate", "auth", "auth_capture", "auth_inventory", "auth_login", "back",
  "breath", "browsers", "build", "capture", "click", "cleanup_stale", "close", "config",
  "connect_chrome", "contract", "contribute", "cookies", "crawl", "create", "dashboard", "diagnose",
  "earnings", "eval", "execute", "explain", "extract", "feedback", "fetch", "fill", "fill_form",
  "forward", "get", "go", "health", "index", "inspect", "login", "map", "markdown", "mcp", "navigate",
  "press", "proxy_rotate", "publish", "publish_bundle", "read", "reflect", "register", "request", "research",
  "resolve", "review", "run", "run_js", "schema", "screenshot", "scroll", "search", "select", "serve", "session_park",
  "session_restore", "sessions", "settings", "setup", "skill", "skill_package", "skills", "snap", "spec_discover",
  "stats", "status", "steal_auth", "submit", "sync", "template", "text", "trace", "type", "unlock", "upgrade",
  "value_source", "version",
]);
const SAFE_USAGE_PREFIXES = new Set(["build", "breath", "eval", "sdk"]);
const SAFE_USAGE_SURFACES = new Set(["cli", "mcp", "sdk", "local-http", "unknown"]);
const SAFE_EXECUTION_SCOPES = new Set(["local", "cloud", "mixed", "unknown"]);

const BUILD_ACTIONS = new Set([
  "annotate", "build", "cleanup_stale", "contribute", "create", "index", "publish", "publish_bundle",
  "register", "review", "setup", "skill_package", "template", "value_source",
]);
const BREATH_ACTIONS = new Set([
  "act", "auth", "auth_capture", "auth_login", "back", "breath", "capture", "click", "close",
  "connect_chrome", "dashboard", "execute", "fetch", "fill", "fill_form", "forward", "get", "go", "login",
  "mcp", "navigate", "press", "proxy_rotate", "run", "run_js", "scroll", "select", "serve", "session_park",
  "session_restore", "submit", "sync", "type", "upgrade",
]);

const RESEARCH_ACTIONS = new Set([
  "crawl", "extract", "fetch", "get", "inspect", "map", "markdown", "read", "research", "resolve", "search",
  "snap", "text",
]);
const INTERACTION_ACTIONS = new Set([
  "act", "back", "breath", "click", "fill", "fill_form", "forward", "go", "navigate", "press", "scroll",
  "select", "submit", "type",
]);
const CAPTURE_REPLAY_ACTIONS = new Set(["capture", "execute", "index", "run", "run_js", "sync", "unlock"]);
const AUTH_SESSION_ACTIONS = new Set([
  "auth", "auth_capture", "auth_inventory", "auth_login", "browsers", "close", "connect_chrome", "cookies",
  "login", "session_park", "session_restore", "sessions", "steal_auth",
]);
const BUILD_PUBLISH_ACTIONS = new Set([
  "annotate", "build", "cleanup_stale", "contribute", "create", "publish", "publish_bundle", "register", "review",
  "setup", "skill_package", "template", "value_source",
]);
const DIAGNOSTIC_ACTIONS = new Set([
  "config", "contract", "diagnose", "eval", "explain", "feedback", "health", "reflect", "schema", "settings",
  "spec_discover", "stats", "status", "trace", "version",
]);
const ACCOUNT_ACTIONS = new Set(["account", "agents", "dashboard", "earnings", "mcp", "serve", "skill", "skills", "upgrade"]);

function normalizedAction(value: string | undefined): string {
  const action = value?.trim().toLowerCase().replaceAll("-", "_") ?? "";
  return SAFE_USAGE_ACTIONS.has(action) ? action : "other";
}

function inferredOperationForAction(action: string): string {
  if (action === "other") return "other";
  if (BUILD_ACTIONS.has(action)) return `build:${action}`;
  if (BREATH_ACTIONS.has(action)) return `breath:${action === "go" ? "navigate" : action}`;
  return `eval:${action}`;
}

/**
 * Turn an untrusted telemetry label into a fixed categorical operation. This is
 * intentionally an allowlist rather than a token regex: a user's natural-language
 * task can also look like a harmless kebab-case token and must never be persisted.
 */
export function normalizeUsageOperation(value: string | undefined, fallbackVerb?: string): string {
  const raw = value?.trim().toLowerCase().replaceAll("-", "_");
  const match = /^([a-z]+):([a-z0-9_]+)$/.exec(raw ?? "");
  if (match && SAFE_USAGE_PREFIXES.has(match[1]) && SAFE_USAGE_ACTIONS.has(match[2])) {
    return `${match[1]}:${match[2]}`;
  }
  return inferredOperationForAction(normalizedAction(fallbackVerb));
}

function normalizeUsageVerb(value: string | undefined, operation: string): string {
  const direct = normalizedAction(value);
  if (direct !== "other") return direct;
  const action = operation.split(":")[1];
  return normalizedAction(action);
}

function normalizeUsageVersion(value: string | undefined): string {
  const version = value?.trim() ?? "";
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,48})?$/.test(version) ? version.slice(0, 64) : "unknown";
}

function normalizeUsageInstallId(value: string | undefined): string | undefined {
  const installId = value?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{16}$/.test(installId) ? installId : undefined;
}

function normalizeUsageSurface(value: UsagePing["surface"]): NonNullable<UsagePing["surface"]> {
  return value && SAFE_USAGE_SURFACES.has(value) ? value : "unknown";
}

function normalizeExecutionScope(value: UsagePing["execution_scope"]): NonNullable<UsagePing["execution_scope"]> {
  return value && SAFE_EXECUTION_SCOPES.has(value) ? value : "unknown";
}

export type UsageUseCase =
  | "research_retrieval"
  | "browser_interaction"
  | "capture_replay"
  | "auth_sessions"
  | "build_publish"
  | "diagnostics"
  | "account_platform"
  | "other";

export function useCaseForUsageOperation(operation: string): UsageUseCase {
  const [prefix, rawAction] = operation.split(":");
  const action = normalizedAction(rawAction ?? operation);
  if (AUTH_SESSION_ACTIONS.has(action)) return "auth_sessions";
  if (BUILD_PUBLISH_ACTIONS.has(action) || prefix === "build") return "build_publish";
  if (CAPTURE_REPLAY_ACTIONS.has(action)) return "capture_replay";
  if (INTERACTION_ACTIONS.has(action) || (prefix === "breath" && action === "other")) return "browser_interaction";
  if (RESEARCH_ACTIONS.has(action)) return "research_retrieval";
  if (DIAGNOSTIC_ACTIONS.has(action) || (prefix === "eval" && action === "other")) return "diagnostics";
  if (ACCOUNT_ACTIONS.has(action)) return "account_platform";
  return "other";
}

function weekKey(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

export interface UsagePing {
  event_id: string;
  created_at: string;
  verb: string;
  /** Fixed, argument-free operation identity (for example `breath:get`). */
  operation?: string;
  version?: string;
  install_id?: string;
  agent_id?: string | null;
  surface?: "cli" | "mcp" | "sdk" | "local-http" | "unknown";
  execution_scope?: "local" | "cloud" | "mixed" | "unknown";
  telemetry_schema_version?: number;
}

export async function recordUsagePing(
  env: Env,
  ping: Omit<UsagePing, "event_id" | "created_at"> & Partial<Pick<UsagePing, "event_id" | "created_at">>,
): Promise<UsagePing> {
  const operation = normalizeUsageOperation(ping.operation, ping.verb);
  const stored: UsagePing = {
    event_id: ping.event_id ?? generateId(),
    created_at: ping.created_at ?? new Date().toISOString(),
    verb: normalizeUsageVerb(ping.verb, operation),
    operation,
    version: normalizeUsageVersion(ping.version),
    install_id: normalizeUsageInstallId(ping.install_id),
    surface: normalizeUsageSurface(ping.surface),
    execution_scope: normalizeExecutionScope(ping.execution_scope),
    telemetry_schema_version: Math.max(0, Math.trunc(ping.telemetry_schema_version ?? 0)),
  };
  await statsKV(env).put(`${USAGE_PING_PREFIX}${stored.created_at}:${stored.event_id}`, JSON.stringify(stored));
  return stored;
}

export interface UsagePingSummary {
  total: number;
  active_installs: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  by_verb: { key: string; count: number }[];
  by_operation: { key: string; count: number }[];
  by_use_case: { key: UsageUseCase; count: number }[];
  by_version: { key: string; count: number }[];
  by_day: { key: string; count: number }[];
  by_week: { key: string; count: number }[];
  by_month: { key: string; count: number }[];
  by_surface: { key: string; count: number }[];
  by_execution_scope: { key: string; count: number }[];
  telemetry_schema_coverage: number;
  operation_detail_coverage: number;
  interpretation: "observed_minimum";
}

export async function loadUsagePings(env: Env, days: number): Promise<UsagePingSummary> {
  const clampedDays = Math.max(1, Math.min(365, Math.trunc(Number.isFinite(days) ? days : 7)));
  const cutoffMs = Date.now() - clampedDays * 86_400_000;
  const entries = await statsKV(env).listWithValues(USAGE_PING_PREFIX);
  const pings = entries
    .map((e) => {
      try {
        return JSON.parse(e.value) as UsagePing;
      } catch {
        return null;
      }
    })
    .filter((p): p is UsagePing => !!p?.verb && !!p?.created_at && Date.parse(p.created_at) >= cutoffMs)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const installs = new Set<string>();
  for (const p of pings) if (p.install_id) installs.add(p.install_id);
  const operationFor = (ping: UsagePing) => normalizeUsageOperation(ping.operation, ping.verb);
  return {
    total: pings.length,
    active_installs: installs.size,
    first_seen_at: pings[0]?.created_at ?? null,
    last_seen_at: pings.at(-1)?.created_at ?? null,
    by_verb: tally(pings, (p) => normalizeUsageVerb(p.verb, operationFor(p))),
    by_operation: tally(pings, operationFor),
    by_use_case: tally(pings, (p) => useCaseForUsageOperation(operationFor(p))) as { key: UsageUseCase; count: number }[],
    by_version: tally(pings, (p) => normalizeUsageVersion(p.version)),
    by_day: tally(pings, (p) => p.created_at.slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key)),
    by_week: tally(pings, (p) => weekKey(p.created_at)).sort((a, b) => a.key.localeCompare(b.key)),
    by_month: tally(pings, (p) => p.created_at.slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    by_surface: tally(pings, (p) => normalizeUsageSurface(p.surface)),
    by_execution_scope: tally(pings, (p) => normalizeExecutionScope(p.execution_scope)),
    telemetry_schema_coverage: pings.length > 0
      ? Math.round((pings.filter((p) => (p.telemetry_schema_version ?? 0) >= 1).length / pings.length) * 10_000) / 10_000
      : 0,
    operation_detail_coverage: pings.length > 0
      ? Math.round((pings.filter((p) => !!p.operation && normalizeUsageOperation(p.operation, p.verb) !== "other").length / pings.length) * 10_000) / 10_000
      : 0,
    interpretation: "observed_minimum",
  };
}
