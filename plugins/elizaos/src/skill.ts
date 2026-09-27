// The Unbrowse agent skill ships in this package (skill/SKILL.md, copied from the repo's skill/ by
// scripts/sync-plugins.mjs). The provider distils it into a short note; the full file stays on disk for hosts
// that load skills.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type SkillNote = { path?: string; description: string; steps: string[]; rules: string[] };

const FALLBACK: SkillNote = {
  description: "Search and call websites through Unbrowse's hosted API or remote MCP, reuse indexed site tools, read pages, and learn missing routes in its cloud browser.",
  steps: [
    "Discover with unbrowse.discover {query}.",
    "Call the selected tool, or unbrowse.run {capability, input}.",
    "input_required means answer the open requirements on the same run with unbrowse.resume.",
    "no_capability means no reusable route matched: do the task through unbrowse.browse.*.",
    "Only report completion from a verified result.",
  ],
  rules: ["Never ask for passwords in chat.", "Obtain the user's authorization for posting, sending, purchasing or other external writes."],
};

/** skill/SKILL.md next to src/ or dist/ (both sit one level under the package root). */
export function skillPath(): string | undefined {
  try {
    const p = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url));
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

const firstSentence = (s: string) => (s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s).replace(/\*\*/g, "").trim();

/** Frontmatter description, the first sentence of each "Execute a task" step, and the hard rules. */
export function parseSkill(md: string): Omit<SkillNote, "path"> {
  const description = md.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? FALLBACK.description;
  const section = md.split(/^## Execute a task\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const steps = [...section.matchAll(/^\d+\.\s+(.+)$/gm)].map((m) => firstSentence(m[1].replace(/`/g, "")));
  const rules: string[] = [];
  if (/Never ask for passwords/i.test(md)) rules.push("Never ask for passwords in chat; saved logins go through the returned sign-in link.");
  if (/authorization for posting/i.test(md)) rules.push("Get the user's OK before posting, sending, purchasing or other external writes.");
  if (/CAPTCHA/i.test(md)) rules.push("Do not bypass CAPTCHA, MFA or human verification.");
  return { description, steps: steps.length ? steps : FALLBACK.steps, rules: rules.length ? rules : FALLBACK.rules };
}

let cached: SkillNote | undefined;
export function loadSkill(): SkillNote {
  if (cached) return cached;
  const path = skillPath();
  if (!path) return (cached = FALLBACK);
  try {
    cached = { path, ...parseSkill(readFileSync(path, "utf8")) };
  } catch {
    cached = FALLBACK;
  }
  return cached;
}
