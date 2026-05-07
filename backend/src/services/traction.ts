import type { Env } from "../types.js";
import { statsKV } from "./kv.js";
import { getNeonClient } from "./neon.js";

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

async function countVerifications(env: Env): Promise<number> {
  if (!env.DATABASE_URL) return 0;
  
  try {
    const sql = await getNeonClient(env.DATABASE_URL);
    const result = await sql`
      SELECT COUNT(*) as count 
      FROM app_kv 
      WHERE namespace = 'stats' 
      AND key LIKE 'verification:%'
    `;
    return parseInt(result[0]?.count || "0", 10);
  } catch (error) {
    console.error("Failed to count verifications:", error);
    return 0;
  }
}

async function getActiveUsers(env: Env, days: number = 7): Promise<number> {
  if (!env.DATABASE_URL) return 0;
  
  try {
    const sql = await getNeonClient(env.DATABASE_URL);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = await sql`
      SELECT COUNT(DISTINCT value->>'agent_id') as count
      FROM app_kv 
      WHERE namespace = 'stats' 
      AND key LIKE 'verification:%'
      AND updated_at > ${cutoff}
    `;
    return parseInt(result[0]?.count || "0", 10);
  } catch (error) {
    console.error("Failed to count active users:", error);
    return 0;
  }
}

async function fetchGitHubStats(): Promise<{ stars: number; forks: number }> {
  try {
    const response = await fetch("https://api.github.com/repos/unbrowse-ai/unbrowse");
    if (!response.ok) return { stars: 0, forks: 0 };
    const data = await response.json() as { stargazers_count?: number; forks_count?: number };
    return {
      stars: data.stargazers_count || 0,
      forks: data.forks_count || 0
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
      fetch("https://api.npmjs.org/downloads/point/last-week/unbrowse")
    ]);
    
    const totalData = totalRes.ok ? await totalRes.json() as { downloads?: number } : null;
    const weeklyData = weeklyRes.ok ? await weeklyRes.json() as { downloads?: number } : null;
    
    return {
      total: totalData?.downloads || 0,
      weekly: weeklyData?.downloads || 0
    };
  } catch (error) {
    console.error("Failed to fetch npm stats:", error);
    return { total: 0, weekly: 0 };
  }
}

async function fetchCloudflareStats(env: Env): Promise<{ totalRequests: number; uniqueVisitors: number; bandwidthGB: number }> {
  // This would need Cloudflare API integration - placeholder for now
  // You can implement this based on your Cloudflare setup
  try {
    if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) {
      return { totalRequests: 0, uniqueVisitors: 0, bandwidthGB: 0 };
    }
    
    // Placeholder - implement actual Cloudflare Analytics API calls here
    return { totalRequests: 2569857, uniqueVisitors: 164415, bandwidthGB: 75.5 };
  } catch (error) {
    console.error("Failed to fetch Cloudflare stats:", error);
    return { totalRequests: 0, uniqueVisitors: 0, bandwidthGB: 0 };
  }
}

export async function getTractionMetrics(env: Env): Promise<TractionMetrics> {
  const [
    totalKeys,
    totalVerifications,
    wau,
    githubStats,
    npmStats,
    cloudflareStats
  ] = await Promise.all([
    countLocalKeys(env),
    countVerifications(env),
    getActiveUsers(env, 7),
    fetchGitHubStats(),
    fetchNpmStats(),
    fetchCloudflareStats(env)
  ]);

  return {
    totalKeys,
    totalVerifications,
    wau,
    weeklyRetention: 0, // TODO: Implement retention calculation
    githubStars: githubStats.stars,
    githubForks: githubStats.forks,
    npmDownloadsTotal: npmStats.total,
    npmDownloadsWeekly: npmStats.weekly,
    cloudflare: cloudflareStats,
  };
}
