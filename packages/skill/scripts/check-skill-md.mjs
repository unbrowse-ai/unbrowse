#!/usr/bin/env node

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const monorepoSyncScript = path.resolve(packageRoot, "../../scripts/sync-skill-md.ts");
const skillFile = path.join(packageRoot, "SKILL.md");

if (existsSync(monorepoSyncScript)) {
  execFileSync("bun", [monorepoSyncScript, "--check"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  process.exit(0);
}

if (!existsSync(skillFile)) {
  console.error("SKILL.md missing; cannot package unbrowse.");
  process.exit(1);
}

console.log("Standalone package repo detected; skipping monorepo SKILL sync check.");
