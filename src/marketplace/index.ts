import * as client from "../client/index.js";
import type { EndpointDescriptor, SkillManifest, VerificationStatus } from "../types/index.js";

export async function listSkills(): Promise<SkillManifest[]> {
  return client.listSkills();
}

export async function getSkill(skillId: string): Promise<SkillManifest | null> {
  return client.getSkill(skillId);
}

export async function publishSkill(
  draft: Omit<SkillManifest, "skill_id" | "created_at" | "updated_at" | "version"> & {
    skill_id?: string;
    version?: string;
  }
): Promise<SkillManifest> {
  const result = await client.publishSkill(draft);
  // Fetch the full manifest back so callers still get a SkillManifest
  const skill = await client.getSkill(result.skill_id);
  if (!skill) throw new Error("Published skill not found in backend");
  return skill;
}

export async function updateEndpointScore(
  skillId: string,
  endpointId: string,
  score: number,
  status?: VerificationStatus
): Promise<void> {
  await client.updateEndpointScore(skillId, endpointId, score, status);
}

// --- Pure local helpers (no backend call) ---

export function mergeEndpoints(
  existing: EndpointDescriptor[],
  incoming: EndpointDescriptor[]
): EndpointDescriptor[] {
  const merged = [...existing];
  for (const ep of incoming) {
    const dupe = merged.find(
      (e) =>
        e.method === ep.method &&
        normalizeTemplate(e.url_template) === normalizeTemplate(ep.url_template)
    );
    if (!dupe) merged.push(ep);
  }
  return merged;
}

export function normalizeTemplate(t: string): string {
  return t.replace(/\{[^}]+\}/g, "{}").toLowerCase();
}
