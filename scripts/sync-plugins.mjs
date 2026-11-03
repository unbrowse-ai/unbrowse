// Copies the agent skills into every host plugin that ships them: `skill/` (SKILL.md + references/, upstream-owned,
// docs/public-sync.md) and `skills/unbrowse-contribute/` (client-owned: turn an Unbrowse bug into a fix PR).
// `--check` fails when a copy is stale instead of writing.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const SKILL_TARGETS = [
  "plugins/claude-code/skills/unbrowse",
  "plugins/codex/skills/unbrowse",
  "plugins/grok-build/skills/unbrowse",
  "plugins/openclaw/skills/unbrowse",
  "plugins/hermes/skills/unbrowse",
  "plugins/elizaos/skill",
  "plugins/cursor/skills/unbrowse",
];

// Hosts that load every folder under skills/ also get the contribute skill. elizaOS ships one skill folder.
export const CONTRIBUTE_TARGETS = [
  "plugins/claude-code/skills/unbrowse-contribute",
  "plugins/codex/skills/unbrowse-contribute",
  "plugins/grok-build/skills/unbrowse-contribute",
  "plugins/openclaw/skills/unbrowse-contribute",
  "plugins/hermes/skills/unbrowse-contribute",
  "plugins/cursor/skills/unbrowse-contribute",
];

function files(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)]));
}

// Hook scripts are written once (plugins/claude-code/scripts) and copied byte-for-byte.
export const SCRIPT_COPIES = [
  ["plugins/claude-code/scripts/redirect.sh", "plugins/codex/scripts/redirect.sh"],
  ["plugins/claude-code/scripts/session.sh", "plugins/codex/scripts/session.sh"],
  ["plugins/claude-code/scripts/redirect.sh", "plugins/grok-build/scripts/redirect.sh"],
];

const check = process.argv.includes("--check");
const stale = [];
for (const [source, targets] of [["skill", SKILL_TARGETS], ["skills/unbrowse-contribute", CONTRIBUTE_TARGETS]]) {
  const want = files(source).sort();
  for (const target of targets) {
    if (!existsSync(target.split("/").slice(0, 2).join("/"))) continue; // plugin not present in this checkout
    const same = existsSync(target) && JSON.stringify(files(target).sort()) === JSON.stringify(want) && want.every((f) => readFileSync(join(source, f)).equals(readFileSync(join(target, f))));
    if (same) continue;
    if (check) { stale.push(target); continue; }
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
    console.log(`synced ${target}`);
  }
}
for (const [from, to] of SCRIPT_COPIES) {
  if (!existsSync(to.split("/").slice(0, 2).join("/"))) continue;
  if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
  if (check) { stale.push(to); continue; }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  chmodSync(to, 0o755);
  console.log(`synced ${to}`);
}
if (stale.length) { console.error(`stale plugin copies (run node scripts/sync-plugins.mjs): ${stale.join(", ")}`); process.exit(1); }
if (check) console.log("PLUGIN_SKILLS_OK");
