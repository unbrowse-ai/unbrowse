import type { Env } from "../types.js";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const MAX_WINDOW_DAYS = 30;

export interface CloudflareWorkerUsage {
  configured: boolean;
  source: "cloudflare_graphql";
  authoritative_for: "requests_reaching_worker_only";
  window_days: number;
  script_name?: string;
  requests: number | null;
  subrequests: number | null;
  errors: number | null;
  error_rate: number | null;
  cpu_time_p50_us: number | null;
  cpu_time_p99_us: number | null;
  sampled: boolean;
  unavailable_reason?: "not_configured" | "query_failed" | "graphql_error" | "no_account";
}

type InvocationRow = {
  sum?: { requests?: number; subrequests?: number; errors?: number };
  quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number };
};

const QUERY = `query GetWorkersAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
  viewer { accounts(filter: {accountTag: $accountTag}) {
    workersInvocationsAdaptive(limit: 100, filter: {scriptName: $scriptName, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd}) {
      sum { subrequests requests errors }
    }
  } }
}`;

export async function getCloudflareWorkerUsage(env: Env, requestedDays: number): Promise<CloudflareWorkerUsage> {
  const windowDays = Math.max(1, Math.min(MAX_WINDOW_DAYS, Math.trunc(requestedDays || 30)));
  const base: CloudflareWorkerUsage = {
    configured: false, source: "cloudflare_graphql", authoritative_for: "requests_reaching_worker_only",
    window_days: windowDays, script_name: env.CLOUDFLARE_WORKER_SCRIPT_NAME,
    requests: null, subrequests: null, errors: null, error_rate: null,
    cpu_time_p50_us: null, cpu_time_p99_us: null, sampled: true,
  };
  if (!env.CLOUDFLARE_ANALYTICS_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_WORKER_SCRIPT_NAME) {
    return { ...base, unavailable_reason: "not_configured" };
  }
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 86_400_000);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: {
        accountTag: env.CLOUDFLARE_ACCOUNT_ID, datetimeStart: start.toISOString(), datetimeEnd: end.toISOString(),
        scriptName: env.CLOUDFLARE_WORKER_SCRIPT_NAME,
      } }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) return { ...base, configured: true, unavailable_reason: "query_failed" };
    const payload = await response.json() as { data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: InvocationRow[] }> } }; errors?: unknown[] };
    if (payload.errors?.length) return { ...base, configured: true, unavailable_reason: "graphql_error" };
    const account = payload.data?.viewer?.accounts?.[0];
    if (!account) return { ...base, configured: true, unavailable_reason: "no_account" };
    const rows = account.workersInvocationsAdaptive ?? [];
    const requests = rows.reduce((sum, row) => sum + Math.max(0, row.sum?.requests ?? 0), 0);
    const subrequests = rows.reduce((sum, row) => sum + Math.max(0, row.sum?.subrequests ?? 0), 0);
    const errors = rows.reduce((sum, row) => sum + Math.max(0, row.sum?.errors ?? 0), 0);
    return { ...base, configured: true, requests, subrequests, errors,
      error_rate: requests > 0 ? Math.round((errors / requests) * 10_000) / 10_000 : 0,
      cpu_time_p50_us: null,
      cpu_time_p99_us: null,
    };
  } catch {
    return { ...base, configured: true, unavailable_reason: "query_failed" };
  }
}
