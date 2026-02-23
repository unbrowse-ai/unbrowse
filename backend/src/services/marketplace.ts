import { nanoid } from "nanoid";
import type { Env, SkillManifest, EndpointDescriptor } from "../types.js";
import { indexSkill, removeSkillFromIndex } from "./discovery.js";
import { skillsKV } from "./kv.js";

function kvKey(skillId: string): string {
  return `skill:${skillId}`;
}

function intentKey(domain: string, intent: string): string {
  return `intent-idx:${domain}:${hashIntent(intent)}`;
}

function hashIntent(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export async function listSkills(env: Env): Promise<SkillManifest[]> {
  const kv = skillsKV(env);
  const result = await kv.list({ prefix: "skill:" });
  const skills: SkillManifest[] = [];
  for (const key of result.keys) {
    const raw = await kv.get(key.name) as string | null;
    if (raw) {
      const skill = JSON.parse(raw) as SkillManifest;
      if (!skill.execution_type) skill.execution_type = "http";
      skills.push(skill);
    }
  }
  return skills;
}

export async function getSkill(env: Env, skillId: string): Promise<SkillManifest | null> {
  const raw = await skillsKV(env).get(kvKey(skillId)) as string | null;
  if (!raw) return null;
  const skill = JSON.parse(raw) as SkillManifest;
  if (!skill.execution_type) skill.execution_type = "http";
  return skill;
}

export async function publishSkill(
  env: Env,
  draft: Omit<SkillManifest, "skill_id" | "created_at" | "updated_at" | "version"> & {
    skill_id?: string;
    version?: string;
  }
): Promise<SkillManifest> {
  const existing = await findExistingByIntent(env, draft.intent_signature, draft.domain);
  const now = new Date().toISOString();
  let skill: SkillManifest;

  if (existing) {
    const newVersion = bumpMinor(existing.version);
    skill = {
      ...existing,
      ...draft,
      skill_id: existing.skill_id,
      version: newVersion,
      prev_version: existing.version,
      updated_at: now,
      created_at: existing.created_at,
    };
  } else {
    skill = {
      ...draft,
      skill_id: draft.skill_id ?? nanoid(),
      version: draft.version ?? "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      created_at: now,
      updated_at: now,
    } as SkillManifest;
  }

  const kv = skillsKV(env);
  await kv.put(kvKey(skill.skill_id), JSON.stringify(skill));
  await kv.put(intentKey(skill.domain, skill.intent_signature), skill.skill_id);

  // Index into EmergentDB vector search (non-fatal)
  const reliabilities = skill.endpoints.map((e) => e.reliability_score);
  const avgReliability = reliabilities.length > 0
    ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
    : 0.5;
  const verifiedCount = skill.endpoints.filter((e) => e.verification_status === "verified").length;
  const verifiedRatio = skill.endpoints.length > 0 ? verifiedCount / skill.endpoints.length : 0;

  await indexSkill(env, skill.skill_id, skill.intent_signature, {
    domain: skill.domain,
    subdomain: skill.subdomain,
    name: skill.name,
    description: skill.description,
    avg_reliability: avgReliability,
    verified_ratio: verifiedRatio,
    updated_at: skill.updated_at,
  }).catch(() => {});

  return skill;
}
): Promise<SkillManifest> {
  const existing = await findExistingByIntent(env, draft.intent_signature, draft.domain);
  const now = new Date().toISOString();
  let skill: SkillManifest;

  if (existing) {
    const newVersion = bumpMinor(existing.version);
    skill = {
      ...existing,
      ...draft,
      skill_id: existing.skill_id,
      version: newVersion,
      prev_version: existing.version,
      updated_at: now,
      created_at: existing.created_at,
    };
  } else {
    skill = {
      ...draft,
      skill_id: draft.skill_id ?? nanoid(),
      version: draft.version ?? "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      created_at: now,
      updated_at: now,
    } as SkillManifest;
  }

  // Store skill in KV
  await env.SKILLS_KV.put(kvKey(skill.skill_id), JSON.stringify(skill));

  // Store intent dedup index
  await env.SKILLS_KV.put(intentKey(skill.domain, skill.intent_signature), skill.skill_id);

  // Index into EmergentDB (non-fatal)
  const reliabilities = skill.endpoints.map((e) => e.reliability_score);
  const avgReliability = reliabilities.length > 0
    ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
    : 0.5;
  const verifiedCount = skill.endpoints.filter((e) => e.verification_status === "verified").length;
  const verifiedRatio = skill.endpoints.length > 0 ? verifiedCount / skill.endpoints.length : 0;

  await indexSkill(env, skill.skill_id, skill.intent_signature, {
    domain: skill.domain,
    subdomain: skill.subdomain,
    name: skill.name,
    description: skill.description,
    avg_reliability: avgReliability,
    verified_ratio: verifiedRatio,
    updated_at: skill.updated_at,
  }).catch(() => {});

  return skill;
}

export async function deprecateSkill(env: Env, skillId: string): Promise<SkillManifest | null> {
  const skill = await getSkill(env, skillId);
  if (!skill) return null;
  skill.lifecycle = "deprecated";
  skill.updated_at = new Date().toISOString();
  await skillsKV(env).put(kvKey(skillId), JSON.stringify(skill));
  await removeSkillFromIndex(env, skillId, skill.domain).catch(() => {});
  return skill;
}

export async function updateEndpointScore(
  env: Env,
  skillId: string,
  endpointId: string,
  score: number,
  status?: import("../types.js").VerificationStatus
): Promise<void> {
  const skill = await getSkill(env, skillId);
  if (!skill) return;
  const endpoint = skill.endpoints.find((e) => e.endpoint_id === endpointId);
  if (!endpoint) return;
  endpoint.reliability_score = score;
  if (status) endpoint.verification_status = status;
  skill.updated_at = new Date().toISOString();
  await skillsKV(env).put(kvKey(skillId), JSON.stringify(skill));

  if (status === "disabled" || status === "failed") {
    const allDead = skill.endpoints.every(
      (e) => e.verification_status === "disabled" || e.verification_status === "failed"
    );
    if (allDead && skill.lifecycle === "active") {
      await deprecateSkill(env, skillId);
    }
  }
}

export async function getEndpointSchema(
  env: Env,
  skillId: string,
  endpointId: string
): Promise<import("../types.js").ResponseSchema | null> {
  const skill = await getSkill(env, skillId);
  if (!skill) return null;
  const endpoint = skill.endpoints.find((e) => e.endpoint_id === endpointId);
  return endpoint?.response_schema ?? null;
}

async function findExistingByIntent(
  env: Env,
  intentSignature: string,
  domain: string
): Promise<SkillManifest | null> {
  const existingId = await skillsKV(env).get(intentKey(domain, intentSignature.toLowerCase())) as string | null;
  if (existingId) {
    const skill = await getSkill(env, existingId);
    if (skill && skill.lifecycle === "active") return skill;
  }
  return null;
}

function bumpMinor(version: string): string {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return "1.0.0";
  return `${parts[0]}.${parts[1] + 1}.0`;
}

// Pure helper — stays available for local use too
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
