import { searchIntent, searchIntentInDomain } from "../client/index.js";
import { publishSkill, getSkill } from "../marketplace/index.js";
import { executeSkill } from "../execution/index.js";
import type { ExecutionOptions, ExecutionTrace, ProjectionOptions, SkillManifest } from "../types/index.js";

const CONFIDENCE_THRESHOLD = 0.25;
const BROWSER_CAPTURE_SKILL_ID = "browser-capture";

export interface OrchestratorResult {
  result: unknown;
  trace: ExecutionTrace;
  source: "marketplace" | "live-capture";
  skill: SkillManifest;
}

function computeCompositeScore(
  embeddingScore: number,
  skill: SkillManifest
): number {
  // Average reliability across endpoints
  const reliabilities = skill.endpoints.map((e) => e.reliability_score);
  const avgReliability = reliabilities.length > 0
    ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
    : 0.5;

  // Freshness: 1 / (1 + daysSinceUpdate / 30)
  const daysSinceUpdate = (Date.now() - new Date(skill.updated_at).getTime()) / (1000 * 60 * 60 * 24);
  const freshnessScore = 1 / (1 + daysSinceUpdate / 30);

  // Verification bonus: 1.0 if all verified, 0.5 if some, 0.0 if none
  const verifiedCount = skill.endpoints.filter((e) => e.verification_status === "verified").length;
  const verificationBonus = skill.endpoints.length > 0
    ? verifiedCount === skill.endpoints.length ? 1.0
      : verifiedCount > 0 ? 0.5
      : 0.0
    : 0.0;

  return (
    0.40 * embeddingScore +
    0.30 * avgReliability +
    0.15 * freshnessScore +
    0.15 * verificationBonus
  );
}

export async function resolveAndExecute(
  intent: string,
  params: Record<string, unknown> = {},
  context?: { url?: string; domain?: string },
  projection?: ProjectionOptions,
  options?: ExecutionOptions
): Promise<OrchestratorResult> {
  // 1. Domain-scoped search first, fallback to global
  const requestedDomain = context?.domain ?? (context?.url ? new URL(context.url).hostname : null);
  const candidates = await (requestedDomain
    ? searchIntentInDomain(intent, requestedDomain, 5)
    : searchIntent(intent, 5)
  ).catch(() => []);

  // Rank all candidates by composite score, pick the best
  type RankedCandidate = { candidate: typeof candidates[0]; skill: SkillManifest; composite: number };
  const ranked: RankedCandidate[] = [];
  for (const c of candidates) {
    const skillId = extractSkillId(c.metadata);
    const skill = skillId ? await getSkill(skillId) : null;
    if (skill && skill.lifecycle === "active") {
      ranked.push({
        candidate: c,
        skill,
        composite: computeCompositeScore(c.score, skill),
      });
    }
  }
  ranked.sort((a, b) => b.composite - a.composite);

  const top = ranked[0];
  if (top && top.composite >= CONFIDENCE_THRESHOLD) {
    const { trace, result } = await executeSkill(top.skill, params, projection, options);
    return { result, trace, source: "marketplace", skill: top.skill };
  }

  // 2. No match -- invoke browser-capture skill
  if (!context?.url) {
    throw new Error(
      "No matching skill found. Pass context.url to trigger live capture and discovery."
    );
  }
  const captureSkill = await getOrCreateBrowserCaptureSkill();
  const { trace, result, learned_skill } = await executeSkill(captureSkill, {
    ...params,
    url: context.url,
    intent,
  });

  // Auth-gated site: pass through structured error
  if (!learned_skill) {
    return { result, trace, source: "live-capture", skill: captureSkill };
  }

  // 3. Execute the newly learned skill immediately
  const { trace: execTrace, result: execResult } = await executeSkill(learned_skill, params, projection, options);

  return { result: execResult, trace: execTrace, source: "live-capture", skill: learned_skill };
}

async function getOrCreateBrowserCaptureSkill(): Promise<SkillManifest> {
  const existing = await getSkill(BROWSER_CAPTURE_SKILL_ID);
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

  await publishSkill(skill).catch(() => {});
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
