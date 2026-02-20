import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import semver from "semver";
import { nanoid } from "nanoid";
import type { EndpointDescriptor, SkillManifest } from "../types/index.js";
import { indexSkill } from "../discovery/index.js";

const SKILLS_DIR = process.env.SKILLS_DIR ?? join(process.cwd(), "skills");

function ensureDir() {
  if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });
}

export function listSkills(): SkillManifest[] {
  ensureDir();
  return readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const skill = JSON.parse(readFileSync(join(SKILLS_DIR, f), "utf8")) as SkillManifest;
      if (!skill.execution_type) skill.execution_type = "http";
      return skill;
    });
}

export function getSkill(skillId: string): SkillManifest | null {
  const file = join(SKILLS_DIR, `${skillId}.json`);
  if (!existsSync(file)) return null;
  const skill = JSON.parse(readFileSync(file, "utf8")) as SkillManifest;
  // backfill execution_type for skills created before this field existed
  if (!skill.execution_type) skill.execution_type = "http";
  return skill;
}

export async function publishSkill(
  draft: Omit<SkillManifest, "skill_id" | "created_at" | "updated_at" | "version"> & {
    skill_id?: string;
    version?: string;
  }
): Promise<SkillManifest> {
  ensureDir();
  const existing = findExistingByIntent(draft.intent_signature, draft.domain);
  const now = new Date().toISOString();
  let skill: SkillManifest;

  if (existing) {
    const newVersion = semver.inc(existing.version, "minor") ?? "1.0.0";
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

  writeFileSync(join(SKILLS_DIR, `${skill.skill_id}.json`), JSON.stringify(skill, null, 2));

  // Index into EmergentDB (non-fatal) — enrich with trust signals
  const reliabilities = skill.endpoints.map((e) => e.reliability_score);
  const avgReliability = reliabilities.length > 0
    ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
    : 0.5;
  const verifiedCount = skill.endpoints.filter((e) => e.verification_status === "verified").length;
  const verifiedRatio = skill.endpoints.length > 0 ? verifiedCount / skill.endpoints.length : 0;

  await indexSkill(skill.skill_id, skill.intent_signature, {
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

export function findExistingByIntent(
  intentSignature: string,
  domain: string
): SkillManifest | null {
  const skills = listSkills();
  return (
    skills.find(
      (s) =>
        s.intent_signature.toLowerCase() === intentSignature.toLowerCase() &&
        s.domain === domain &&
        s.lifecycle === "active"
    ) ?? null
  );
}

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

export function updateEndpointScore(
  skillId: string,
  endpointId: string,
  score: number,
  status?: import("../types/index.js").VerificationStatus
): void {
  const skill = getSkill(skillId);
  if (!skill) return;
  const endpoint = skill.endpoints.find((e) => e.endpoint_id === endpointId);
  if (!endpoint) return;
  endpoint.reliability_score = score;
  if (status) endpoint.verification_status = status;
  skill.updated_at = new Date().toISOString();
  writeFileSync(join(SKILLS_DIR, `${skillId}.json`), JSON.stringify(skill, null, 2));
}

function normalizeTemplate(t: string): string {
  return t.replace(/\{[^}]+\}/g, "{}").toLowerCase();
}
