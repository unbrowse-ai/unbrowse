import { nanoid } from "nanoid";
import * as client from "../client/index.js";
import type { EndpointDescriptor, SkillManifest, VerificationStatus } from "../types/index.js";

export async function listSkills(): Promise<SkillManifest[]> {
  return client.listSkills();
}

export async function getSkill(skillId: string, scopeId?: string): Promise<SkillManifest | null> {
  return client.getSkill(skillId, scopeId);
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

  if (client.isLocalOnlyMode()) {
    return preCache;
  }

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
    const dupeIndex = merged.findIndex(
      (e) =>
        e.method === ep.method &&
        normalizeTemplate(e.url_template) === normalizeTemplate(ep.url_template)
    );
    if (dupeIndex === -1) {
      merged.push(ep);
      continue;
    }

    const dupe = merged[dupeIndex]!;
    merged[dupeIndex] = {
      ...dupe,
      ...ep,
      endpoint_id: dupe.endpoint_id,
      reliability_score: Math.max(dupe.reliability_score ?? 0, ep.reliability_score ?? 0),
      verification_status: dupe.verification_status === "verified" ? dupe.verification_status : ep.verification_status,
      exec_strategy: ep.exec_strategy ?? dupe.exec_strategy,
      dom_extraction: ep.dom_extraction ?? dupe.dom_extraction,
      semantic: ep.semantic ?? dupe.semantic,
      response_schema: ep.response_schema ?? dupe.response_schema,
      headers_template: ep.headers_template ?? dupe.headers_template,
      query: ep.query ?? dupe.query,
      path_params: ep.path_params ?? dupe.path_params,
      body: ep.body ?? dupe.body,
      trigger_url: ep.trigger_url ?? dupe.trigger_url,
    };
  }
  return merged;
}

export function normalizeTemplate(t: string): string {
  return t
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/([?&]queryid=)([^?&]+)/gi, (_match, prefix: string, value: string) => {
      if (value === "{}") return `${prefix}${value}`;
      return `${prefix}${value.replace(/\.[a-f0-9]{8,}$/i, "")}`;
    })
    .toLowerCase();
}
