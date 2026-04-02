const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://beta-api.unbrowse.ai";

export interface SkillManifest {
  skill_id: string;
  version: string;
  name: string;
  intent_signature: string;
  domain: string;
  subdomain?: string;
  description: string;
  owner_type: "agent" | "marketplace" | "user";
  execution_type: "http" | "browser-capture";
  endpoints: EndpointDescriptor[];
  lifecycle: "active" | "deprecated" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface EndpointDescriptor {
  endpoint_id: string;
  method: string;
  url_template: string;
  idempotency: "safe" | "unsafe";
  verification_status: "verified" | "unverified" | "failed" | "pending";
  reliability_score: number;
  response_schema?: unknown;
}

export interface SearchResult {
  id: number;
  score: number;
  metadata: Record<string, unknown>;
}

export interface AgentProfile {
  agent_id: string;
  name: string;
  created_at: string;
  wallet_address?: string | null;
  wallet_provider?: string | null;
  skills_discovered: string[];
  total_executions: number;
  total_feedback_given: number;
  tos_accepted_version?: string | null;
  tos_accepted_at?: string | null;
  last_active_at?: string;
}

export interface StatsSummary {
  skills: number;
  endpoints: number;
  domains: number;
  executions: number;
  agents: number;
}

export interface AgentHealth {
  total_agents: number;
  active_today: number;
  active_this_week: number;
  active_this_month: number;
  churned_30d: number;
  avg_executions_per_agent: number;
  median_executions_per_agent: number;
  top_agents: Array<{
    agent_id: string;
    name: string;
    executions: number;
    skills_discovered: number;
    last_active: string | null;
  }>;
}

export interface ActivationFunnel {
  total_registered: number;
  executed_once: number;
  discovered_skill: number;
  repeat_user: number;
  power_user: number;
  rates: {
    registration_to_first_exec: number;
    first_exec_to_discovery: number;
    discovery_to_repeat: number;
    repeat_to_power: number;
  };
}

export interface EngagementMetrics {
  dau: number;
  wau: number;
  mau: number;
  dau_wau_ratio: number;
  dau_mau_ratio: number;
  daily_trend: Array<{ date: string; active: number }>;
}

export interface CurrentTos {
  version: string;
  summary: string;
  url: string;
}

export interface DashboardTransaction {
  transaction_id: string;
  direction: "spent" | "earned";
  skill_id: string;
  endpoint_id?: string;
  amount_usd: number;
  platform_fee_usd: number;
  counterparty_agent_id: string;
  status: string;
  created_at: string;
}

export interface DashboardData {
  profile: AgentProfile;
  economics: {
    spent_usd: number;
    creator_earned_usd: number;
    attribution_earned_usd: number;
    total_earned_usd: number;
    platform_fees_paid_usd: number;
    graph_fees_paid_usd: number;
    skill_spend_usd: number;
    paid_execution_usd: number;
  };
  savings: {
    time_saved_ms: number | null;
    time_saved_hours: number | null;
    cost_saved_uc: number | null;
    cost_saved_usd: number | null;
  };
  activity: {
    total_executions: number;
    skills_discovered: number;
    total_feedback_given: number;
  };
  rank: {
    contribution_score: number;
    position: number | null;
  };
  recent_transactions: DashboardTransaction[];
}

export interface LeaderboardEntry {
  agent_id: string;
  name: string;
  wallet_address?: string;
  created_at: string;
  contribution_score: number;
  creator_earned_usd: number;
  attribution_earned_usd: number;
  total_earned_usd: number;
  executions: number;
  skills_discovered: number;
  time_saved_hours: number | null;
  cost_saved_usd: number | null;
  score_components: {
    earned_norm: number;
    execution_norm: number;
    discovery_norm: number;
  };
}

interface StoredAuth {
  apiKey?: string;
}

function readStoredAuth(): StoredAuth | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem("unbrowse_auth");
    return stored ? JSON.parse(stored) as StoredAuth : null;
  } catch {
    return null;
  }
}

async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { apiKey?: string | null; revalidate?: number },
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts?.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    next: opts?.revalidate != null ? { revalidate: opts.revalidate } : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, body, { revalidate: 30 });
}

export async function authApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const apiKey = readStoredAuth()?.apiKey ?? null;
  return request<T>(method, path, body, { apiKey });
}

export async function verifyAgentApiKey(apiKey: string): Promise<AgentProfile> {
  return request<AgentProfile>("GET", "/v1/agents/me", undefined, { apiKey: apiKey.trim() });
}

export async function listSkills(): Promise<SkillManifest[]> {
  const data = await api<{ skills: SkillManifest[] }>("GET", "/v1/skills");
  return data.skills;
}

export async function getSkill(id: string): Promise<SkillManifest | null> {
  try {
    return await api<SkillManifest>("GET", `/v1/skills/${id}`);
  } catch {
    return null;
  }
}

export async function getStatsSummary(): Promise<StatsSummary> {
  return api<StatsSummary>("GET", "/v1/stats/summary");
}

export async function getCurrentTos(): Promise<CurrentTos> {
  return api<CurrentTos>("GET", "/v1/tos/current");
}

export async function searchSkills(intent: string, domain?: string): Promise<SearchResult[]> {
  const path = domain ? "/v1/search/domain" : "/v1/search";
  const body = domain ? { intent, domain } : { intent };
  const data = await api<{ results: SearchResult[] }>("POST", path, body);
  return data.results;
}

export async function registerAgent(name: string, tosVersion?: string): Promise<{ agent_id: string; api_key: string }> {
  return api<{ agent_id: string; api_key: string }>("POST", "/v1/agents/register", {
    name,
    ...(tosVersion ? { tos_version: tosVersion } : {}),
  });
}

export async function getAgent(agentId: string): Promise<AgentProfile> {
  return api<AgentProfile>("GET", `/v1/agents/${agentId}`);
}

export async function listAgents(limit = 20): Promise<AgentProfile[]> {
  const data = await api<{ agents: AgentProfile[] }>("GET", `/v1/agents?limit=${limit}`);
  return data.agents;
}

export async function getMyProfile(): Promise<AgentProfile> {
  return authApi<AgentProfile>("GET", "/v1/agents/me");
}

export async function getMyDashboard(): Promise<DashboardData> {
  return authApi<DashboardData>("GET", "/v1/dashboard/me");
}

export async function getDashboardByWallet(walletAddress: string): Promise<DashboardData> {
  return api<DashboardData>("GET", `/v1/dashboard/wallet/${encodeURIComponent(walletAddress.trim())}`);
}

export async function getLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  const data = await api<{ entries: LeaderboardEntry[] }>("GET", `/v1/leaderboard?limit=${limit}`);
  return data.entries;
}

export interface DomainCoverage {
  domain: string;
  skills: number;
  endpoints: number;
  updated_at: string;
}

export interface NetworkStats {
  total_routes: number;
  total_skills: number;
  total_agents: number;
  total_executions: number;
  total_earned_usd: number;
  marketplace_hit_rate: number;
  total_resolves: number;
  total_tokens_saved: number;
}

export interface MinerStats {
  network: NetworkStats;
  domains: DomainCoverage[];
  leaderboard: LeaderboardEntry[];
}

export async function getMinerStats(): Promise<MinerStats> {
  return api<MinerStats>("GET", "/v1/miners/stats");
}
