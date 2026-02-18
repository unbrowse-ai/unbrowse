import { searchIntent } from "../discovery/index.js";
import { captureSession } from "../capture/index.js";
import { extractEndpoints } from "../reverse-engineer/index.js";
import { validateSkillManifest } from "../validator/index.js";
import { publishSkill, getSkill } from "../marketplace/index.js";
import { executeSkill } from "../execution/index.js";
import type { ExecutionTrace, SkillManifest } from "../types/index.js";

const CONFIDENCE_THRESHOLD = 0.30; // Gemini RETRIEVAL_QUERY vs RETRIEVAL_DOCUMENT cosine typically 0.35-0.50

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
  // 1. Discovery -- search EmergentDB for matching skill
  const candidates = await searchIntent(intent, 5).catch(() => []);
  const top = candidates[0];

  if (top && top.score >= CONFIDENCE_THRESHOLD) {
    const skillId = extractSkillId(top.metadata);
    const skill = skillId ? getSkill(skillId) : null;
    if (skill && skill.lifecycle === "active") {
      const { trace, result } = await executeSkill(skill, params);
      return { result, trace, source: "marketplace", skill };
    }
  }

  // 2. No match -- live capture required
  if (!context?.url) {
    throw new Error(
      "No matching skill found. Pass context.url to trigger live capture and discovery."
    );
  }

  const captured = await captureSession(context.url);
  const endpoints = extractEndpoints(captured.requests);

  if (endpoints.length === 0) {
    throw new Error(`No API endpoints discovered at ${context.url}`);
  }

  const domain = context.domain ?? captured.domain;

  const draftFull = {
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active" as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: `${domain} -- ${intent}`,
    intent_signature: intent,
    domain,
    description: `Auto-discovered skill for: ${intent}`,
    owner_type: "agent" as const,
    endpoints,
  };

  // validate with a temp id; publishSkill generates the real nanoid
  const validation = validateSkillManifest({ ...draftFull, skill_id: "__validate__" });
  if (!validation.valid) {
    throw new Error(`Skill validation failed: ${validation.hardErrors.join("; ")}`);
  }

  // 3. Publish to marketplace + index
  const skill = await publishSkill(draftFull);

  // 4. Execute
  const { trace, result } = await executeSkill(skill, params);

  return { result, trace, source: "live-capture", skill };
}

function extractSkillId(metadata: Record<string, unknown>): string | null {
  try {
    const content = JSON.parse(metadata.content as string) as { skill_id?: string };
    return content.skill_id ?? null;
  } catch {
    return null;
  }
}
