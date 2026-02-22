const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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

export interface StatsSummary {
  skills: number;
  endpoints: number;
  domains: number;
  executions: number;
}

export async function getStatsSummary(): Promise<StatsSummary> {
  const data = await api<StatsSummary>("GET", "/v1/stats/summary");
  return data;
}

export async function searchSkills(intent: string, domain?: string): Promise<SearchResult[]> {
  const path = domain ? "/v1/search/domain" : "/v1/search";
  const body = domain ? { intent, domain } : { intent };
  const data = await api<{ results: SearchResult[] }>("POST", path, body);
  return data.results;
}
