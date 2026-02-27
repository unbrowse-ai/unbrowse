import { nanoid } from "nanoid";
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
  // Pre-cache locally so the skill is immediately available even if the remote publish
  // fails or EmergentDB hasn't indexed it yet (eventual consistency).
  const now = new Date().toISOString();
  const preCache = {
    ...draft,
    skill_id: draft.skill_id ?? nanoid(),
    created_at: now,
    updated_at: now,
    version: draft.version ?? "1.0.0",
  } as SkillManifest;
  client.cachePublishedSkill(preCache);

  try {
    const { warnings: _, ...backendFields } = await client.publishSkill(draft);
    // Merge draft with backend response — avoids read-after-write race
    const skill = { ...draft, ...backendFields } as SkillManifest;
    client.cachePublishedSkill(skill);
    return skill;
  } catch (err) {
    console.error("[publish] remote publish failed, using local cache:", (err as Error).message);
    return preCache;
  }
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
