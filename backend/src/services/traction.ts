import type { Env } from "../types.js";
import { statsKV } from "./kv.js";
import { getEngagement } from "./analytics.js";

export interface TractionMetrics {
  totalKeys: number;
  totalVerifications: number;
  wau: number;
  weeklyRetention: number;
  githubStars: number;
  githubForks: number;
  npmDownloadsTotal: number;
  npmDownloadsWeekly: number;
  cloudflare: {
    totalRequests: number;
    uniqueVisitors: number;
    bandwidthGB: number;
    source: "graphql" | "unconfigured" | "error";
  };
  verificationFunnel: {
    totalRegistered: number;
    verified1Plus: number;
    verified10Plus: number;
    verified100Plus: number;
    verified1000Plus: number;
  };
  recentSpikes?: Array<{ day: string; verifications: number }>;
  dau?: Array<{ day: string; active_keys: number }>;
}

async function countLocalKeys(env: Env): Promise<number> {
  try {
    const entries = await statsKV(env).list({ prefix: "keyhash:", limit: 1000 });
    return entries.keys.length;
  } catch (error) {
    console.error("Failed to count local keys:", error);
    return 0;
  }
}

interface VersionHistoryEntry {
  version: string;
  status: "pass" | "fail";
  verified_at: string;
  agent_id?: string;
}

interface StoredEndpointStats {
  version_history?: VersionHistoryEntry[];
}

/**
 * Scan `stats:*` records and collect every verified pass with its agent.
 * The previous implementation queried namespace='stats' WHERE key LIKE
 * 'verification:%' but nothing in the codebase ever writes to that prefix;
 * the real verification signal lives in version_history[] on each
 * stats:{skill_id}--{endpoint_id} record (see scoring.ts).
 */
async function scanVersionHistory(env: Env): Promise<{
  totalPasses: number;
  passesByAgent: Map<string, number>;
}> {
  const passesByAgent = new Map<string, number>();
  let totalPasses = 0;
  try {
    const entries = await statsKV(env).listWithValues("stats:");
    for (const { value } of entries) {
      try {
        const stats = JSON.parse(value) as StoredEndpointStats;
        for (const v of stats.version_history ?? []) {
          if (v.status !== "pass") continue;
          totalPasses++;
          if (v.agent_id) {
            passesByAgent.set(v.agent_id, (passesByAgent.get(v.agent_id) ?? 0) + 1);
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch (error) {
    console.error("Failed to scan version history:", error);
  }
  return { totalPasses, passesByAgent };
}

async function fetchGitHubStats(env: Env): Promise<{ stars: number; forks: number }> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": "unbrowse-stats/1.0",
      "Accept": "application/vnd.github+json",
    };
    if (env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
    const response = await fetch("https://api.github.com/repos/unbrowse-ai/unbrowse", { headers });
    if (!response.ok) {
      console.error(`GitHub fetch ${response.status}: ${await response.text().catch(() => "")}`);
      return { stars: 0, forks: 0 };
    }
    const data = await response.json() as { stargazers_count?: number; forks_count?: number };
    return {
      stars: data.stargazers_count || 0,
      forks: data.forks_count || 0,
    };
  } catch (error) {
    console.error("Failed to fetch GitHub stats:", error);
    return { stars: 0, forks: 0 };
  }
}

async function fetchNpmStats(): Promise<{ total: number; weekly: number }> {
  try {
    const [totalRes, weeklyRes] = await Promise.all([
      fetch("https://api.npmjs.org/downloads/point/1970-01-01:2099-12-31/unbrowse"),
      fetch("https://api.npmjs.org/downloads/point/last-week/unbrowse"),
    ]);

    const totalData = totalRes.ok ? await totalRes.json() as { downloads?: number } : null;
    const weeklyData = weeklyRes.ok ? await weeklyRes.json() as { downloads?: number } : null;

    return {
      total: totalData?.downloads || 0,
      weekly: weeklyData?.downloads || 0,
    };
  } catch (error) {
    console.error("Failed to fetch npm stats:", error);
    return { total: 0, weekly: 0 };
  }
}

interface CloudflareGraphQLResponse {
  data?: {
    viewer?: {
      zones?: Array<{
        httpRequests1dGroups?: Array<{
          sum?: { requests?: number; bytes?: number };
          uniq?: { uniques?: number };
        }>;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Query Cloudflare GraphQL Analytics for the last 30 days of zone traffic.
 * Returns honest zeros with source:"unconfigured" when the env bindings are
 * unset (the previous implementation returned a hardcoded placeholder).
 */
async function fetchCloudflareStats(env: Env): Promise<{
  totalRequests: number;
  uniqueVisitors: number;
  bandwidthGB: number;
  source: "graphql" | "unconfigured" | "error";
}> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) {
    return { totalRequests: 0, uniqueVisitors: 0, bandwidthGB: 0, source: "unconfigured" };
  }
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const query = `
      query Traction($zoneTag: String!, $since: Date!) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            httpRequests1dGroups(
              filter: { date_geq: $since }
              orderBy: [date_ASC]
              limit: 30
            ) {
              sum { requests bytes }
              uniq { uniques }
            }
          }
        }
      }
    `;
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { zoneTag: env.CLOUDFLARE_ZONE_ID, since } }),
    });
    if (!res.ok) {
      console.error(`Cloudflare GraphQL ${res.status}: ${await res.text().catch(() => "")}`);
      return { totalRequests: 0, uniqueVisitors: 0, bandwidthGB: 0, source: "error" };
    }
    const body = await res.json() as CloudflareGraphQLResponse;
    if (body.errors?.length) {
      console.error("Cloudflare GraphQL errors:", body.errors.map(e => e.message).join("; "));
      return { totalRequests: 0, uniqueVisitors: 0, bandwidthGB: 0, source: "error" };
    }
    const groups = body.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? [];
    let totalRequests = 0;
    let totalBytes = 0;
    let uniqueVisitors = 0;
    for (const g of groups) {
      totalRequests += g.sum?.requests ?? 0;
      totalBytes += g.sum?.bytes ?? 0;
      uniqueVisitors += g.uniq?.uniques ?? 0;
    }
    return {
      totalRequests,
      uniqueVisitors,
      bandwidthGB: Math.round((totalBytes / 1_073_741_824) * 10) / 10,
      source: "graphql",
    };
  } catch (error) {
    console.error("Failed to fetch Cloudflare stats:", error);
    return { totalRequests: 0, uniqueVisitors: 0, bandwidthGB: 0, source: "error" };
  }
}

function buildVerificationFunnel(
  totalRegistered: number,
  passesByAgent: Map<string, number>,
): TractionMetrics["verificationFunnel"] {
  const counts = [...passesByAgent.values()];
  return {
    totalRegistered,
    verified1Plus: counts.filter(n => n >= 1).length,
    verified10Plus: counts.filter(n => n >= 10).length,
    verified100Plus: counts.filter(n => n >= 100).length,
    verified1000Plus: counts.filter(n => n >= 1000).length,
  };
}

/**
 * Weekly retention: agents active in BOTH the prior 7 days and the
 * preceding 7 days, divided by agents active in the preceding 7 days.
 * Derived from agent:{id}.activity_dates[] (the same source getEngagement
 * uses for WAU). 0 when prior week is empty.
 */
async function computeWeeklyRetention(env: Env): Promise<number> {
  try {
    const entries = await statsKV(env).listWithValues("agent:");
    const todayMs = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const cutoffCurrent = new Date(todayMs - 7 * day).toISOString().slice(0, 10);
    const cutoffPrior = new Date(todayMs - 14 * day).toISOString().slice(0, 10);
    const currentWeek = new Set<string>();
    const priorWeek = new Set<string>();
    for (const { value } of entries) {
      try {
        const p = JSON.parse(value) as { agent_id?: string; activity_dates?: string[] };
        if (!p.agent_id) continue;
        for (const d of p.activity_dates ?? []) {
          if (d >= cutoffCurrent) currentWeek.add(p.agent_id);
          else if (d >= cutoffPrior) priorWeek.add(p.agent_id);
        }
      } catch { /* skip */ }
    }
    if (priorWeek.size === 0) return 0;
    let retained = 0;
    for (const id of priorWeek) if (currentWeek.has(id)) retained++;
    return Math.round((retained / priorWeek.size) * 100) / 100;
  } catch (error) {
    console.error("Failed to compute weekly retention:", error);
    return 0;
  }
}

export async function getTractionMetrics(env: Env): Promise<TractionMetrics> {
  const [
    totalKeys,
    versionHistory,
    engagement,
    weeklyRetention,
    githubStats,
    npmStats,
    cloudflareStats,
    profileCount,
  ] = await Promise.all([
    countLocalKeys(env),
    scanVersionHistory(env),
    getEngagement(env),
    computeWeeklyRetention(env),
    fetchGitHubStats(env),
    fetchNpmStats(),
    fetchCloudflareStats(env),
    statsKV(env).list({ prefix: "agent:", limit: 1000 }).then(r => r.keys.length).catch(() => 0),
  ]);

  return {
    totalKeys,
    totalVerifications: versionHistory.totalPasses,
    wau: engagement.wau,
    weeklyRetention,
    githubStars: githubStats.stars,
    githubForks: githubStats.forks,
    npmDownloadsTotal: npmStats.total,
    npmDownloadsWeekly: npmStats.weekly,
    cloudflare: cloudflareStats,
    verificationFunnel: buildVerificationFunnel(profileCount, versionHistory.passesByAgent),
    dau: engagement.daily_trend.map(d => ({ day: d.date, active_keys: d.active })),
  };
}
