import type { EndpointStats, ExecutionTrace, SkillManifest, ValidationResult } from "../types/index.js";

const API_URL = "https://beta-api.unbrowse.ai";
const API_KEY = process.env.UNBROWSE_API_KEY ?? "";

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `API HTTP ${res.status}`);
  return data;
}

// --- Skill CRUD ---

export async function getSkill(skillId: string): Promise<SkillManifest | null> {
  try {
    return await api<SkillManifest>("GET", `/v1/skills/${skillId}`);
  } catch {
    return null;
  }
}

export async function listSkills(): Promise<SkillManifest[]> {
  const data = await api<{ skills: SkillManifest[] }>("GET", "/v1/skills");
  return data.skills;
}

export async function publishSkill(
  draft: Omit<SkillManifest, "skill_id" | "created_at" | "updated_at" | "version"> & {
    skill_id?: string;
    version?: string;
  }
): Promise<{ skill_id: string; version: string; warnings: string[] }> {
  return api("POST", "/v1/skills", draft);
}

export async function deprecateSkill(skillId: string): Promise<void> {
  await api("DELETE", `/v1/skills/${skillId}`);
}

export async function updateEndpointScore(
  skillId: string,
  endpointId: string,
  score: number,
  status?: string
): Promise<void> {
  await api("PATCH", `/v1/skills/${skillId}/endpoints/${endpointId}`, { score, status });
}

export async function getEndpointSchema(
  skillId: string,
  endpointId: string
): Promise<unknown | null> {
  try {
    return await api("GET", `/v1/skills/${skillId}/endpoints/${endpointId}/schema`);
  } catch {
    return null;
  }
}

// --- Search ---

export async function searchIntent(
  intent: string,
  k = 5
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  const data = await api<{ results: Array<{ id: number; score: number; metadata: Record<string, unknown> }> }>(
    "POST", "/v1/search", { intent, k }
  );
  return data.results;
}

export async function searchIntentInDomain(
  intent: string,
  domain: string,
  k = 5
): Promise<Array<{ id: number; score: number; metadata: Record<string, unknown> }>> {
  const data = await api<{ results: Array<{ id: number; score: number; metadata: Record<string, unknown> }> }>(
    "POST", "/v1/search/domain", { intent, domain, k }
  );
  return data.results;
}

// --- Stats ---

export async function recordExecution(
  skillId: string,
  endpointId: string,
  trace: ExecutionTrace
): Promise<void> {
  await api("POST", "/v1/stats/execution", {
    skill_id: skillId,
    endpoint_id: endpointId,
    trace,
  });
}

export async function recordFeedback(
  skillId: string,
  endpointId: string,
  rating: number
): Promise<number> {
  const data = await api<{ avg_rating: number }>("POST", "/v1/stats/feedback", {
    skill_id: skillId,
    endpoint_id: endpointId,
    rating,
  });
  return data.avg_rating;
}

// --- Validation ---

export async function validateManifest(manifest: unknown): Promise<ValidationResult> {
  return api<ValidationResult>("POST", "/v1/validate", manifest);
}
