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
    .map((f) => JSON.parse(readFileSync(join(SKILLS_DIR, f), "utf8")) as SkillManifest);
}

export function getSkill(skillId: string): SkillManifest | null {
  const file = join(SKILLS_DIR, `${skillId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as SkillManifest;
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

  // Index into EmergentDB (non-fatal)
  await indexSkill(skill.skill_id, skill.intent_signature, {
    domain: skill.domain,
    subdomain: skill.subdomain,
    name: skill.name,
    description: skill.description,
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

function normalizeTemplate(t: string): string {
  return t.replace(/\{[^}]+\}/g, "{}").toLowerCase();
}
