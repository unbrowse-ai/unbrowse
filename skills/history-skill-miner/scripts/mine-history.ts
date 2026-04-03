#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type HistorySample = {
  source: "history" | "session_index" | "archived";
  text: string;
  sessionId?: string;
};

export type WorkflowDefinition = {
  id: string;
  slug: string;
  title: string;
  description: string;
  coreJob: string;
  useWhen: string[];
  doNotUseFor: string[];
  workflow: string[];
  constraints: string[];
  matchers: RegExp[];
  minHits: number;
};

export type WorkflowMatch = {
  workflow: WorkflowDefinition;
  hits: number;
  evidence: string[];
};

export const FIRST_PRINCIPLES_SKILL_PATH =
  path.resolve(import.meta.dir, "..", "references", "first-principles-skill-design.md");
export const FIRST_PRINCIPLES_SKILL_REF = "./references/first-principles-skill-design.md";

export const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
export const AGENTS_PATH = path.join(REPO_ROOT, "AGENTS.md");
export const REGISTRY_PATH = path.join(
  REPO_ROOT,
  "skills",
  "history-skill-miner",
  "references",
  "generated-skills.md",
);
export const GENERATED_SKILL_ROOT = path.join(REPO_ROOT, "skills");
export const AGENTS_MARKER_BEGIN = "<!-- HISTORY_SKILL_MINER:BEGIN -->";
export const AGENTS_MARKER_END = "<!-- HISTORY_SKILL_MINER:END -->";

export const WORKFLOW_CATALOG: WorkflowDefinition[] = [
  {
    id: "main-actions-triage",
    slug: "main-actions-triage",
    title: "Main Actions Triage",
    description:
      "Check GitHub Actions and deploy blockers on `main` for this repo. Use when Lewis asks what is running on main, why CI/deploy is blocked, or whether there are blockers to resolve.",
    coreJob: "inspect `main` GitHub Actions truth and turn failures into concrete blockers",
    useWhen: [
      "Lewis asks about `main` branch Actions, deploy state, blocked checks, or release blockers",
      "the request is to inspect status first before changing code",
      "you need exact failing job names and error lines, not a local guess",
    ],
    doNotUseFor: [
      "branch-local coding without a GitHub Actions ask",
      "PR review that should stay inside the worktree issue loop",
      "generic local test runs with no remote CI context",
    ],
    workflow: [
      "Run `gh run list --branch main --limit 10`.",
      "Open failing or in-progress runs with `gh run view <id>` and `gh run view <id> --log-failed`.",
      "Separate blockers into failing required checks, deploy/manual gates, and flaky or non-blocking noise.",
      "Report the exact job name, latest run state, and top failing error before proposing a fix.",
      "If the user wants the fix too, only then move from triage into code changes.",
    ],
    constraints: [
      "GitHub Actions truth first; do not infer blocker state from local git alone",
      "prefer `main` unless the user names another branch",
      "if the latest required run is green, say there is no blocker",
    ],
    matchers: [
      /\bgithub actions?\b/i,
      /\bactions?\b.*\bmain\b/i,
      /\bdeployment actions?\b/i,
      /\bblockers?\b.*\bmain\b/i,
      /\bcheck(?:ing)?\b.*\bmain\b/i,
      /\bci\b.*\bmain\b/i,
    ],
    minHits: 4,
  },
  {
    id: "skill-surface-ship",
    slug: "skill-surface-ship",
    title: "Skill Surface Ship",
    description:
      "Maintain the repo's shipped skill surface end-to-end: skill docs, install path, sync flow, and publish path. Use when Lewis asks to update skill specs, `npx skills add`, package sync, or skill publishing.",
    coreJob: "change the shipped skill surface without letting docs, package, and publish paths drift apart",
    useWhen: [
      "editing root `SKILL.md`, `packages/skill`, skill-install docs, or skill-publish flow",
      "debugging `npx skills add`, skills discovery, or standalone skill repo sync",
      "tightening the public install and publish path for the shipped skill",
    ],
    doNotUseFor: [
      "mining website APIs into runtime skills",
      "chat-history workflow mining itself; use the history miner for that",
      "product eval work that does not touch the skill surface",
    ],
    workflow: [
      "Start from `SKILL.md`, `packages/skill/SKILL.md`, `packages/skill/README.md`, and `scripts/sync-skill.sh`.",
      "If CLI flags or command docs changed, run `bun scripts/sync-skill-md.ts`.",
      "If install or publish behavior changed, run `bun run check:skill-docs` and a package smoke check such as `bun run pack:cli`.",
      "If standalone repo sync matters, use `bash scripts/sync-skill.sh` rather than ad-hoc copies.",
      "Keep the install command, docs, and shipped package behavior aligned before handoff.",
    ],
    constraints: [
      "keep one clear public install story",
      "treat the root skill doc as the public contract unless the repo says otherwise",
      "sync monorepo docs and packaged-skill docs together",
    ],
    matchers: [
      /\bskills add\b/i,
      /\bskill repo\b/i,
      /\bmarketplace skill\b/i,
      /\bskill(?:s)? (?:install|publishing?|publish|spec|docs|search)\b/i,
      /\bsync skill\b/i,
      /\bshared skill architecture\b/i,
      /\bmarketplace\b/i,
    ],
    minHits: 6,
  },
  {
    id: "docs-release-sync",
    slug: "docs-release-sync",
    title: "Docs Release Sync",
    description:
      "Keep README, CHANGELOG, release notes, and user-facing docs aligned with shipped behavior. Use when Lewis asks to update docs after a change or prepare release-facing copy.",
    coreJob: "keep the repo's user-facing narrative aligned with shipped behavior",
    useWhen: [
      "updating `CHANGELOG.md`, `README.md`, release notes, or launch/docs follow-on copy",
      "behavior, API, or install changes need user-facing docs updates",
      "preparing a release summary or validating docs drift",
    ],
    doNotUseFor: [
      "internal-only refactors with no user-facing behavior change",
      "tagging or deploying a release without docs work",
      "CI triage or analytics-only work",
    ],
    workflow: [
      "Read the user-facing diff and the relevant docs before writing summary copy.",
      "Update `CHANGELOG.md` for notable repo changes.",
      "If this is a release task, follow the repo release flow and write `.release-notes.md`.",
      "Align README, skill docs, and install docs with the real commands and behavior.",
      "Call out any docs intentionally left unchanged so drift stays explicit.",
    ],
    constraints: [
      "no notable behavior change ships without docs alignment",
      "prefer user outcomes over implementation detail",
      "CHANGELOG entry required for notable changes",
    ],
    matchers: [
      /\bupdate docs?\b/i,
      /\breadme\b/i,
      /\bchangelog\b/i,
      /\brelease notes?\b/i,
      /\bblog\b/i,
      /\bguide\b/i,
    ],
    minHits: 4,
  },
];

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function extractUserText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((item): item is { type?: string; text?: string } => typeof item === "object" && item !== null)
    .filter((item) => item.type === "input_text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("\n");
  return normalize(text);
}

export function parseHistoryJsonl(jsonl: string): HistorySample[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { session_id?: string; text?: string })
    .map((row) => ({
      source: "history" as const,
      sessionId: row.session_id,
      text: normalize(row.text ?? ""),
    }))
    .filter((row) => row.text.length > 0);
}

export function parseSessionIndexJsonl(jsonl: string): HistorySample[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: string; thread_name?: string })
    .map((row) => ({
      source: "session_index" as const,
      sessionId: row.id,
      text: normalize(row.thread_name ?? ""),
    }))
    .filter((row) => row.text.length > 0);
}

export function parseArchivedSessionJsonl(jsonl: string): HistorySample[] {
  const rows = jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  const samples: HistorySample[] = [];
  for (const row of rows) {
    if (row.type !== "response_item") continue;
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "message" || payload.role !== "user") continue;
    const text = extractUserText(payload.content);
    if (!text) continue;
    samples.push({
      source: "archived",
      sessionId: undefined,
      text,
    });
  }
  return samples;
}

export function isUsableSampleText(text: string): boolean {
  const normalized = normalize(text);
  const lower = normalized.toLowerCase();

  if (!normalized) return false;
  if (normalized.length > 320) return false;
  if (lower.startsWith("# agents.md instructions")) return false;
  if (lower.startsWith("<environment_context>")) return false;
  if (lower.startsWith("<skill>")) return false;
  if (lower.includes("```")) return false;

  return true;
}

function readIfExists(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

export function loadDefaultHistorySamples(homeDir = process.env.HOME ?? ""): HistorySample[] {
  const samples: HistorySample[] = [];

  samples.push(...parseHistoryJsonl(readIfExists(path.join(homeDir, ".codex", "history.jsonl"))));
  samples.push(...parseSessionIndexJsonl(readIfExists(path.join(homeDir, ".codex", "session_index.jsonl"))));

  const archivedDir = path.join(homeDir, ".codex", "archived_sessions");
  if (existsSync(archivedDir)) {
    const archivedFiles = readdirSync(archivedDir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
    for (const file of archivedFiles) {
      samples.push(...parseArchivedSessionJsonl(readIfExists(path.join(archivedDir, file))));
    }
  }

  const seen = new Set<string>();
  return samples.filter((sample) => {
    const key = `${sample.source}:${sample.sessionId ?? ""}:${sample.text}`;
    if (!isUsableSampleText(sample.text) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scoreWorkflowCatalog(
  samples: HistorySample[],
  catalog = WORKFLOW_CATALOG,
): WorkflowMatch[] {
  const matches = catalog.map((workflow) => {
    const evidence: string[] = [];
    let hits = 0;

    for (const sample of samples) {
      const matched = workflow.matchers.some((matcher) => matcher.test(sample.text));
      if (!matched) continue;
      hits += 1;
      if (evidence.length < 6) evidence.push(sample.text.slice(0, 180));
    }

    return {
      workflow,
      hits,
      evidence: unique(evidence),
    };
  });

  return matches
    .filter((match) => match.hits >= match.workflow.minHits)
    .sort((left, right) => right.hits - left.hits || left.workflow.slug.localeCompare(right.workflow.slug));
}

export function renderGeneratedSkill(match: WorkflowMatch): string {
  const { workflow } = match;
  const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  const steps = workflow.workflow.map((step, index) => `${index + 1}. ${step}`).join("\n");

  return `---
name: ${workflow.slug}
description: >-
  ${workflow.description}
user-invocable: true
generated-by: history-skill-miner
design-source: ${FIRST_PRINCIPLES_SKILL_REF}
---

# ${workflow.title}

Core job:

- ${workflow.coreJob}

Use this skill when:

${bullets(workflow.useWhen)}

Do not use this skill for:

${bullets(workflow.doNotUseFor)}

Workflow:

${steps}

Load-bearing constraints:

${bullets(workflow.constraints)}
`;
}

export function renderRegistry(matches: WorkflowMatch[], sampleCount: number): string {
  const lines = [
    "# Generated Skills",
    "",
    `Source design contract: [first-principles-skill-design](./first-principles-skill-design.md)`,
    `Refresh command: \`bun skills/history-skill-miner/scripts/mine-history.ts\``,
    `History samples scanned: ${sampleCount}`,
    "",
    "| Skill | Hits | Why it exists |",
    "|---|---:|---|",
    ...matches.map((match) => {
      const skillPath = `../../${match.workflow.slug}/SKILL.md`;
      return `| [${match.workflow.slug}](${skillPath}) | ${match.hits} | ${match.workflow.coreJob} |`;
    }),
    "",
    "## Evidence",
    "",
  ];

  for (const match of matches) {
    lines.push(`### ${match.workflow.slug}`);
    for (const item of match.evidence) lines.push(`- ${item}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function renderAgentsBlock(matches: WorkflowMatch[]): string {
  const lines = [
    "## History-Mined Skills",
    "",
    "- Use `skills/history-skill-miner/SKILL.md` when Lewis asks to turn repeated local chat workflows into repo-local skills or refresh the generated skill set.",
    "- Refresh with `bun skills/history-skill-miner/scripts/mine-history.ts` so `AGENTS.md` and the generated skills stay in sync.",
    "- Use `skills/p2p-skill-share/SKILL.md` when those generated skills should be handed to another peer over a Cloudflare-relayed tunnel.",
  ];

  if (matches.length > 0) {
    lines.push("- Generated skills from local Codex history:");
    for (const match of matches) {
      lines.push(
        `- \`skills/${match.workflow.slug}/SKILL.md\` — ${match.workflow.coreJob}`,
      );
    }
  }

  return `${AGENTS_MARKER_BEGIN}\n${lines.join("\n")}\n${AGENTS_MARKER_END}`;
}

export function upsertAgentsBlock(content: string, block: string): string {
  const existing = new RegExp(`${AGENTS_MARKER_BEGIN}[\\s\\S]*?${AGENTS_MARKER_END}`);
  if (existing.test(content)) return content.replace(existing, block);

  if (content.includes("## Releases")) {
    return content.replace("## Releases", `${block}\n\n## Releases`);
  }

  return `${content.trimEnd()}\n\n${block}\n`;
}

export function writeGeneratedSkills(matches: WorkflowMatch[]): void {
  for (const match of matches) {
    const skillDir = path.join(GENERATED_SKILL_ROOT, match.workflow.slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), renderGeneratedSkill(match));
  }
}

export function runHistorySkillMiner(homeDir = process.env.HOME ?? ""): WorkflowMatch[] {
  if (!existsSync(FIRST_PRINCIPLES_SKILL_PATH)) {
    throw new Error(`Missing first-principles skill at ${FIRST_PRINCIPLES_SKILL_PATH}`);
  }

  const samples = loadDefaultHistorySamples(homeDir);
  const matches = scoreWorkflowCatalog(samples);

  mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  writeGeneratedSkills(matches);
  writeFileSync(REGISTRY_PATH, renderRegistry(matches, samples.length));

  const agents = readFileSync(AGENTS_PATH, "utf8");
  writeFileSync(AGENTS_PATH, upsertAgentsBlock(agents, renderAgentsBlock(matches)));

  return matches;
}

if (import.meta.main) {
  const matches = runHistorySkillMiner();
  console.log(
    `Generated ${matches.length} history-derived skill(s): ${matches.map((match) => match.workflow.slug).join(", ")}`,
  );
}
