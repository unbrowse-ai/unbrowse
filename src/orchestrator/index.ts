import { searchIntent, searchIntentInDomain, recordOrchestrationPerf } from "../client/index.js";
import { publishSkill, getSkill } from "../marketplace/index.js";
import { executeSkill, rankEndpoints } from "../execution/index.js";
import { getRegistrableDomain } from "../domain.js";
import type { ExecutionOptions, ExecutionTrace, OrchestrationTiming, ProjectionOptions, ResponseSchema, SkillManifest } from "../types/index.js";
import { TRACE_VERSION } from "../version.js";
import { nanoid } from "nanoid";

const CONFIDENCE_THRESHOLD = 0.3;

/** Flat map of top-level property names → types from a ResponseSchema.
 *  Gives agents enough shape to pick --path targets without full schema bloat. */
function summarizeSchema(schema: ResponseSchema): Record<string, string> | null {
  if (schema.properties) {
    return Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, v.type])
    );
  }
  if (schema.type === "array" && schema.items?.properties) {
    return Object.fromEntries(
      Object.entries(schema.items.properties).map(([k, v]) => [k, v.type])
    );
  }
  return null;
}
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
  response_schema?: ResponseSchema;
  extraction_hints?: import("../transform/schema-hints.js").ExtractionHint;
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
    trace_version: TRACE_VERSION,
  };

  // Fallback baselines when a skill has no discovery_cost (old skills / first capture)
  const DEFAULT_CAPTURE_MS = 22_000;
  const DEFAULT_CAPTURE_TOKENS = 30_000;
  const CHARS_PER_TOKEN = 4;

  // When the agent explicitly passes endpoint_id, execute directly — they already chose.
  const agentChoseEndpoint = !!params.endpoint_id;

  const forceCapture = !!options?.force_capture;
  // force_capture: clear domain caches so we go straight to browser capture
  if (forceCapture && context?.url) {
    const d = new URL(context.url).hostname;
    capturedDomainCache.delete(d);
    for (const [k] of skillRouteCache) {
      if (k.includes(d)) skillRouteCache.delete(k);
    }
  }

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

  /** Build a deferral response — returns the skill + ranked endpoints for the agent to choose. */
  function buildDeferral(skill: SkillManifest, source: "marketplace" | "live-capture", extraFields?: Record<string, unknown>): OrchestratorResult {
    const epRanked = rankEndpoints(skill.endpoints, intent, skill.domain, context?.url);
    const deferTrace: ExecutionTrace = {
      trace_id: nanoid(),
      skill_id: skill.skill_id,
      endpoint_id: "",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: true,
    };
    return {
      result: {
        message: `Found ${epRanked.length} endpoint(s). Pick one and call POST /v1/skills/${skill.skill_id}/execute with params.endpoint_id.`,
        skill_id: skill.skill_id,
        available_endpoints: epRanked.slice(0, 10).map((r) => ({
          endpoint_id: r.endpoint.endpoint_id,
          method: r.endpoint.method,
          description: r.endpoint.description,
          url: r.endpoint.url_template.length > 120 ? r.endpoint.url_template.slice(0, 120) + "..." : r.endpoint.url_template,
          score: Math.round(r.score * 10) / 10,
          schema_summary: r.endpoint.response_schema ? summarizeSchema(r.endpoint.response_schema) : null,
          dom_extraction: !!r.endpoint.dom_extraction,
          trigger_url: r.endpoint.trigger_url,
        })),
        ...extraFields,
      },
      trace: deferTrace,
      source,
      skill,
      timing: finalize(source, null, skill.skill_id, skill, deferTrace),
    };
  }

  /**
   * Try to auto-select and execute the best endpoint when the agent hasn't chosen one.
   * Uses BM25 ranking (boosted by LLM descriptions). Auto-executes when:
   * - Top endpoint has a clear score gap over #2 (>= 20% relative or absolute >= 15)
   * - Or skill has only 1 usable endpoint
   * Returns null if not confident enough (caller should fall back to deferral).
   */
  async function tryAutoExecute(
    skill: SkillManifest,
    source: "marketplace" | "live-capture"
  ): Promise<OrchestratorResult | null> {
    let epRanked = rankEndpoints(skill.endpoints, intent, skill.domain, context?.url);
    if (epRanked.length === 0) return null;

    // When BM25 scores are tied, use schema field overlap with intent as tiebreaker.
    // "get subreddit posts" → intent tokens ["subreddit","posts","get"]
    // Endpoint with schema {title, author, score, num_comments} > {token, expires}
    if (epRanked.length >= 2 && intent) {
      const intentTokens = new Set(
        intent.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(w => w.length > 2)
      );
      epRanked = epRanked.map((r) => {
        let schemaBonus = 0;
        const schema = r.endpoint.response_schema;
        if (schema) {
          const schemaStr = JSON.stringify(schema).toLowerCase();
          for (const tok of intentTokens) {
            if (schemaStr.includes(tok)) schemaBonus += 5;
          }
          // Rich schemas (many fields) are more likely data endpoints
          const propCount = schema.properties ? Object.keys(schema.properties).length : 0;
          if (propCount >= 5) schemaBonus += 3;
        }
        // Penalize noise endpoints (recaptcha, token, csrf, tracking)
        const url = r.endpoint.url_template.toLowerCase();
        if (/recaptcha|captcha|csrf|token$|consent|badge|drawer|header-action|logging|telemetry/i.test(url)) {
          schemaBonus -= 20;
        }
        return { ...r, score: r.score + schemaBonus };
      });
      epRanked.sort((a, b) => b.score - a.score);
    }

    const top = epRanked[0];
    const second = epRanked[1];

    // Try top candidates in order until one succeeds. If all fail, fall through to deferral.
    const MAX_TRIES = Math.min(epRanked.length, 3);
    const te0 = Date.now();
    for (let i = 0; i < MAX_TRIES; i++) {
      const candidate = epRanked[i];
      console.log(`[auto-exec] trying #${i + 1}: ${candidate.endpoint.endpoint_id} score=${candidate.score.toFixed(1)}`);
      try {
        const execOut = await executeSkill(
          skill,
          { ...params, endpoint_id: candidate.endpoint.endpoint_id },
          projection,
          { ...options, intent, contextUrl: context?.url }
        );
        timing.execute_ms = Date.now() - te0;
        if (execOut.trace.success) {
          skillRouteCache.set(cacheKey, { skillId: skill.skill_id, domain: skill.domain, ts: Date.now() });
          return {
            result: execOut.result, trace: execOut.trace, source, skill,
            timing: finalize(source, execOut.result, skill.skill_id, skill, execOut.trace),
            response_schema: execOut.response_schema,
            extraction_hints: execOut.extraction_hints,
          };
        }
        console.log(`[auto-exec] #${i + 1} failed: status=${execOut.trace.status_code}`);
      } catch (err) {
        console.log(`[auto-exec] #${i + 1} error: ${(err as Error).message}`);
      }
    }
    timing.execute_ms = Date.now() - te0;
    return null; // All candidates failed, fall through to deferral
  }

  const requestedDomain = context?.domain ?? (context?.url ? new URL(context.url).hostname : null);
  const cacheKey = `${requestedDomain || "global"}:${intent}`;

  // --- Agent explicitly chose an endpoint — execute directly via any cache/skill path ---
  if (!forceCapture && agentChoseEndpoint) {
    // Route cache
    const cached = skillRouteCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ROUTE_CACHE_TTL) {
      const skill = await getSkill(cached.skillId);
      if (skill) {
        const te0 = Date.now();
        try {
          const execOut = await executeSkill(skill, params, projection, { ...options, intent, contextUrl: context?.url });
          timing.execute_ms = Date.now() - te0;
          if (execOut.trace.success) {
            timing.cache_hit = true;
            return { result: execOut.result, trace: execOut.trace, source: "marketplace", skill, timing: finalize("route-cache", execOut.result, cached.skillId, skill, execOut.trace), response_schema: execOut.response_schema, extraction_hints: execOut.extraction_hints };
          }
        } catch { timing.execute_ms = Date.now() - te0; }
      }
      skillRouteCache.delete(cacheKey);
    }
  }

  // Local disk cache: find the consolidated domain skill.
  // With domain-level skills, BM25 rankEndpoints handles endpoint selection.
  if (!forceCapture && requestedDomain && context?.url) {
    const { findExistingSkillForDomain } = await import("../client/index.js");
    const localSkill = findExistingSkillForDomain(requestedDomain);
    if (localSkill && localSkill.endpoints.length > 0) {
      if (agentChoseEndpoint) {
        // Agent already picked — execute
        const te0 = Date.now();
        try {
          const execOut = await executeSkill(localSkill, params, projection, { ...options, intent, contextUrl: context?.url });
          timing.execute_ms = Date.now() - te0;
          if (execOut.trace.success) {
            timing.cache_hit = true;
            skillRouteCache.set(cacheKey, { skillId: localSkill.skill_id, domain: localSkill.domain, ts: Date.now() });
            return { result: execOut.result, trace: execOut.trace, source: "marketplace", skill: localSkill, timing: finalize("route-cache", execOut.result, localSkill.skill_id, localSkill, execOut.trace), response_schema: execOut.response_schema, extraction_hints: execOut.extraction_hints };
          }
        } catch { timing.execute_ms = Date.now() - te0; }
      } else {
        // Try auto-execute, fall back to deferral
        const autoResult = await tryAutoExecute(localSkill, "marketplace");
        if (autoResult) return autoResult;
        return buildDeferral(localSkill, "marketplace");
      }
    }
  }

 if (!forceCapture) {
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

  // Merge: domain results first (higher precision), then global (broader recall)
  // Dedup by skill_id+endpoint_id — search now returns per-endpoint vectors
  const seen = new Set<string>();
  const candidates: typeof domainResults = [];
  for (const c of [...domainResults, ...globalResults]) {
    const sid = extractSkillId(c.metadata);
    const eid = extractEndpointId(c.metadata);
    const key = eid ? `${sid}:${eid}` : sid;
    if (sid && key && !seen.has(key)) {
      seen.add(key);
      candidates.push(c);
    }
  }

  // Fetch all unique skills in parallel — don't waste time on serial 404s
  type RankedCandidate = { candidate: typeof candidates[0]; skill: SkillManifest; composite: number; endpointId?: string };
  const tg0 = Date.now();
  const uniqueSkillIds = [...new Set(candidates.map((c) => extractSkillId(c.metadata)!))];
  const skillMap = new Map<string, SkillManifest>();
  await Promise.all(
    uniqueSkillIds.map(async (skillId) => {
      const skill = await getSkill(skillId);
      if (skill) skillMap.set(skillId, skill);
    })
  );
  timing.get_skill_ms = Date.now() - tg0;
  timing.candidates_found = skillMap.size;

  const ranked: RankedCandidate[] = [];
  // When a target domain is specified, only accept skills from that domain.
  const targetRegDomain = requestedDomain ? getRegistrableDomain(requestedDomain) : null;
  for (const c of candidates) {
    const skillId = extractSkillId(c.metadata)!;
    const skill = skillMap.get(skillId);
    if (!skill) continue;
    if (skill.lifecycle !== "active") continue;
    if (!hasUsableEndpoints(skill)) continue;
    if (targetRegDomain && getRegistrableDomain(skill.domain) !== targetRegDomain) continue;
    const endpointId = extractEndpointId(c.metadata) ?? undefined;
    ranked.push({ candidate: c, skill, composite: computeCompositeScore(c.score, skill), endpointId });
  }
  ranked.sort((a, b) => b.composite - a.composite);

  // If marketplace found viable skills, defer to the agent (or execute if they already chose).
  const viable = ranked.filter((c) => c.composite >= CONFIDENCE_THRESHOLD).slice(0, 3);
  timing.candidates_tried = viable.length;
  if (viable.length > 0) {
    if (agentChoseEndpoint) {
      // Agent already picked an endpoint — race top candidates to execute it
      const te0 = Date.now();
      try {
        const winner = await Promise.any(
          viable.map((candidate, i) =>
            Promise.race([
              executeSkill(candidate.skill, params, projection, { ...options, intent, contextUrl: context?.url })
                .then((execOut) => {
                  if (!execOut.trace.success) {
                    console.log(`[race] candidate ${i} (${candidate.skill.skill_id}) failed: status=${execOut.trace.status_code}`);
                    throw new Error("execution failed");
                  }
                  return { ...execOut, candidate };
                })
                .catch((err) => {
                  console.log(`[race] candidate ${i} (${candidate.skill.skill_id}) error: ${(err as Error).message}`);
                  throw err;
                }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 30_000)),
            ])
          )
        );
        timing.execute_ms = Date.now() - te0;
        skillRouteCache.set(cacheKey, { skillId: winner.candidate.skill.skill_id, domain: winner.candidate.skill.domain, ts: Date.now() });
        return { result: winner.result, trace: winner.trace, source: "marketplace" as const, skill: winner.candidate.skill, timing: finalize("marketplace", winner.result, winner.candidate.skill.skill_id, winner.candidate.skill, winner.trace), response_schema: winner.response_schema, extraction_hints: winner.extraction_hints };
      } catch (err) {
        console.log(`[race] all candidates failed after ${Date.now() - te0}ms: ${(err as Error).message}`);
        timing.execute_ms = Date.now() - te0;
      }
    } else {
      const best = viable[0];
      // If search returned a specific endpoint (per-endpoint indexing), execute it directly
      if (best.endpointId) {
        console.log(`[search] endpoint-level hit: ${best.endpointId} score=${best.candidate.score.toFixed(3)}`);
        const te0 = Date.now();
        try {
          const execOut = await executeSkill(
            best.skill,
            { ...params, endpoint_id: best.endpointId },
            projection,
            { ...options, intent, contextUrl: context?.url }
          );
          timing.execute_ms = Date.now() - te0;
          if (execOut.trace.success) {
            skillRouteCache.set(cacheKey, { skillId: best.skill.skill_id, domain: best.skill.domain, ts: Date.now() });
            return {
              result: execOut.result, trace: execOut.trace, source: "marketplace" as const, skill: best.skill,
              timing: finalize("marketplace", execOut.result, best.skill.skill_id, best.skill, execOut.trace),
              response_schema: execOut.response_schema, extraction_hints: execOut.extraction_hints,
            };
          }
        } catch (err) {
          console.log(`[search] endpoint-level exec failed: ${(err as Error).message}`);
          timing.execute_ms = Date.now() - te0;
        }
      }
      // Fallback: try BM25 auto-execute, then deferral
      const autoResult = await tryAutoExecute(best.skill, "marketplace");
      if (autoResult) return autoResult;
      return buildDeferral(best.skill, "marketplace");
    }
  }
 } // end !forceCapture

  // 2. No match (or force_capture) — invoke browser-capture skill
  if (!context?.url) {
    throw new Error(
      "No matching skill found. Pass context.url to trigger live capture and discovery."
    );
  }

  const captureDomain = new URL(context.url).hostname;

  // Check recently-captured cache: avoids re-capturing when EmergentDB hasn't indexed yet
  const domainHit = !forceCapture ? capturedDomainCache.get(captureDomain) : undefined;
  if (domainHit && Date.now() < domainHit.expires) {
    if (agentChoseEndpoint) {
      const execOut = await executeSkill(domainHit.skill, params, projection, { ...options, intent, contextUrl: context?.url });
      return { result: execOut.result, trace: execOut.trace, source: "marketplace", skill: domainHit.skill, timing: finalize("marketplace", execOut.result, domainHit.skill.skill_id, domainHit.skill, execOut.trace), response_schema: execOut.response_schema, extraction_hints: execOut.extraction_hints };
    }
    return buildDeferral(domainHit.skill, "marketplace");
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
  if (learned_skill) {
    const captureResultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
    learned_skill.discovery_cost = {
      capture_ms: timing.execute_ms,
      capture_tokens: DEFAULT_CAPTURE_TOKENS,
      response_bytes: captureResultStr.length,
      captured_at: new Date().toISOString(),
    };

    // Generate local heuristic descriptions so BM25 auto-exec works immediately.
    // Backend will overwrite with LLM descriptions, but this unblocks the first request.
    for (const ep of learned_skill.endpoints) {
      if (!ep.description) {
        ep.description = generateLocalDescription(ep);
      }
    }

    // Await publish so backend-generated LLM descriptions come back before auto-exec
    try {
      const published = await publishSkill(learned_skill);
      // Update local copy with backend descriptions
      if (published.endpoints) {
        for (const ep of learned_skill.endpoints) {
          const backendEp = published.endpoints.find(
            (e) => e.endpoint_id === ep.endpoint_id
          );
          if (backendEp?.description) ep.description = backendEp.description;
        }
      }
    } catch (err) {
      console.error("[publish] discovery_cost update failed:", (err as Error).message);
    }
  }

  // Auth-gated or no data: pass through error
  if (!learned_skill && !trace.success) {
    return { result, trace, source: "live-capture", skill: captureSkill!, timing: finalize("live-capture", result, undefined, undefined, trace) };
  }

  // DOM-extracted skill: data already extracted during capture, return directly
  const isDomSkill = learned_skill?.endpoints?.some((ep) => ep.dom_extraction);
  if (isDomSkill || (!learned_skill && trace.success)) {
    return { result, trace, source: "dom-fallback", skill: learned_skill ?? captureSkill!, timing: finalize("dom-fallback", result, learned_skill?.skill_id, learned_skill, trace) };
  }

  // Cache the learned API skill so the next request finds it without re-capturing.
  if (learned_skill) {
    capturedDomainCache.set(captureDomain, { skill: learned_skill, expires: Date.now() + 5 * 60_000 });
    skillRouteCache.set(cacheKey, { skillId: learned_skill.skill_id, domain: learned_skill.domain, ts: Date.now() });
  }

  // Agent explicitly chose an endpoint — execute directly.
  if (agentChoseEndpoint && learned_skill) {
    const te1 = Date.now();
    const execOut = await executeSkill(learned_skill, params, projection, { ...options, intent, contextUrl: context?.url });
    timing.execute_ms += Date.now() - te1;
    return { result: execOut.result, trace: execOut.trace, source: "live-capture", skill: learned_skill, timing: finalize("live-capture", execOut.result, learned_skill.skill_id, learned_skill, execOut.trace), response_schema: execOut.response_schema, extraction_hints: execOut.extraction_hints };
  }

  // Try auto-execute on the learned skill, fall back to deferral
  if (learned_skill) {
    const autoResult = await tryAutoExecute(learned_skill, "live-capture");
    if (autoResult) return autoResult;
  }

  const captureResult = result as Record<string, unknown> | null;
  const authRecommended = captureResult?.auth_recommended === true;
  return buildDeferral(learned_skill!, "live-capture", authRecommended ? {
    auth_recommended: true,
    auth_hint: captureResult!.auth_hint,
  } : undefined);
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
      // Must have a response schema (JSON) or be an API-style path
      return !!ep.response_schema || /\/api\//i.test(u.pathname) || !!ep.dom_extraction;
    } catch { return false; }
  });
}

/** Generate a local heuristic description for an endpoint so BM25 can work immediately. */
function generateLocalDescription(ep: import("../types/index.js").EndpointDescriptor): string {
  let id = "";
  try {
    const u = new URL(ep.url_template);
    // GraphQL: extract queryId name
    const qid = u.searchParams.get("queryId") ?? "";
    const match = qid.match(/^([a-zA-Z]+)\./);
    if (match) id = match[1];
    // REST: last meaningful path segment
    if (!id) {
      const segs = u.pathname.split("/").filter((s) => s.length > 1 && !s.startsWith("{") && !/^v\d+$/.test(s));
      id = segs[segs.length - 1] ?? u.pathname;
    }
  } catch {
    id = ep.url_template.slice(0, 60);
  }

  // Split camelCase to words
  const words = id
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase()
    .replace(/^(voyager|api|graphql|dash)\s+/g, "")
    .replace(/\b(voyager|dash|graphql)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Schema keys for context
  const keys: string[] = [];
  if (ep.response_schema?.properties) {
    for (const [k, v] of Object.entries(ep.response_schema.properties)) {
      const sub = v as { properties?: Record<string, unknown> };
      if (sub?.properties) {
        keys.push(`${k}:{${Object.keys(sub.properties).slice(0, 4).join(",")}}`);
      } else {
        keys.push(k);
      }
    }
  }
  const keysStr = keys.slice(0, 8).join(", ");
  const core = words || "endpoint";
  return keysStr ? `Returns ${core} data. fields: ${keysStr}` : `Returns ${core} data`;
}

function extractSkillId(metadata: Record<string, unknown>): string | null {
  try {
    const content = JSON.parse(metadata.content as string) as { skill_id?: string };
    return content.skill_id ?? null;
  } catch {
    return null;
  }
}

function extractEndpointId(metadata: Record<string, unknown>): string | null {
  try {
    const content = JSON.parse(metadata.content as string) as { endpoint_id?: string };
    return content.endpoint_id ?? null;
  } catch {
    return null;
  }
}
