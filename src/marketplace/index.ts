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
  const { warnings: _, ...backendFields } = await client.publishSkill(draft);
  // Merge draft with backend response — avoids read-after-write race
  const skill = { ...draft, ...backendFields } as SkillManifest;
  // Cache locally so the skill is immediately executable despite backend eventual consistency
  client.cachePublishedSkill(skill);
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
