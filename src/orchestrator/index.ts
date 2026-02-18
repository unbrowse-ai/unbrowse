import { searchIntent, searchIntentInDomain } from "../discovery/index.js";
import { publishSkill, getSkill } from "../marketplace/index.js";
import { executeSkill } from "../execution/index.js";
import type { ExecutionTrace, SkillManifest } from "../types/index.js";

const CONFIDENCE_THRESHOLD = 0.30;
const BROWSER_CAPTURE_SKILL_ID = "browser-capture";

export interface OrchestratorResult {
  result: unknown;
  trace: ExecutionTrace;
  source: "marketplace" | "live-capture";
  skill: SkillManifest;
}

export async function resolveAndExecute(
  intent: string,
  params: Record<string, unknown> = {},
  context?: { url?: string; domain?: string }
): Promise<OrchestratorResult> {
  // 1. Domain-scoped search first, fallback to global
  const requestedDomain = context?.domain ?? (context?.url ? new URL(context.url).hostname : null);
  const candidates = await (requestedDomain
    ? searchIntentInDomain(intent, requestedDomain, 5)
    : searchIntent(intent, 5)
  ).catch(() => []);
  const top = candidates[0];

  if (top && top.score >= CONFIDENCE_THRESHOLD) {
    const skillId = extractSkillId(top.metadata);
    const skill = skillId ? getSkill(skillId) : null;
    if (skill && skill.lifecycle === "active") {
      const { trace, result } = await executeSkill(skill, params);
      return { result, trace, source: "marketplace", skill };
    }
  }

  // 2. No match -- invoke browser-capture skill
  if (!context?.url) {
    throw new Error(
      "No matching skill found. Pass context.url to trigger live capture and discovery."
    );
  }

  const captureSkill = getOrCreateBrowserCaptureSkill();
  const { trace, result, learned_skill } = await executeSkill(captureSkill, {
    ...params,
    url: context.url,
    intent,
  });

  if (!learned_skill) throw new Error("Browser capture did not produce a skill");

  // 3. Execute the newly learned skill immediately
  const { trace: execTrace, result: execResult } = await executeSkill(learned_skill, params);

  return { result: execResult, trace: execTrace, source: "live-capture", skill: learned_skill };
}

function getOrCreateBrowserCaptureSkill(): SkillManifest {
  const existing = getSkill(BROWSER_CAPTURE_SKILL_ID);
  if (existing) return existing;

  const now = new Date().toISOString();
  const skill: SkillManifest = {
    skill_id: BROWSER_CAPTURE_SKILL_ID,
    version: "1.0.0",
    schema_version: "1",
    name: "Browser Capture",
    intent_signature: "capture and learn API endpoints from a URL",
    domain: "agent",
    description: "Meta-skill: launches a headless browser, records HAR, reverse-engineers API endpoints, and publishes a new skill to the marketplace.",
    owner_type: "agent",
    execution_type: "browser-capture",
    endpoints: [],
    lifecycle: "active",
    created_at: now,
    updated_at: now,
  };

  publishSkill(skill).catch(() => {});
  return skill;
}

function extractSkillId(metadata: Record<string, unknown>): string | null {
  try {
    const content = JSON.parse(metadata.content as string) as { skill_id?: string };
    return content.skill_id ?? null;
  } catch {
    return null;
  }
}
