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
  skills_discovered: string[];
  total_executions: number;
  total_feedback_given: number;
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

// --- Unauthenticated API helper ---

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    next: { revalidate: 30 },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// --- Authenticated API helper (client-side only) ---

export async function authApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let apiKey: string | null = null;
  if (typeof window !== "undefined") {
    try {
      const stored = localStorage.getItem("unbrowse_auth");
      if (stored) apiKey = (JSON.parse(stored) as { apiKey?: string }).apiKey ?? null;
    } catch { /* ignore */ }
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// --- Skills ---

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

export async function searchSkills(intent: string, domain?: string): Promise<SearchResult[]> {
  const path = domain ? "/v1/search/domain" : "/v1/search";
  const body = domain ? { intent, domain } : { intent };
  const data = await api<{ results: SearchResult[] }>("POST", path, body);
  return data.results;
}

// --- Agents ---

export async function registerAgent(name: string): Promise<{ agent_id: string; api_key: string }> {
  return api<{ agent_id: string; api_key: string }>("POST", "/v1/agents/register", { name });
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
