/**
 * Skill Package Writer (local)
 *
 * Writes backend-returned skill content back to the local skill directory.
 * Used after publish/merge so the local skill stays in sync with the canonical
 * marketplace version (the "metaskill").
 *
 * Guardrails:
 * - Does NOT touch auth.json (credentials stay local).
 * - Never deletes files; only overwrites provided artifacts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WriteableSkillPackage {
  skillMd?: string;
  scripts?: Record<string, string>;
  references?: Record<string, string>;
}

/**
 * Write skill package content to disk.
 * Returns true if SKILL.md was written (skillMd present), false otherwise.
 */
export function writeSkillPackageToDir(skillDir: string, pkg: WriteableSkillPackage | null | undefined): boolean {
  if (!pkg?.skillMd || typeof pkg.skillMd !== "string") return false;

  try {
    writeFileSync(join(skillDir, "SKILL.md"), pkg.skillMd, "utf-8");

    if (pkg.scripts && typeof pkg.scripts === "object") {
      const scriptsDir = join(skillDir, "scripts");
      mkdirSync(scriptsDir, { recursive: true });
      for (const [filename, content] of Object.entries(pkg.scripts)) {
        if (typeof filename !== "string" || filename.length === 0) continue;
        if (typeof content !== "string") continue;
        writeFileSync(join(scriptsDir, filename), content, "utf-8");
      }
    }

    if (pkg.references && typeof pkg.references === "object") {
      const refsDir = join(skillDir, "references");
      mkdirSync(refsDir, { recursive: true });
      for (const [filename, content] of Object.entries(pkg.references)) {
        if (typeof filename !== "string" || filename.length === 0) continue;
        if (typeof content !== "string") continue;
        writeFileSync(join(refsDir, filename), content, "utf-8");
      }
    }

    return true;
  } catch {
    return false;
  }
}

