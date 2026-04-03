#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  REGISTRY_PATH,
  REPO_ROOT,
  WORKFLOW_CATALOG,
  type WorkflowMatch,
} from "./mine-history.ts";

export const DEFAULT_BUNDLE_DIR = path.join(REPO_ROOT, ".tmp", "history-skill-bundle");
const MINER_DIR = path.join(REPO_ROOT, "skills", "history-skill-miner");

export function parseRegistryForSlugs(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.match(/\|\s+\[([a-z0-9-]+)\]\(/i)?.[1] ?? "")
    .filter(Boolean);
}

export function resolveGeneratedSkillDirs(slugs: string[]): string[] {
  const known = new Set(WORKFLOW_CATALOG.map((workflow) => workflow.slug));
  return slugs
    .filter((slug) => known.has(slug))
    .map((slug) => path.join(REPO_ROOT, "skills", slug))
    .filter((dir) => existsSync(dir));
}

export function renderBundleReadme(slugs: string[]): string {
  const lines = [
    "# History Skill Bundle",
    "",
    "This bundle contains the shareable history-skill miner and the currently useful generated skills.",
    "",
    "## Included",
    "",
    "- `skills/history-skill-miner`",
    ...slugs.map((slug) => `- \`skills/${slug}\``),
    "",
    "## Refresh",
    "",
    "```bash",
    "bun skills/history-skill-miner/scripts/mine-history.ts",
    "```",
    "",
    "## Export",
    "",
    "```bash",
    "bun skills/history-skill-miner/scripts/export-bundle.ts",
    "```",
    "",
  ];

  return lines.join("\n");
}

export function exportBundle(outDir = DEFAULT_BUNDLE_DIR): { outDir: string; slugs: string[] } {
  const registry = readFileSync(REGISTRY_PATH, "utf8");
  const slugs = parseRegistryForSlugs(registry);
  const skillDirs = resolveGeneratedSkillDirs(slugs);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, "skills"), { recursive: true });

  cpSync(MINER_DIR, path.join(outDir, "skills", "history-skill-miner"), { recursive: true });
  for (const skillDir of skillDirs) {
    cpSync(skillDir, path.join(outDir, "skills", path.basename(skillDir)), { recursive: true });
  }

  writeFileSync(path.join(outDir, "README.md"), renderBundleReadme(slugs));
  return { outDir, slugs };
}

if (import.meta.main) {
  const outArg = process.argv[2];
  const result = exportBundle(outArg ? path.resolve(REPO_ROOT, outArg) : DEFAULT_BUNDLE_DIR);
  console.log(`Exported ${result.slugs.length + 1} skill folders to ${result.outDir}`);
}
