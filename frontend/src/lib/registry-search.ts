import type { SkillListItem, SkillManifest } from "@/lib/api";

type RegistrySkill = Pick<SkillManifest, "skill_id" | "lifecycle"> | Pick<SkillListItem, "skill_id" | "lifecycle">;

export function parseSearchMetadata(metadata?: Record<string, unknown>): Record<string, string> {
  try {
    if (typeof metadata?.content === "string") {
      return JSON.parse(metadata.content) as Record<string, string>;
    }
  } catch {}
  return {};
}

export function findRegistrySkill(
  metadata: Record<string, unknown> | undefined,
  allSkills: RegistrySkill[],
): RegistrySkill | undefined {
  const skillId = parseSearchMetadata(metadata).skill_id;
  return skillId ? allSkills.find((skill) => skill.skill_id === skillId) : undefined;
}

export function getRegistrySkillHref(
  metadata: Record<string, unknown> | undefined,
  allSkills: RegistrySkill[],
): string | null {
  const skill = findRegistrySkill(metadata, allSkills);
  return skill ? `/skills/${skill.skill_id}` : null;
}
