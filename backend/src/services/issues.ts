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

/**
 * Record a failed execution against the telemetry error buffer.
 * When the error count for a skill+endpoint reaches ISSUE_FILING_THRESHOLD,
 * automatically builds a ReproBundle + IssueTemplate and files an IssueReport.
 *
 * This is the post-execution hook that wires shouldFileIssue → buildReproBundle
 * → buildIssueTemplate → createIssue.
 */
export async function recordExecutionError(
  env: Env,
  skillId: string,
  endpointId: string,
  intent: string,
  error: string,
  traceId: string,
): Promise<void> {
  const kv = statsKV(env);
  const bufKey = `err-buf:${skillId}:${endpointId}`;
  const raw = await kv.get(bufKey) as string | null;
  const buf: Array<{ message: string; trace_id: string; timestamp: string }> = raw
    ? (JSON.parse(raw) as Array<{ message: string; trace_id: string; timestamp: string }>)
    : [];

  buf.push({ message: error, trace_id: traceId, timestamp: new Date().toISOString() });

  // Keep at most 50 entries to bound buffer size
  if (buf.length > 50) buf.splice(0, buf.length - 50);

  await kv.put(bufKey, JSON.stringify(buf));

  if (!shouldFileIssue(buf.length)) return;

  // Build and file the issue, then clear the buffer to avoid duplicate filings
  const bundle = buildReproBundle(skillId, endpointId, buf, intent);
  const template = buildIssueTemplate(bundle);

  await createIssue(
    env,
    skillId,
    "__telemetry__",
    "broken",
    `${template.title}\n\n${template.body}`,
    endpointId,
    buf[buf.length - 1]?.trace_id,
  );

  // Reset the buffer so the next wave of errors starts a fresh count
  await kv.put(bufKey, JSON.stringify([]));
}
