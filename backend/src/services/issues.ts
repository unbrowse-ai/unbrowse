import type { Env } from "../types.js";

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
  await env.STATS_KV.put(`issue:${skillId}:${issue.issue_id}`, JSON.stringify(issue));

  // Update the index (most recent 100)
  const idxKey = `issue-idx:${skillId}`;
  const raw = await env.STATS_KV.get(idxKey);
  const ids: string[] = raw ? JSON.parse(raw) : [];
  ids.unshift(issue.issue_id);
  if (ids.length > 100) ids.length = 100;
  await env.STATS_KV.put(idxKey, JSON.stringify(ids));

  return issue;
}

export async function listIssues(
  env: Env,
  skillId: string,
  status?: IssueStatus,
  limit = 20
): Promise<IssueReport[]> {
  const idxKey = `issue-idx:${skillId}`;
  const raw = await env.STATS_KV.get(idxKey);
  if (!raw) return [];

  const ids: string[] = JSON.parse(raw);
  const issues = await Promise.all(
    ids.slice(0, limit).map((id) => env.STATS_KV.get(`issue:${skillId}:${id}`, "json"))
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
  const key = `issue:${skillId}:${issueId}`;
  const raw = await env.STATS_KV.get(key, "json");
  if (!raw) throw new Error("Issue not found");
  const issue = raw as IssueReport;
  issue.status = status;
  await env.STATS_KV.put(key, JSON.stringify(issue));
}
