import { searchIntent, searchIntentInDomain, recordOrchestrationPerf } from "../client/index.js";
import { publishSkill, getSkill } from "../marketplace/index.js";
import { executeSkill, rankEndpoints } from "../execution/index.js";
import { getRegistrableDomain } from "../domain.js";
import type { ExecutionOptions, ExecutionTrace, OrchestrationTiming, ProjectionOptions, SkillManifest } from "../types/index.js";

const CONFIDENCE_THRESHOLD = 0.3;
const BROWSER_CAPTURE_SKILL_ID = "browser-capture";

// Per-domain skill cache: after a live capture succeeds, cache the skill for 60s so
// subsequent requests hit the local cache instead of re-capturing (avoids EmergentDB lag).
const capturedDomainCache = new Map<string, { skill: SkillManifest; expires: number }>();
// In-flight lock: prevents parallel captures of the same domain within the same process.
const captureInFlight = new Set<string>();
// Route cache: intent+domain → skill_id, skips search+getSkill on repeat queries.
const skillRouteCache = new Map<string, { skillId: string; endpointId: string; domain: string; ts: number }>();
const ROUTE_CACHE_TTL = 5 * 60_000; // 5 minutes

/** Called by the execute route after a successful agent-picked execution.
 *  Caches the intent→endpoint mapping so the next identical resolve auto-executes. */
export function cacheRoute(intent: string, domain: string | null, skillId: string, endpointId: string): void {
  const key = `${domain || "global"}:${intent}`;
  skillRouteCache.set(key, { skillId, endpointId, domain: domain || "", ts: Date.now() });
}

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

  // Fallback baselines when a skill has no discovery_cost (old skills / first capture)
  const DEFAULT_CAPTURE_MS = 22_000;
  const DEFAULT_CAPTURE_TOKENS = 30_000;
  const CHARS_PER_TOKEN = 4;

  function finalize(source: OrchestrationTiming["source"], result: unknown, skillId?: string, skill?: SkillManifest, trace?: ExecutionTrace): OrchestrationTiming {
    timing.total_ms = Date.now() - t0;
    timing.source = source;
    timing.skill_id = skillId;

    // Measure response size
    const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
    timing.response_bytes = resultStr.length;
    const responseTokens = Math.ceil(resultStr.length / CHARS_PER_TOKEN);

    // Use real discovery cost from the skill when available, fall back to estimates
    const cost = skill?.discovery_cost;
    const baselineTokens = cost?.capture_tokens ?? DEFAULT_CAPTURE_TOKENS;
    const baselineMs = cost?.capture_ms ?? DEFAULT_CAPTURE_MS;

    // Token savings: marketplace/cache returns structured data, skipping full-page browsing
    if (source === "marketplace" || source === "route-cache") {
      timing.tokens_saved = Math.max(0, baselineTokens - responseTokens);
      timing.tokens_saved_pct = baselineTokens > 0 ? Math.round(timing.tokens_saved / baselineTokens * 100) : 0;
      timing.time_saved_pct = baselineMs > 0 ? Math.round(Math.max(0, baselineMs - timing.total_ms) / baselineMs * 100) : 0;
    }

    // Stamp trace with token metrics so they persist in trace files
    if (trace) {
      trace.tokens_used = responseTokens;
      trace.tokens_saved = timing.tokens_saved;
      trace.tokens_saved_pct = timing.tokens_saved_pct;
    }

    console.log(`[perf] ${source}: ${timing.total_ms}ms (time_saved=${timing.time_saved_pct}% tokens_saved=${timing.tokens_saved_pct}%${cost ? " [real baseline]" : " [estimated]"})`);
    // Fire-and-forget to backend
    recordOrchestrationPerf(timing).catch(() => {});
    return timing;
  }

  // Fast path: if the agent previously picked an endpoint for this intent+domain, replay it
  const requestedDomain = context?.domain ?? (context?.url ? new URL(context.url).hostname : null);
  const cacheKey = `${requestedDomain || "global"}:${intent}`;
  const cached = skillRouteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ROUTE_CACHE_TTL) {
    const skill = await getSkill(cached.skillId);
    if (skill) {
      const te0 = Date.now();
      try {
        const { trace, result } = await executeSkill(skill, { ...params, endpoint_id: cached.endpointId }, projection, { ...options, intent });
        timing.execute_ms = Date.now() - te0;
        if (trace.success) {
          timing.cache_hit = true;
          return { result, trace, source: "marketplace", skill, timing: finalize("route-cache", result, cached.skillId, skill, trace) };
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
  // When a target domain is specified, only accept skills from that domain.
  // This prevents the marketplace from matching e.g. beehiiv for a linkedin query.
  const targetRegDomain = requestedDomain ? getRegistrableDomain(requestedDomain) : null;
  for (const { c, skill } of skillResults) {
    if (!skill) { timing.filter_reasons ??= []; timing.filter_reasons.push(`${extractSkillId(c.metadata)}: skill not found`); continue; }
    if (skill.lifecycle !== "active") { timing.filter_reasons ??= []; timing.filter_reasons.push(`${skill.skill_id}: lifecycle=${skill.lifecycle}`); continue; }
    if (!hasUsableEndpoints(skill)) { timing.filter_reasons ??= []; timing.filter_reasons.push(`${skill.skill_id}: no usable endpoints`); continue; }
    if (targetRegDomain && getRegistrableDomain(skill.domain) !== targetRegDomain) { timing.filter_reasons ??= []; timing.filter_reasons.push(`${skill.skill_id}: domain mismatch (${skill.domain} vs ${targetRegDomain})`); continue; }
    ranked.push({ candidate: c, skill, composite: computeCompositeScore(c.score, skill) });
  }
  ranked.sort((a, b) => b.composite - a.composite);

  // Marketplace hit — return skill + endpoints for the agent to pick, don't auto-execute.
  // The agent calls POST /v1/skills/{id}/execute with the chosen endpoint_id.
  // On success, cacheRoute() remembers the pick for instant replay next time.
  if (ranked.length > 0 && ranked[0].composite >= CONFIDENCE_THRESHOLD) {
    const best = ranked[0];
    timing.candidates_tried = 0;
    const trace: ExecutionTrace = {
      trace_id: `resolve-${Date.now()}`,
      skill_id: best.skill.skill_id,
      endpoint_id: "",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: true,
    };
    return {
      result: {
        message: `Found skill with ${best.skill.endpoints.length} endpoint(s). Pick an endpoint_id and call POST /v1/skills/${best.skill.skill_id}/execute.`,
        hint: "Call POST /v1/skills/{skill_id}/execute with params.endpoint_id set to your chosen endpoint.",
        skill_id: best.skill.skill_id,
      },
      trace,
      source: "marketplace" as const,
      skill: best.skill,
      timing: finalize("marketplace", null, best.skill.skill_id, best.skill, trace),
    };
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
    return { result, trace, source: "marketplace", skill: domainHit.skill, timing: finalize("marketplace", result, domainHit.skill.skill_id, domainHit.skill, trace) };
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

  // Stamp learned skill with real discovery cost so future cache hits use real baselines.
  // capture_tokens uses DEFAULT_CAPTURE_TOKENS (not the deferral response size) because
  // it represents the LLM-browsing cost baseline, not the bytes we sent back to the caller.
  if (learned_skill) {
    const captureResultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
    learned_skill.discovery_cost = {
      capture_ms: timing.execute_ms,
      capture_tokens: DEFAULT_CAPTURE_TOKENS,
      response_bytes: captureResultStr.length,
      captured_at: new Date().toISOString(),
    };
    // Re-publish with discovery_cost attached (fire-and-forget)
    publishSkill(learned_skill).catch((err) => console.error("[publish] discovery_cost update failed:", (err as Error).message));
  }

  // Auth-gated or no data: pass through error
  if (!learned_skill && !trace.success) {
    return { result, trace, source: "live-capture", skill: captureSkill!, timing: finalize("live-capture", result, undefined, undefined, trace) };
  }

  // DOM-extracted skill: data already extracted during capture, skip re-execution
  const isDomSkill = learned_skill?.endpoints?.some((ep) => ep.dom_extraction);
  if (isDomSkill || (!learned_skill && trace.success)) {
    return { result, trace, source: "dom-fallback", skill: learned_skill ?? captureSkill!, timing: finalize("dom-fallback", result, learned_skill?.skill_id, learned_skill, trace) };
  }

  // Cache the learned API skill so the next request finds it without re-capturing
  if (learned_skill) {
    capturedDomainCache.set(captureDomain, { skill: learned_skill, expires: Date.now() + 60_000 });
  }

  // 3. Always defer to the agent on fresh captures.
  // The agent sees the full available_endpoints list (surfaced by the route handler)
  // and can make an intelligent selection. Auto-execution on capture often picks wrong
  // (e.g. ad endpoints, tracking, config blobs). Let the agent review first.
  if (!params.endpoint_id) {
    const epRanked = rankEndpoints(learned_skill!.endpoints, intent, learned_skill!.domain);
    const deferTrace: ExecutionTrace = {
      trace_id: trace.trace_id,
      skill_id: learned_skill!.skill_id,
      endpoint_id: "",
      started_at: trace.started_at,
      completed_at: new Date().toISOString(),
      success: true,
    };
    return {
      result: {
        message: `Discovered ${epRanked.length} endpoint(s). Review available_endpoints and re-execute with the correct endpoint_id.`,
        hint: "Call POST /v1/skills/{skill_id}/execute with params.endpoint_id set to your chosen endpoint.",
        skill_id: learned_skill!.skill_id,
      },
      trace: deferTrace,
      source: "live-capture",
      skill: learned_skill!,
      timing: finalize("live-capture", null, learned_skill!.skill_id, learned_skill, deferTrace),
    };
  }

  // Agent specified an endpoint_id — execute it directly
  const te1 = Date.now();
  const { trace: execTrace, result: execResult } = await executeSkill(learned_skill!, params, projection, { ...options, intent });
  timing.execute_ms += Date.now() - te1;

  return { result: execResult, trace: execTrace, source: "live-capture", skill: learned_skill!, timing: finalize("live-capture", execResult, learned_skill!.skill_id, learned_skill, execTrace) };
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

  await publishSkill(skill).catch((err) => console.error("[publish] browser-capture skill update failed:", (err as Error).message));
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
      // Must have a response schema (JSON) or be an API-like path
      return !!ep.response_schema || /\/(api|v\d+)\//i.test(u.pathname) || !!ep.dom_extraction;
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
