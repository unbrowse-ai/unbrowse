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
// Surface-error feed — the "secret faults" (Psalms 19:12): the errors users
// actually hit across CLI / frontend / backend (cli_timeout, 426
// client_update_required, ECONNREFUSED, no_route, captcha_block, …), made
// visible on the internal dashboard. Distinct from the agent-filed skill
// IssueReport above (that is per-skill bug reports; this is surface telemetry).
// Low-volume by nature, so it reuses the funnel KV pattern (statsKV) — it does
// NOT re-open the retired high-volume session store (a Neon→IQ non-goal).
// Time-keyed (`error-event:<iso>:<id>`) so listWithValues yields newest-first.
// ---------------------------------------------------------------------------

const ERROR_EVENT_PREFIX = "error-event:";
const MAX_ERROR_MSG = 1000;

export interface SurfaceErrorEvent {
  event_id: string;
  created_at: string;
  /** "cli" | "frontend" | "backend" */
  surface: string;
  /** error kind/code (cli_timeout | client_update_required | ECONNREFUSED | no_route | captcha_block | …) */
  kind: string;
  message?: string;
  /** pointer-only op/route/intent context, NEVER credentials */
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
  const stored: SurfaceErrorEvent = {
    event_id: ev.event_id ?? generateId(),
    created_at: ev.created_at ?? new Date().toISOString(),
    surface: ev.surface,
    kind: ev.kind,
    message: ev.message ? ev.message.slice(0, MAX_ERROR_MSG) : undefined,
    context: ev.context,
    install_id: ev.install_id,
    session_id: ev.session_id,
    version: ev.version,
    agent_id: ev.agent_id ?? null,
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
    by_kind: tally(events, (e) => e.kind),
    by_surface: tally(events, (e) => e.surface),
    by_version: tally(events, (e) => e.version ?? "unknown"),
    recent: events.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// Usage-ping feed — answers "is anyone using it?" The CLI fires one ping per
// invocation ({verb, version, install_id}); the rich per-session store stays
// retired (Neon→IQ non-goal). Low-volume KV, time-keyed, same pattern as the
// error feed. Aggregates: total invocations, distinct active installs, by verb,
// by version, and a per-day series — the real usage signal the retired analytics
// feed can't give.
// ---------------------------------------------------------------------------

const USAGE_PING_PREFIX = "usage-ping:";

export interface UsagePing {
  event_id: string;
  created_at: string;
  verb: string;
  version?: string;
  install_id?: string;
  agent_id?: string | null;
}

export async function recordUsagePing(
  env: Env,
  ping: Omit<UsagePing, "event_id" | "created_at"> & Partial<Pick<UsagePing, "event_id" | "created_at">>,
): Promise<UsagePing> {
  const stored: UsagePing = {
    event_id: ping.event_id ?? generateId(),
    created_at: ping.created_at ?? new Date().toISOString(),
    verb: ping.verb,
    version: ping.version,
    install_id: ping.install_id,
    agent_id: ping.agent_id ?? null,
  };
  await statsKV(env).put(`${USAGE_PING_PREFIX}${stored.created_at}:${stored.event_id}`, JSON.stringify(stored));
  return stored;
}

export interface UsagePingSummary {
  total: number;
  active_installs: number;
  by_verb: { key: string; count: number }[];
  by_version: { key: string; count: number }[];
  by_day: { key: string; count: number }[];
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
    .filter((p): p is UsagePing => !!p?.verb && !!p?.created_at && Date.parse(p.created_at) >= cutoffMs);
  const installs = new Set<string>();
  for (const p of pings) if (p.install_id) installs.add(p.install_id);
  return {
    total: pings.length,
    active_installs: installs.size,
    by_verb: tally(pings, (p) => p.verb),
    by_version: tally(pings, (p) => p.version ?? "unknown"),
    by_day: tally(pings, (p) => p.created_at.slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key)),
  };
}
