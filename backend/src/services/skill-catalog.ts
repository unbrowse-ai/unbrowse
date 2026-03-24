import type { Env, SkillManifest } from "../types.js";
import { skillsKV } from "./kv.js";

type DomainIndexEntry = { name: string; value: string };

function normalizeSkill(skill: SkillManifest): SkillManifest {
  if (!skill.execution_type) skill.execution_type = "http";
  return skill;
}

export async function listCanonicalSkillsFromDomainIndex(
  entries: DomainIndexEntry[],
  getSkillById: (skillId: string) => Promise<SkillManifest | null>,
): Promise<SkillManifest[]> {
  const skillIds = Array.from(new Set(
    entries
      .map((entry) => entry.value.trim())
      .filter(Boolean),
  ));

  const skills = await Promise.all(skillIds.map((skillId) => getSkillById(skillId)));
  return skills.flatMap((skill) => skill ? [normalizeSkill(skill)] : []);
}

export async function listCanonicalSkills(
  env: Pick<Env, "EMERGENTDB_API_KEY" | "ENVIRONMENT">,
): Promise<SkillManifest[]> {
  const kv = skillsKV(env);
  const entries = await kv.listWithValues("domain-idx:");
  return listCanonicalSkillsFromDomainIndex(entries, async (skillId) => {
    const raw = await kv.get(`skill:${skillId}`);
    if (typeof raw !== "string" || raw.length === 0) return null;
    try {
      return JSON.parse(raw) as SkillManifest;
    } catch {
      return null;
    }
  });
}
