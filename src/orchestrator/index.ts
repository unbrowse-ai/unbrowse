import { searchIntent, searchIntentInDomain, recordOrchestrationPerf } from "../client/index.js";
import { publishSkill, getSkill } from "../marketplace/index.js";
import { executeSkill } from "../execution/index.js";
import type { ExecutionOptions, ExecutionTrace, OrchestrationTiming, ProjectionOptions, SkillManifest } from "../types/index.js";

const CONFIDENCE_THRESHOLD = 0.3;
const BROWSER_CAPTURE_SKILL_ID = "browser-capture";

// Per-domain skill cache: after a live capture succeeds, cache the skill for 60s so
// subsequent requests hit the local cache instead of re-capturing (avoids EmergentDB lag).
const capturedDomainCache = new Map<string, { skill: SkillManifest; expires: number }>();
// In-flight lock: prevents parallel captures of the same domain within the same process.
const captureInFlight = new Set<string>();
// Route cache: intent+domain → skill_id, skips search+getSkill on repeat queries.
const skillRouteCache = new Map<string, { skillId: string; domain: string; ts: number }>();
const ROUTE_CACHE_TTL = 5 * 60_000; // 5 minutes

export interface OrchestratorResult {
  result: unknown;
  trace: ExecutionTrace;
  source: "marketplace" | "live-capture" | "dom-fallback";
  skill: SkillManifest;
  timing: OrchestrationTiming;
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
  const t0 = Date.now();
  const timing: OrchestrationTiming = {
    search_ms: 0, get_skill_ms: 0, execute_ms: 0, total_ms: 0,
    source: "marketplace", cache_hit: false, candidates_found: 0, candidates_tried: 0,
    tokens_saved: 0, response_bytes: 0, time_saved_pct: 0, tokens_saved_pct: 0,
  };

  // Baselines for percentage calculations
  // Live capture: browser launch + page load + HAR analysis + skill learning + re-execution
  const ESTIMATED_LIVE_CAPTURE_MS = 22_000;
  // Full-page browsing cost: ~100KB HTML → ~25K tokens + ~10K HAR context
  const ESTIMATED_BROWSE_TOKENS = 30_000;
  const CHARS_PER_TOKEN = 4;

  function finalize(source: OrchestrationTiming["source"], result: unknown, skillId?: string): OrchestrationTiming {
    timing.total_ms = Date.now() - t0;
    timing.source = source;
    timing.skill_id = skillId;

    // Measure response size
    const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
    timing.response_bytes = resultStr.length;
    const responseTokens = Math.ceil(resultStr.length / CHARS_PER_TOKEN);

    // Token savings: marketplace/cache returns structured data, skipping full-page browsing
    if (source === "marketplace" || source === "route-cache") {
      timing.tokens_saved = Math.max(0, ESTIMATED_BROWSE_TOKENS - responseTokens);
      timing.tokens_saved_pct = Math.round(timing.tokens_saved / ESTIMATED_BROWSE_TOKENS * 100);
      timing.time_saved_pct = Math.round(Math.max(0, ESTIMATED_LIVE_CAPTURE_MS - timing.total_ms) / ESTIMATED_LIVE_CAPTURE_MS * 100);
    }

    console.log(`[perf] ${source}: ${timing.total_ms}ms (time_saved=${timing.time_saved_pct}% tokens_saved=${timing.tokens_saved_pct}%)`);
    // Fire-and-forget to backend
    recordOrchestrationPerf(timing).catch(() => {});
    return timing;
  }

  // Fast path: if we've successfully executed this intent+domain before, skip search entirely
  const requestedDomain = context?.domain ?? (context?.url ? new URL(context.url).hostname : null);
  const cacheKey = `${requestedDomain || "global"}:${intent}`;
  const cached = skillRouteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ROUTE_CACHE_TTL) {
    const skill = await getSkill(cached.skillId);
    if (skill) {
      const te0 = Date.now();
      try {
        const { trace, result } = await executeSkill(skill, params, projection, { ...options, intent });
        timing.execute_ms = Date.now() - te0;
        if (trace.success) {
          timing.cache_hit = true;
          return { result, trace, source: "marketplace", skill, timing: finalize("route-cache", result, cached.skillId) };
        }
      } catch { timing.execute_ms = Date.now() - te0; }
    }
    skillRouteCache.delete(cacheKey); // stale — remove
  }

  // 1. Search marketplace — domain + global in parallel
  const ts0 = Date.now();
  type SearchResult = { id: number; score: number; metadata: Record<string, unknown> };
  const [domainResults, globalResults] = await Promise.all([
    requestedDomain
      ? searchIntentInDomain(intent, requestedDomain, 5).catch(() => [] as SearchResult[])
      : Promise.resolve([] as SearchResult[]),
    searchIntent(intent, 10).catch(() => [] as SearchResult[]),
  ]);
  timing.search_ms = Date.now() - ts0;

  // Merge: domain results first (higher precision), then global (broader recall), deduplicate by skill_id
  const seen = new Set<string>();
  const candidates: typeof domainResults = [];
  for (const c of [...domainResults, ...globalResults]) {
    const sid = extractSkillId(c.metadata);
    if (sid && !seen.has(sid)) {
      seen.add(sid);
      candidates.push(c);
    }
  }

  // Fetch all skills in parallel — don't waste time on serial 404s
  type RankedCandidate = { candidate: typeof candidates[0]; skill: SkillManifest; composite: number };
  const tg0 = Date.now();
  const skillResults = await Promise.all(
    candidates.map(async (c) => {
      const skillId = extractSkillId(c.metadata)!;
      const skill = await getSkill(skillId);
      return { c, skill };
    })
  );
  timing.get_skill_ms = Date.now() - tg0;
  timing.candidates_found = skillResults.filter(r => r.skill).length;

  const ranked: RankedCandidate[] = [];
  for (const { c, skill } of skillResults) {
    if (!skill) continue;
    if (skill.lifecycle !== "active") continue;
    if (!hasUsableEndpoints(skill)) continue;
    ranked.push({ candidate: c, skill, composite: computeCompositeScore(c.score, skill) });
  }
  ranked.sort((a, b) => b.composite - a.composite);

  // Try marketplace skills — if execution fails, fall through to live capture
  for (const candidate of ranked) {
    if (candidate.composite < CONFIDENCE_THRESHOLD) break;
    timing.candidates_tried++;
    const te0 = Date.now();
    try {
      const { trace, result } = await executeSkill(candidate.skill, params, projection, { ...options, intent });
      timing.execute_ms += Date.now() - te0;
      if (trace.success) {
        // Cache this route for fast repeat lookups
        skillRouteCache.set(cacheKey, { skillId: candidate.skill.skill_id, domain: candidate.skill.domain, ts: Date.now() });
        return { result, trace, source: "marketplace" as const, skill: candidate.skill, timing: finalize("marketplace", result, candidate.skill.skill_id) };
      }
    } catch {
      timing.execute_ms += Date.now() - te0;
    }
  }

  // 2. No match -- invoke browser-capture skill
  if (!context?.url) {
    throw new Error(
      "No matching skill found. Pass context.url to trigger live capture and discovery."
    );
  }

  const captureDomain = new URL(context.url).hostname;

  // Check recently-captured cache: avoids re-capturing when EmergentDB hasn't indexed yet
  const domainHit = capturedDomainCache.get(captureDomain);
  if (domainHit && Date.now() < domainHit.expires) {
    const { trace, result } = await executeSkill(domainHit.skill, params, projection, { ...options, intent });
    return { result, trace, source: "marketplace", skill: domainHit.skill, timing: finalize("marketplace", result, domainHit.skill.skill_id) };
  }

  // In-flight lock: reject parallel captures of the same domain to prevent thundering herd
  if (captureInFlight.has(captureDomain)) {
    throw new Error(
      `Live capture for ${captureDomain} is already in progress. Retry in a few seconds.`
    );
  }
  captureInFlight.add(captureDomain);

  let learned_skill: SkillManifest | undefined;
  let trace: import("../types/index.js").ExecutionTrace;
  let result: unknown;
  let captureSkill: SkillManifest;
  const te0 = Date.now();
  try {
    captureSkill = await getOrCreateBrowserCaptureSkill();
    const out = await executeSkill(captureSkill, { ...params, url: context.url, intent });
    trace = out.trace;
    result = out.result;
    learned_skill = out.learned_skill;
  } finally {
    captureInFlight.delete(captureDomain);
  }
  timing.execute_ms = Date.now() - te0;

  // Auth-gated or no data: pass through error
  if (!learned_skill && !trace.success) {
    return { result, trace, source: "live-capture", skill: captureSkill!, timing: finalize("live-capture", result) };
  }

  // DOM-extracted skill: data already extracted during capture, skip re-execution
  const isDomSkill = learned_skill?.endpoints?.some((ep) => ep.dom_extraction);
  if (isDomSkill || (!learned_skill && trace.success)) {
    return { result, trace, source: "dom-fallback", skill: learned_skill ?? captureSkill!, timing: finalize("dom-fallback", result, learned_skill?.skill_id) };
  }

  // Cache the learned API skill so the next request finds it without re-capturing
  if (learned_skill) {
    capturedDomainCache.set(captureDomain, { skill: learned_skill, expires: Date.now() + 60_000 });
  }
  // 3. Execute the newly learned API skill immediately
  const te1 = Date.now();
  const { trace: execTrace, result: execResult } = await executeSkill(learned_skill!, params, projection, { ...options, intent });
  timing.execute_ms += Date.now() - te1;

  return { result: execResult, trace: execTrace, source: "live-capture", skill: learned_skill!, timing: finalize("live-capture", execResult, learned_skill!.skill_id) };
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

/** Reject skills where no endpoint returns structured data from the skill's domain */
function hasUsableEndpoints(skill: SkillManifest): boolean {
  if (!skill.endpoints || skill.endpoints.length === 0) return false;
  return skill.endpoints.some((ep) => {
    try {
      const u = new URL(ep.url_template);
      const onDomain = u.hostname === skill.domain || u.hostname.endsWith(`.${skill.domain}`);
      if (!onDomain) return false;
      // Must have a response schema (JSON) or be an API-style path
      return !!ep.response_schema || /\/api\//i.test(u.pathname) || !!ep.dom_extraction;
    } catch { return false; }
  });
}

function extractSkillId(metadata: Record<string, unknown>): string | null {
  try {
    const content = JSON.parse(metadata.content as string) as { skill_id?: string };
    return content.skill_id ?? null;
  } catch {
    return null;
  }
}
