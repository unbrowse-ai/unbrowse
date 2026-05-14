// Telemetry triage worker.
//
// Pulls recent telemetry_sessions rows from Postgres (Neon via DATABASE_URL),
// clusters by (host_template, tool_sequence_prefix, terminal_error_code,
// reflection_status), and opens GitHub issues on unbrowse-dev for new
// failure clusters with the `triage-needed` label. A maintainer curates from
// there.
//
// Hardcoding guard: this module derives cluster keys from data observed
// in the events stream. It does NOT have a hardcoded list of "bad hosts"
// or "slow thresholds" — clusters are formed by structural similarity
// of what the agent did, not by what we think is a bug.

import type { Env } from "../types.js";
import { getNeonClient } from "../services/neon.js";

const TRIAGE_LOOKBACK_MS = 60 * 60 * 1_000; // last hour
const TOOL_SEQUENCE_PREFIX_LEN = 4;
const CLUSTER_PROMOTE_MIN_COUNT = 5;
const FAILURE_REFLECTION_STATES = new Set(["failed", "partial", "missing"]);
const DEFAULT_GH_REPO = "unbrowse-ai/unbrowse-dev";
const DEFAULT_TRIAGE_LABEL = "triage-needed";

type TelemetryRow = {
  session_id: string;
  events_json: string;
  reflection_status: string | null;
  received_at: string | number;
};

type ParsedEvent = Record<string, unknown> & { event?: string };

function parseEvents(rowEventsJson: string): ParsedEvent[] {
  try {
    const arr = JSON.parse(rowEventsJson);
    return Array.isArray(arr) ? (arr as ParsedEvent[]) : [];
  } catch {
    return [];
  }
}

function extractHostTemplate(events: ParsedEvent[]): string {
  for (const ev of events) {
    if (ev.event !== "tool_start") continue;
    const args = ev.args_fingerprint as Record<string, unknown> | undefined;
    if (!args) continue;
    const url = args.url as { host?: string; path_template?: string } | undefined;
    if (url?.host && url?.path_template) {
      return `${url.host}${url.path_template}`;
    }
  }
  return "<unknown>";
}

function extractToolSequence(events: ParsedEvent[]): string[] {
  return events
    .filter((e) => e.event === "tool_start" && typeof e.tool === "string")
    .map((e) => String(e.tool))
    .slice(0, TOOL_SEQUENCE_PREFIX_LEN);
}

function extractTerminalErrorCode(events: ParsedEvent[]): string {
  const ends = events.filter((e) => e.event === "tool_end");
  for (let i = ends.length - 1; i >= 0; i--) {
    const code = (ends[i] as { error_code?: string }).error_code;
    if (typeof code === "string") return code;
  }
  return "<none>";
}

async function sha16(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export type TriageClusterSummary = {
  cluster_key: string;
  host_template: string;
  tool_sequence: string[];
  terminal_error_code: string;
  reflection_status: string;
  session_count: number;
  representative_sessions: string[];
  first_seen_at: number;
  last_seen_at: number;
};

function rowReceivedAtMs(value: string | number): number {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export async function buildClustersFromRows(rows: TelemetryRow[]): Promise<TriageClusterSummary[]> {
  const map = new Map<string, TriageClusterSummary>();
  for (const row of rows) {
    const events = parseEvents(row.events_json);
    if (events.length === 0) continue;
    const host = extractHostTemplate(events);
    const seq = extractToolSequence(events);
    const err = extractTerminalErrorCode(events);
    const refl = row.reflection_status ?? "unknown";
    const keySrc = `${host}|${seq.join(",")}|${err}|${refl}`;
    const cluster_key = await sha16(keySrc);
    const receivedMs = rowReceivedAtMs(row.received_at);
    const existing = map.get(cluster_key);
    if (existing) {
      existing.session_count += 1;
      if (existing.representative_sessions.length < 5) existing.representative_sessions.push(row.session_id);
      existing.first_seen_at = Math.min(existing.first_seen_at, receivedMs);
      existing.last_seen_at = Math.max(existing.last_seen_at, receivedMs);
    } else {
      map.set(cluster_key, {
        cluster_key,
        host_template: host,
        tool_sequence: seq,
        terminal_error_code: err,
        reflection_status: refl,
        session_count: 1,
        representative_sessions: [row.session_id],
        first_seen_at: receivedMs,
        last_seen_at: receivedMs,
      });
    }
  }
  return Array.from(map.values());
}

async function pullRecentRows(env: Env): Promise<TelemetryRow[]> {
  if (!env.DATABASE_URL) return [];
  const sql = await getNeonClient(env.DATABASE_URL);
  const sinceIso = new Date(Date.now() - TRIAGE_LOOKBACK_MS).toISOString();
  const rows = await sql`
    SELECT session_id, events_json::text AS events_json, reflection_status,
           EXTRACT(EPOCH FROM received_at) * 1000 AS received_at
    FROM telemetry_sessions
    WHERE received_at >= ${sinceIso}
    ORDER BY received_at ASC
  ` as TelemetryRow[];
  return rows ?? [];
}

async function dedupeAgainstExisting(env: Env, clusters: TriageClusterSummary[]): Promise<TriageClusterSummary[]> {
  if (!env.DATABASE_URL || clusters.length === 0) return clusters;
  const sql = await getNeonClient(env.DATABASE_URL);
  const keys = clusters.map((c) => c.cluster_key);
  const rows = await sql`
    SELECT cluster_key FROM telemetry_clusters WHERE cluster_key = ANY(${keys})
  ` as Array<{ cluster_key: string }>;
  const known = new Set((rows ?? []).map((r) => r.cluster_key));
  return clusters.filter((c) => !known.has(c.cluster_key));
}

async function persistCluster(env: Env, cluster: TriageClusterSummary, issueUrl?: string): Promise<void> {
  if (!env.DATABASE_URL) return;
  const sql = await getNeonClient(env.DATABASE_URL);
  const firstSeen = new Date(cluster.first_seen_at).toISOString();
  const lastSeen = new Date(cluster.last_seen_at).toISOString();
  await sql`
    INSERT INTO telemetry_clusters
      (cluster_key, first_seen_at, last_seen_at, session_count, github_issue_url, representative_sessions)
    VALUES (
      ${cluster.cluster_key}, ${firstSeen}, ${lastSeen}, ${cluster.session_count},
      ${issueUrl ?? null}, ${JSON.stringify(cluster.representative_sessions)}
    )
    ON CONFLICT (cluster_key) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at,
      session_count = EXCLUDED.session_count,
      github_issue_url = COALESCE(EXCLUDED.github_issue_url, telemetry_clusters.github_issue_url),
      representative_sessions = EXCLUDED.representative_sessions
  `;
}

function getGithubRepo(env: Env): string {
  const r = (env as unknown as Record<string, unknown>).GITHUB_TRIAGE_REPO;
  return (typeof r === "string" && r) ? r : DEFAULT_GH_REPO;
}

function getGithubToken(env: Env): string | undefined {
  const triage = (env as unknown as Record<string, unknown>).GITHUB_TRIAGE_TOKEN;
  if (typeof triage === "string" && triage) return triage;
  // Fall back to the existing PR-bot token if no dedicated triage token is set.
  if (env.GITHUB_PR_BOT_TOKEN) return env.GITHUB_PR_BOT_TOKEN;
  return undefined;
}

export async function stageGithubIssue(env: Env, cluster: TriageClusterSummary): Promise<string | undefined> {
  const token = getGithubToken(env);
  if (!token) return undefined;
  const repo = getGithubRepo(env);

  const title = `[telemetry] ${cluster.host_template} ${cluster.terminal_error_code} ×${cluster.session_count}`;
  const body = [
    "Auto-staged from MCP telemetry triage. Investigate and either fix or close.",
    "",
    `- **Cluster key:** \`${cluster.cluster_key}\``,
    `- **Host template:** \`${cluster.host_template}\``,
    `- **Tool sequence:** \`${cluster.tool_sequence.join(" → ")}\``,
    `- **Terminal error code:** \`${cluster.terminal_error_code}\``,
    `- **Reflection status:** \`${cluster.reflection_status}\``,
    `- **Session count (last hour):** ${cluster.session_count}`,
    `- **Representative sessions:** ${cluster.representative_sessions.map((s) => `\`${s}\``).join(", ")}`,
    `- **First seen:** ${new Date(cluster.first_seen_at).toISOString()}`,
    `- **Last seen:** ${new Date(cluster.last_seen_at).toISOString()}`,
    "",
    "Inspect raw events via `SELECT events_json FROM telemetry_sessions WHERE session_id = ANY(...)`.",
    "Source spec: `docs/mcp-telemetry-plan.md`.",
  ].join("\n");

  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "unbrowse-telemetry-triage",
      },
      body: JSON.stringify({ title, body, labels: [DEFAULT_TRIAGE_LABEL] }),
    });
    if (!resp.ok) {
      console.error("[triage-telemetry] GitHub stage non-2xx:", resp.status, await resp.text().catch(() => ""));
      return undefined;
    }
    const json = (await resp.json()) as { html_url?: string };
    return json.html_url;
  } catch (err) {
    console.error("[triage-telemetry] GitHub stage failed:", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

export async function runTelemetryTriage(env: Env): Promise<{ scanned: number; new_clusters: number; staged: number }> {
  const rows = await pullRecentRows(env);
  if (rows.length === 0) return { scanned: 0, new_clusters: 0, staged: 0 };

  const allClusters = await buildClustersFromRows(rows);
  const newClusters = await dedupeAgainstExisting(env, allClusters);

  let staged = 0;
  for (const c of newClusters) {
    const shouldStage = c.session_count >= CLUSTER_PROMOTE_MIN_COUNT && FAILURE_REFLECTION_STATES.has(c.reflection_status);
    const issueUrl = shouldStage ? await stageGithubIssue(env, c) : undefined;
    await persistCluster(env, c, issueUrl);
    if (issueUrl) staged += 1;
  }

  return { scanned: rows.length, new_clusters: newClusters.length, staged };
}
