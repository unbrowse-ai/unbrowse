import { searchIntent, searchIntentInDomain, recordOrchestrationPerf } from "../client/index.js";
import { publishSkill, getSkill } from "../marketplace/index.js";
import { deriveStructuredDataReplayUrl, executeSkill, rankEndpoints } from "../execution/index.js";
import { getSkillChunk, knownBindingsFromInputs } from "../graph/index.js";
import { getRegistrableDomain } from "../domain.js";
import { mergeContextTemplateParams } from "../template-params.js";
import { writeDebugTrace } from "../debug-trace.js";
import type { ExecutionOptions, ExecutionTrace, OrchestrationTiming, ProjectionOptions, ResponseSchema, SkillManifest } from "../types/index.js";
import { TRACE_VERSION } from "../version.js";
import { nanoid } from "nanoid";
import { assessIntentResult } from "../intent-match.js";

const CONFIDENCE_THRESHOLD = 0.3;
const NEBIUS_API_KEY = process.env.NEBIUS_API_KEY ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const CHAT_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const JUDGE_MODEL = process.env.UNBROWSE_AGENT_JUDGE_MODEL ?? "gpt-4.1-mini";
const LIVE_CAPTURE_TIMEOUT_MS = Number(process.env.UNBROWSE_LIVE_CAPTURE_TIMEOUT_MS ?? "120000");

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
const capturedDomainCache = new Map<string, { skill: SkillManifest; endpointId?: string; expires: number }>();
// In-flight capture queue: concurrent callers for the same domain/scope should wait for
// the same live capture instead of failing fast.
const captureInFlight = new Map<string, Promise<{ learned_skill?: SkillManifest; trace: ExecutionTrace; result: unknown }>>();
// Cross-client profile lock: some sites/profile dirs do not tolerate parallel browser
// launches against the same domain/profile. Serialize live captures per domain.
const captureDomainLocks = new Map<string, Promise<void>>();
// Route cache: intent+domain → skill_id, skips search+getSkill on repeat queries.
const skillRouteCache = new Map<string, { skillId: string; domain: string; endpointId?: string; ts: number }>();
const routeResultCache = new Map<string, {
  skill: SkillManifest;
  endpointId?: string;
  result: unknown;
  trace: ExecutionTrace;
  response_schema?: ResponseSchema;
  extraction_hints?: OrchestratorResult["extraction_hints"];
  expires: number;
}>();
const ROUTE_CACHE_TTL = 5 * 60_000; // 5 minutes

function scopedCacheKey(scope: string, key: string): string {
  return `${scope}:${key}`;
}

function normalizeRouteContext(url?: string): string {
  if (!url) return "root";
  try {
    const parsed = new URL(url);
    const keep = ["q", "query", "keywords", "term", "search", "type", "tab", "f", "sort"];
    const query = new URLSearchParams();
    for (const key of keep) {
      const value = parsed.searchParams.get(key);
      if (value) query.set(key, value);
    }
    const queryText = query.toString();
    return `${parsed.origin}${parsed.pathname}${queryText ? `?${queryText}` : ""}`;
  } catch {
    return url;
  }
}

export function buildResolveCacheKey(domain: string | null, intent: string, url?: string): string {
  return `${domain || "global"}:${intent.trim().toLowerCase()}:${normalizeRouteContext(url)}`;
}

function promoteLearnedSkill(scope: string, cacheKey: string, skill: SkillManifest, endpointId?: string): void {
  capturedDomainCache.set(cacheKey, { skill, endpointId, expires: Date.now() + 5 * 60_000 });
  skillRouteCache.set(cacheKey, { skillId: skill.skill_id, domain: skill.domain, endpointId, ts: Date.now() });
}

function promoteResultSnapshot(
  cacheKey: string,
  skill: SkillManifest,
  endpointId: string | undefined,
  result: unknown,
  trace: ExecutionTrace,
  response_schema?: ResponseSchema,
  extraction_hints?: OrchestratorResult["extraction_hints"],
): void {
  routeResultCache.set(cacheKey, {
    skill,
    endpointId,
    result,
    trace,
    response_schema,
    extraction_hints,
    expires: Date.now() + ROUTE_CACHE_TTL,
  });
}

export function promoteExplicitExecution(
  scope: string,
  intent: string | undefined,
  contextUrl: string | undefined,
  skill: SkillManifest,
  endpointId: string | undefined,
  result: unknown,
): boolean {
  if (!intent || !contextUrl) return false;
  const assessment = assessIntentResult(result, intent);
  if (assessment.verdict === "fail") return false;
  const cacheKey = buildResolveCacheKey(skill.domain, intent, contextUrl);
  promoteLearnedSkill(scope, cacheKey, skill, endpointId);
  return true;
}

export function shouldBypassLiveCaptureQueue(url?: string): boolean {
  if (!url) return false;
  return deriveStructuredDataReplayUrl(url) !== url;
}

async function withDomainCaptureLock<T>(domain: string, fn: () => Promise<T>): Promise<T> {
  const prev = captureDomainLocks.get(domain);
  if (prev) {
    try { await prev; } catch { /* previous capture failure shouldn't poison next */ }
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  captureDomainLocks.set(domain, gate);
  try {
    return await fn();
  } finally {
    release();
    if (captureDomainLocks.get(domain) === gate) captureDomainLocks.delete(domain);
  }
}

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

type RankedCandidate = { endpoint: SkillManifest["endpoints"][number]; score: number };

function prefersEndpoint(a: RankedCandidate, b: RankedCandidate): RankedCandidate {
  const aBundle = /inferred from js bundle/i.test(a.endpoint.description ?? "");
  const bBundle = /inferred from js bundle/i.test(b.endpoint.description ?? "");
  if (aBundle !== bBundle) return aBundle ? b : a;
  const aSchema = !!a.endpoint.response_schema;
  const bSchema = !!b.endpoint.response_schema;
  if (aSchema !== bSchema) return aSchema ? a : b;
  return a.score >= b.score ? a : b;
}

function dedupeObservedOverBundle(ranked: RankedCandidate[]): RankedCandidate[] {
  const byRoute = new Map<string, RankedCandidate>();
  for (const candidate of ranked) {
    let key = `${candidate.endpoint.method}:${candidate.endpoint.url_template}`;
    try {
      const url = new URL(candidate.endpoint.url_template);
      key = `${candidate.endpoint.method}:${url.origin}${url.pathname}`;
    } catch { /* keep raw key */ }
    const existing = byRoute.get(key);
    byRoute.set(key, existing ? prefersEndpoint(existing, candidate) : candidate);
  }
  return Array.from(byRoute.values()).sort((a, b) => b.score - a.score);
}

function extractBinaryVerdict(payload: Record<string, unknown>): "pass" | "fail" | "skip" {
  for (const value of Object.values(payload)) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === "pass" || normalized.startsWith("pass ")) return "pass";
    if (normalized === "fail" || normalized.startsWith("fail ")) return "fail";
    if (normalized.includes("\"pass\"")) return "pass";
    if (normalized.includes("\"fail\"")) return "fail";
  }
  return "skip";
}

function obviousSemanticMismatch(
  intent: string,
  endpoint: SkillManifest["endpoints"][number],
  result: unknown,
): boolean {
  const haystack = `${intent} ${endpoint.url_template} ${endpoint.description ?? ""}`.toLowerCase();
  const wantsChannels = /\b(channel|channels|guild|guilds|message|messages|thread|threads|dm|chat)\b/.test(intent.toLowerCase());
  const resultKeys = result && typeof result === "object" ? Object.keys(result as Record<string, unknown>).join(" ").toLowerCase() : "";
  if (wantsChannels) {
    if (/\b(experiment|experiments|promotion|promotions|affinit|fingerprint|assignment|config|status)\b/.test(haystack)) return true;
    if (/\b(guild_experiments|guild_affinities|fingerprint|assignments)\b/.test(resultKeys)) return true;
  }
  const wantsPosts = /\b(post|posts|tweet|tweets|status|statuses|timeline|feed)\b/.test(intent.toLowerCase());
  if (wantsPosts && result && typeof result === "object") {
    const keys = JSON.stringify(result).toLowerCase();
    if (/\b(accounts|users|profiles)\b/.test(keys) && !/\b(statuses|posts|tweets)\b/.test(keys)) return true;
  }
  return false;
}

function inferDefaultParam(paramName: string, intent: string): string | number | boolean | undefined {
  const name = paramName.toLowerCase();
  const intentLower = intent.toLowerCase();
  if (name === "limit" || name === "count" || name === "per_page" || name === "page_size") return 20;
  if (name === "page") return 1;
  if (name === "offset") return 0;
  if (name === "resolve") {
    if (/\b(post|posts|tweet|tweets|status|statuses)\b/.test(intentLower)) return false;
    return true;
  }
  if (name === "type") {
    if (/\b(post|posts|status|statuses|tweet|tweets)\b/.test(intentLower)) return "statuses";
    if (/\b(repo|repository|repositories)\b/.test(intentLower)) return "repositories";
    if (/\b(person|people|profile|profiles|member|members)\b/.test(intentLower)) return "accounts";
  }
  return undefined;
}

async function callJsonAgent<T>(system: string, user: string, fallback: T): Promise<T> {
  const providers = [
    OPENAI_API_KEY
      ? { url: OPENAI_CHAT_URL, key: OPENAI_API_KEY, model: JUDGE_MODEL }
      : null,
    NEBIUS_API_KEY
      ? { url: CHAT_URL, key: NEBIUS_API_KEY, model: JUDGE_MODEL }
      : null,
  ].filter((p): p is { url: string; key: string; model: string } => !!p);
  if (providers.length === 0) return fallback;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    for (const provider of providers) {
      const res = await fetch(provider.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${provider.key}`,
        },
        body: JSON.stringify({
          model: provider.model,
          temperature: 0,
          max_tokens: 400,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content;
      if (!content) continue;
      return JSON.parse(content) as T;
    }
    return fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

async function withOpTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  return await Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label}_timeout:${ms}`)), ms)),
  ]);
}

function inferPreferredEntityTokens(intent: string): string[] {
  const lower = intent.toLowerCase();
  if (/\b(post|posts|tweet|tweets|status|statuses)\b/.test(lower)) return ["statuses", "posts", "tweets", "timeline"];
  if (/\b(person|people|profile|profiles|member|members|user|users)\b/.test(lower)) {
    return ["accounts", "user", "users", "profile", "profiles", "person", "people", "member", "members", "screen_name", "userbyscreenname"];
  }
  if (/\b(company|companies|organization|organisations|business|org)\b/.test(lower)) return ["company", "companies", "organization", "business", "org"];
  if (/\b(repo|repos|repository|repositories)\b/.test(lower)) return ["repositories", "repository", "repo"];
  if (/\b(topic|topics|trend|trends|hashtag|hashtags)\b/.test(lower)) return ["trends", "trend", "topic", "topics", "hashtag"];
  return [];
}

function isAcceptableIntentResult(result: unknown, intent: string): boolean {
  return assessIntentResult(result, intent).verdict !== "fail";
}

function candidateMatchesPreferredEntity(candidate: RankedCandidate, preferredTokens: string[]): boolean {
  if (preferredTokens.length === 0) return false;
  if (candidate.endpoint.dom_extraction || candidate.endpoint.method === "WS") return false;
  if (/inferred from js bundle/i.test(candidate.endpoint.description ?? "")) return false;
  const haystack = [
    candidate.endpoint.url_template,
    candidate.endpoint.description ?? "",
    JSON.stringify(candidate.endpoint.response_schema ?? {}),
  ].join(" ").toLowerCase();
  return preferredTokens.some((token) => haystack.includes(token.toLowerCase()));
}

function isDocumentLikeCandidate(candidate: RankedCandidate, contextUrl?: string): boolean {
  if (/captured page artifact/i.test(candidate.endpoint.description ?? "")) return true;
  if (candidate.endpoint.dom_extraction || candidate.endpoint.method === "WS") return false;
  try {
    const endpointUrl = new URL(candidate.endpoint.url_template);
    if (/\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(endpointUrl.pathname)) return false;
    if (!contextUrl) return false;
    const contextPage = new URL(contextUrl);
    return endpointUrl.origin === contextPage.origin && endpointUrl.pathname === contextPage.pathname;
  } catch {
    return /captured page artifact/i.test(candidate.endpoint.description ?? "");
  }
}

function isConcreteEntityDetailIntent(intent: string, contextUrl?: string): boolean {
  if (!/\b(get|fetch|view)\b/i.test(intent)) return false;
  if (!/\b(company|companies|organization|organisations|business|org|person|people|profile|profiles|member|members|user|users)\b/i.test(intent)) return false;
  if (!contextUrl) return false;
  try {
    const leaf = decodeURIComponent(new URL(contextUrl).pathname.split("/").filter(Boolean).pop() ?? "").toLowerCase();
    return !!leaf && !/^(search|explore|trending|tabs|home|for-you|foryou|latest|live|people|posts|videos)$/.test(leaf);
  } catch {
    return false;
  }
}

function prioritizeIntentMatchedApis(ranked: RankedCandidate[], intent: string, contextUrl?: string): RankedCandidate[] {
  const preferred = inferPreferredEntityTokens(intent);
  if (preferred.length === 0) return ranked;
  const preferredApis = ranked.filter((candidate) => candidateMatchesPreferredEntity(candidate, preferred));
  if (preferredApis.length === 0) return ranked;
  const preferredIds = new Set(preferredApis.map((candidate) => candidate.endpoint.endpoint_id));
  return [
    ...preferredApis.sort((a, b) => {
      const aDoc = isDocumentLikeCandidate(a, contextUrl);
      const bDoc = isDocumentLikeCandidate(b, contextUrl);
      if (aDoc !== bDoc) return aDoc ? 1 : -1;
      return b.score - a.score;
    }),
    ...ranked.filter((candidate) => !preferredIds.has(candidate.endpoint.endpoint_id)),
  ];
}

async function agentSelectEndpoint(
  intent: string,
  skill: SkillManifest,
  ranked: RankedCandidate[],
  contextUrl?: string,
): Promise<string[] | null> {
  const topRanked = ranked.slice(0, 5);
  const preferred = inferPreferredEntityTokens(intent);
  const concreteEntityIntent = isConcreteEntityDetailIntent(intent, contextUrl);
  const hasObservedCandidate = topRanked.some(
    (r) => !/inferred from js bundle/i.test(r.endpoint.description ?? "")
  );
  const narrowedBase = hasObservedCandidate
    ? topRanked.filter((r) => !/inferred from js bundle/i.test(r.endpoint.description ?? ""))
    : topRanked;
  const hasPreferredObservedApi = concreteEntityIntent && preferred.length > 0 && narrowedBase.some(
    (candidate) => candidateMatchesPreferredEntity(candidate, preferred) && !isDocumentLikeCandidate(candidate, contextUrl)
  );
  const narrowed = hasPreferredObservedApi
    ? narrowedBase.filter((candidate) => !isDocumentLikeCandidate(candidate, contextUrl))
    : narrowedBase;
  const top = narrowed.map((r) => ({
    endpoint_id: r.endpoint.endpoint_id,
    method: r.endpoint.method,
    url: r.endpoint.url_template,
    description: r.endpoint.description ?? "",
    score: Math.round(r.score * 10) / 10,
    schema: r.endpoint.response_schema ? summarizeSchema(r.endpoint.response_schema) : null,
    dom_extraction: !!r.endpoint.dom_extraction,
    trigger_url: r.endpoint.trigger_url ?? null,
  }));
  const fallback = { ordered_endpoint_ids: top.map((r) => r.endpoint_id) };
  const judged = await callJsonAgent<{ ordered_endpoint_ids?: string[]; endpoint_ids?: string[]; ids?: string[] }>(
    "You pick the best endpoint(s) for a website task. Return JSON only.",
    JSON.stringify({
      task: "rank_endpoints_for_execution",
      intent,
      domain: skill.domain,
      context_url: contextUrl ?? null,
      endpoints: top,
      rules: [
        "Prefer endpoints that directly satisfy the intent, not adjacent metadata.",
        "Prefer final user-visible data over experiments, config, telemetry, auth, status, or affinity endpoints.",
        "If the intent asks for channels/messages/people/documents/listings, reject endpoints that return unrelated experiments or scores.",
        "Return ordered_endpoint_ids best-first. Do not invent ids.",
      ],
    }),
    fallback,
  );
  const orderedRaw = judged.ordered_endpoint_ids ?? judged.endpoint_ids ?? judged.ids ?? [];
  const ordered = orderedRaw.filter((id) => top.some((r) => r.endpoint_id === id));
  return ordered.length > 0 ? ordered : fallback.ordered_endpoint_ids;
}

async function agentJudgeExecution(
  intent: string,
  endpoint: SkillManifest["endpoints"][number],
  result: unknown,
): Promise<"pass" | "fail" | "skip"> {
  if (obviousSemanticMismatch(intent, endpoint, result)) return "fail";
  const verdict = await callJsonAgent<{ verdict?: "pass" | "fail"; result?: "pass" | "fail"; judgment?: "pass" | "fail" }>(
    "You judge whether returned data satisfies a web data intent. Return JSON only.",
    JSON.stringify({
      task: "judge_endpoint_result",
      intent,
      endpoint: {
        endpoint_id: endpoint.endpoint_id,
        method: endpoint.method,
        url: endpoint.url_template,
        description: endpoint.description ?? "",
      },
      result,
      rules: [
        "pass only if the returned data directly answers the intent",
        "fail if the data is empty, unrelated, config, experiment, telemetry, status, auth/session, or only a weak proxy",
        "for list/search intents, wrong entity type is fail",
      ],
    }),
    { verdict: "skip" as const },
  );
  return verdict.verdict ?? verdict.result ?? verdict.judgment ?? extractBinaryVerdict(verdict);
}

export function resolveEndpointTemplateBindings(
  endpoint: SkillManifest["endpoints"][number],
  params: Record<string, unknown> = {},
  contextUrl?: string,
): Record<string, unknown> {
  const merged = mergeContextTemplateParams(params, endpoint.url_template, contextUrl);
  for (const [key, value] of Object.entries(endpoint.path_params ?? {})) {
    if (merged[key] == null || merged[key] === "") merged[key] = value;
  }
  for (const [key, value] of Object.entries(endpoint.query ?? {})) {
    if (merged[key] == null || merged[key] === "") merged[key] = value;
  }
  const semanticExample = endpoint.semantic?.example_request;
  if (semanticExample && typeof semanticExample === "object") {
    for (const [key, value] of Object.entries(semanticExample)) {
      if (merged[key] == null || merged[key] === "") merged[key] = value;
    }
  }
  return merged;
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
  const decisionTrace: Record<string, unknown> = {
    intent,
    params,
    context,
    search_candidates: [] as unknown[],
    autoexec_attempts: [] as unknown[],
  };

  // Fallback baselines when a skill has no discovery_cost (old skills / first capture)
  const DEFAULT_CAPTURE_MS = 22_000;
  const DEFAULT_CAPTURE_TOKENS = 30_000;
  const CHARS_PER_TOKEN = 4;

  // When the agent explicitly passes endpoint_id, execute directly — they already chose.
  const agentChoseEndpoint = !!params.endpoint_id;

  const forceCapture = !!options?.force_capture;
  const clientScope = options?.client_scope ?? "global";
  // force_capture: clear domain caches so we go straight to browser capture
  if (forceCapture && context?.url) {
    const d = new URL(context.url).hostname;
    for (const [k] of capturedDomainCache) {
      if (k.startsWith(`${clientScope}:`) && k.includes(`:${d}:`)) capturedDomainCache.delete(k);
    }
    for (const [k] of skillRouteCache) {
      if (k.startsWith(`${clientScope}:`) && k.includes(`:${d}:`)) skillRouteCache.delete(k);
    }
    for (const [k] of routeResultCache) {
      if (k.startsWith(`${clientScope}:`) && k.includes(`:${d}:`)) routeResultCache.delete(k);
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
    const chunk = getSkillChunk(skill, {
      intent,
      known_bindings: knownBindingsFromInputs(params, context?.url),
      max_operations: 8,
    });
    const epRanked = rankEndpoints(skill.endpoints, intent, skill.domain, context?.url);
    const deferTrace: ExecutionTrace = {
      trace_id: nanoid(),
      skill_id: skill.skill_id,
      endpoint_id: "",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: true,
    };
    writeDebugTrace("resolve", {
      ...decisionTrace,
      outcome: "deferral",
      source,
      skill_id: skill.skill_id,
      available_endpoints: epRanked.slice(0, 10).map((r) => ({
        endpoint_id: r.endpoint.endpoint_id,
        score: Math.round(r.score * 10) / 10,
        description: r.endpoint.description,
        url: r.endpoint.url_template,
      })),
      extra: extraFields ?? null,
    });
    return {
      result: {
        message: `Found ${epRanked.length} endpoint(s). Pick one and call POST /v1/skills/${skill.skill_id}/execute with params.endpoint_id.`,
        skill_id: skill.skill_id,
        available_operations: chunk.operations.map((operation) => ({
          operation_id: operation.operation_id,
          endpoint_id: operation.endpoint_id,
          action_kind: operation.action_kind,
          resource_kind: operation.resource_kind,
          description_out: operation.description_out,
          requires: operation.requires.map((binding) => binding.key),
          provides: operation.provides.map((binding) => binding.key),
          runnable: chunk.available_operation_ids.includes(operation.operation_id),
        })),
        missing_bindings: chunk.missing_bindings,
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

  function missingTemplateParams(
    endpoint: SkillManifest["endpoints"][number],
    boundParams: Record<string, unknown>,
  ): string[] {
    const urlTemplate = endpoint.url_template;
    const required = [...urlTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    return required.filter((name) => {
      const value = boundParams[name];
      return value == null || value === "";
    });
  }

  function canAutoExecuteEndpoint(endpoint: SkillManifest["endpoints"][number]): boolean {
    const endpointParams = resolveEndpointTemplateBindings(endpoint, resolvedParams, context?.url);
    const missing = missingTemplateParams(endpoint, endpointParams);
    if (missing.some((name) => inferDefaultParam(name, intent) === undefined)) return false;
    if (endpoint.dom_extraction) return true;
    return endpoint.method === "GET" || endpoint.idempotency === "safe";
  }

  const resolvedParams: Record<string, unknown> = (() => {
    const merged: Record<string, unknown> = { ...params };
    if (context?.url) {
      try {
        const u = new URL(context.url);
        for (const [k, v] of u.searchParams.entries()) {
          if (merged[k] == null || merged[k] === "") merged[k] = v;
        }
      } catch { /* ignore */ }
    }
    return merged;
  })();

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
    const originalRanked = epRanked;
    const chunk = getSkillChunk(skill, {
      intent,
      known_bindings: knownBindingsFromInputs(resolvedParams, context?.url),
      max_operations: 8,
    });
    const graphEndpointIds = new Set(
      (chunk.available_operation_ids.length > 0
        ? chunk.available_operation_ids
        : chunk.operations.map((operation) => operation.operation_id))
    );
    if (graphEndpointIds.size > 0) {
      epRanked = epRanked.filter((ranked) => graphEndpointIds.has(ranked.endpoint.endpoint_id));
      const hasObservedAfterFilter = epRanked.some(
        (ranked) => !/inferred from js bundle/i.test(ranked.endpoint.description ?? "")
      );
      const observedBeforeFilter = originalRanked.filter(
        (ranked) => !/inferred from js bundle/i.test(ranked.endpoint.description ?? "")
      );
      if (!hasObservedAfterFilter && observedBeforeFilter.length > 0) {
        epRanked = dedupeObservedOverBundle([...observedBeforeFilter, ...epRanked]);
      }
    }
    if (epRanked.length === 0) return null;
    decisionTrace.search_candidates = epRanked.slice(0, 10).map((ranked) => ({
      endpoint_id: ranked.endpoint.endpoint_id,
      score: Math.round(ranked.score * 10) / 10,
      description: ranked.endpoint.description,
      url: ranked.endpoint.url_template,
      dom_extraction: !!ranked.endpoint.dom_extraction,
    }));

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
    epRanked = dedupeObservedOverBundle(epRanked);

    const hasInternalApiCandidate = epRanked.some((r) => !r.endpoint.dom_extraction && r.endpoint.method !== "WS");
    const hasObservedApiCandidate = epRanked.some((r) =>
      !r.endpoint.dom_extraction &&
      r.endpoint.method !== "WS" &&
      !/inferred from js bundle/i.test(r.endpoint.description ?? "")
    );
    epRanked = epRanked.map((r) => {
      let readinessBonus = 0;
      const inferredFromBundle = /inferred from js bundle/i.test(r.endpoint.description ?? "");
      let isDocumentRoute = false;
      if (!r.endpoint.dom_extraction && context?.url) {
        try {
          const endpointUrl = new URL(r.endpoint.url_template);
          const contextPage = new URL(context.url);
          isDocumentRoute =
            endpointUrl.origin === contextPage.origin &&
            endpointUrl.pathname === contextPage.pathname &&
            !/\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(endpointUrl.pathname);
        } catch { /* ignore */ }
      }
      const endpointBindings = resolveEndpointTemplateBindings(r.endpoint, resolvedParams, context?.url);
      const missing = missingTemplateParams(r.endpoint, endpointBindings);
      if (missing.length === 0) readinessBonus += 40;
      else {
        const satisfiable = missing.every((name) => inferDefaultParam(name, intent) !== undefined);
        readinessBonus += satisfiable ? 8 : -(missing.length * 25);
      }
      if (r.endpoint.method === "GET" || r.endpoint.idempotency === "safe") readinessBonus += 15;
      if (r.endpoint.response_schema || r.endpoint.dom_extraction) readinessBonus += 10;
      if (!r.endpoint.dom_extraction && r.endpoint.method !== "WS") readinessBonus += 20;
      if (inferredFromBundle) readinessBonus -= 20;
      if (hasObservedApiCandidate && inferredFromBundle) readinessBonus -= 45;
      if (hasInternalApiCandidate && r.endpoint.dom_extraction) readinessBonus -= 35;
      if (hasInternalApiCandidate && isDocumentRoute) readinessBonus -= 80;
      if (r.endpoint.trigger_url && context?.url) {
        try {
          if (new URL(r.endpoint.trigger_url).pathname === new URL(context.url).pathname) readinessBonus += 5;
        } catch { /* ignore */ }
      }
      return { ...r, score: r.score + readinessBonus };
    });
    epRanked.sort((a, b) => b.score - a.score);
    epRanked = prioritizeIntentMatchedApis(epRanked, intent, context?.url);

    // Try top candidates in order until one succeeds. If all fail, fall through to deferral.
    const ready = epRanked.filter((r) => canAutoExecuteEndpoint(r.endpoint));
    const tryList = ready.length > 0
      ? [...ready, ...epRanked.filter((r) => !canAutoExecuteEndpoint(r.endpoint))]
      : epRanked;
    const MAX_TRIES = Math.min(tryList.length, 5);
    const agentOrder = !agentChoseEndpoint && tryList.length > 1
      ? await agentSelectEndpoint(intent, skill, tryList.slice(0, MAX_TRIES), context?.url)
      : null;
    const orderedTryList = agentOrder
      ? [
          ...agentOrder
            .map((endpointId) => tryList.find((r) => r.endpoint.endpoint_id === endpointId))
            .filter((r): r is RankedCandidate => !!r),
          ...tryList.filter((r) => !agentOrder.includes(r.endpoint.endpoint_id)),
        ]
      : tryList;
    const te0 = Date.now();
    for (let i = 0; i < MAX_TRIES; i++) {
      const candidate = orderedTryList[i];
      timing.candidates_tried = i + 1;
      console.log(`[auto-exec] trying #${i + 1}: ${candidate.endpoint.endpoint_id} score=${candidate.score.toFixed(1)}`);
      try {
        const endpointParams = mergeContextTemplateParams(resolvedParams, candidate.endpoint.url_template, context?.url);
        const inferredOptionalParams: Record<string, string | number | boolean> = {};
        const inferredType = inferDefaultParam("type", intent);
        if (
          inferredType !== undefined &&
          endpointParams.type == null &&
          /\/(search|lookup|find)\b/i.test(candidate.endpoint.url_template)
        ) {
          inferredOptionalParams.type = inferredType;
        }
        const execOut = await executeSkill(
          skill,
          {
            ...endpointParams,
            ...Object.fromEntries(
              [...candidate.endpoint.url_template.matchAll(/\{([^}]+)\}/g)]
                .map((m) => m[1])
                .filter((name) => endpointParams[name] == null || endpointParams[name] === "")
                .map((name) => [name, inferDefaultParam(name, intent)])
                .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
            ),
            ...inferredOptionalParams,
            endpoint_id: candidate.endpoint.endpoint_id,
          },
          projection,
          { ...options, intent, contextUrl: context?.url }
        );
        timing.execute_ms = Date.now() - te0;
        if (execOut.trace.success) {
          const localAssessment = assessIntentResult(execOut.result, intent);
          if (localAssessment.verdict === "fail") {
            (decisionTrace.autoexec_attempts as unknown[]).push({
              endpoint_id: candidate.endpoint.endpoint_id,
              score: Math.round(candidate.score * 10) / 10,
              trace_success: true,
              judge: "fail",
              status_code: execOut.trace.status_code ?? null,
              local_reason: localAssessment.reason,
            });
            console.log(`[auto-exec] #${i + 1} local fail: ${candidate.endpoint.endpoint_id} (${localAssessment.reason})`);
            continue;
          }
          const judged = localAssessment.verdict === "pass"
            ? "pass"
            : await agentJudgeExecution(intent, candidate.endpoint, execOut.result);
          (decisionTrace.autoexec_attempts as unknown[]).push({
            endpoint_id: candidate.endpoint.endpoint_id,
            score: Math.round(candidate.score * 10) / 10,
            trace_success: true,
            judge: judged,
            status_code: execOut.trace.status_code ?? null,
            local_reason: localAssessment.reason,
          });
          if (judged !== "pass") {
            console.log(`[auto-exec] #${i + 1} rejected: ${candidate.endpoint.endpoint_id} (${judged})`);
            continue;
          }
          skillRouteCache.set(cacheKey, { skillId: skill.skill_id, domain: skill.domain, ts: Date.now() });
          writeDebugTrace("resolve", {
            ...decisionTrace,
            outcome: "autoexec_success",
            source,
            skill_id: skill.skill_id,
            selected_endpoint_id: candidate.endpoint.endpoint_id,
          });
          promoteResultSnapshot(
            cacheKey,
            skill,
            candidate.endpoint.endpoint_id,
            execOut.result,
            execOut.trace,
            execOut.response_schema,
            execOut.extraction_hints,
          );
          return {
            result: execOut.result, trace: execOut.trace, source, skill,
            timing: finalize(source, execOut.result, skill.skill_id, skill, execOut.trace),
            response_schema: execOut.response_schema,
            extraction_hints: execOut.extraction_hints,
          };
        }
        (decisionTrace.autoexec_attempts as unknown[]).push({
          endpoint_id: candidate.endpoint.endpoint_id,
          score: Math.round(candidate.score * 10) / 10,
          trace_success: false,
          judge: "skip",
          status_code: execOut.trace.status_code ?? null,
          error: execOut.trace.error ?? null,
        });
        console.log(`[auto-exec] #${i + 1} failed: status=${execOut.trace.status_code}`);
      } catch (err) {
        (decisionTrace.autoexec_attempts as unknown[]).push({
          endpoint_id: candidate.endpoint.endpoint_id,
          score: Math.round(candidate.score * 10) / 10,
          trace_success: false,
          judge: "skip",
          error: (err as Error).message,
        });
        console.log(`[auto-exec] #${i + 1} error: ${(err as Error).message}`);
      }
    }
    timing.execute_ms = Date.now() - te0;
    writeDebugTrace("resolve", {
      ...decisionTrace,
      outcome: "autoexec_failed_all",
      source,
      skill_id: skill.skill_id,
    });
    return null; // All candidates failed, fall through to deferral
  }

  const requestedDomain = context?.domain ?? (context?.url ? new URL(context.url).hostname : null);
  const cacheKey = scopedCacheKey(clientScope, buildResolveCacheKey(requestedDomain, intent, context?.url));

  if (!forceCapture && !agentChoseEndpoint) {
    const cachedResult = routeResultCache.get(cacheKey);
    if (cachedResult) {
      if (cachedResult.expires <= Date.now() || !isAcceptableIntentResult(cachedResult.result, intent)) {
        routeResultCache.delete(cacheKey);
      } else {
        timing.cache_hit = true;
        const now = new Date().toISOString();
        const trace: ExecutionTrace = {
          ...cachedResult.trace,
          trace_id: nanoid(),
          started_at: now,
          completed_at: now,
        };
        return {
          result: cachedResult.result,
          trace,
          source: "marketplace",
          skill: cachedResult.skill,
          timing: finalize("route-cache", cachedResult.result, cachedResult.skill.skill_id, cachedResult.skill, trace),
          response_schema: cachedResult.response_schema,
          extraction_hints: cachedResult.extraction_hints,
        };
      }
    }
  }

  // Route-cache fast path for normal resolve. If the same intent/domain was solved recently,
  // try that skill first before marketplace search.
  if (!forceCapture && !agentChoseEndpoint) {
    const cached = skillRouteCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ROUTE_CACHE_TTL) {
      const skill = await getSkill(cached.skillId, clientScope);
      if (skill) {
        timing.cache_hit = true;
        let staleCachedEndpoint = false;
        if (cached.endpointId && !agentChoseEndpoint) {
          const execOut = await executeSkill(
            skill,
            { ...resolvedParams, endpoint_id: cached.endpointId },
            projection,
            { ...options, intent, contextUrl: context?.url }
          );
          if (execOut.trace.success && isAcceptableIntentResult(execOut.result, intent)) {
            promoteResultSnapshot(
              cacheKey,
              skill,
              cached.endpointId,
              execOut.result,
              execOut.trace,
              execOut.response_schema,
              execOut.extraction_hints,
            );
            return {
              result: execOut.result,
              trace: execOut.trace,
              source: "marketplace",
              skill,
              timing: finalize("route-cache", execOut.result, cached.skillId, skill, execOut.trace),
              response_schema: execOut.response_schema,
              extraction_hints: execOut.extraction_hints,
            };
          }
          staleCachedEndpoint = true;
        }
        const autoResult = await tryAutoExecute(skill, "marketplace");
        if (autoResult) return autoResult;
        if (!staleCachedEndpoint && !context?.url) return buildDeferral(skill, "marketplace");
        staleCachedEndpoint = true;
      }
      skillRouteCache.delete(cacheKey);
    }
  }

  // --- Agent explicitly chose an endpoint — execute directly via any cache/skill path ---
  if (!forceCapture && agentChoseEndpoint) {
    // Route cache
    const cached = skillRouteCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ROUTE_CACHE_TTL) {
      const skill = await getSkill(cached.skillId, clientScope);
      if (skill) {
        const te0 = Date.now();
        try {
          const execOut = await executeSkill(
            skill,
            { ...params, endpoint_id: params.endpoint_id ?? cached.endpointId },
            projection,
            { ...options, intent, contextUrl: context?.url }
          );
          timing.execute_ms = Date.now() - te0;
          if (execOut.trace.success && isAcceptableIntentResult(execOut.result, intent)) {
            timing.cache_hit = true;
            return { result: execOut.result, trace: execOut.trace, source: "marketplace", skill, timing: finalize("route-cache", execOut.result, cached.skillId, skill, execOut.trace), response_schema: execOut.response_schema, extraction_hints: execOut.extraction_hints };
          }
        } catch { timing.execute_ms = Date.now() - te0; }
      }
      skillRouteCache.delete(cacheKey);
    }
  }

  // No disk-snapshot reads in the default resolve path.
  // Remote/shared skills are the source of truth; local snapshots stay explicit debug/test only.

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
      const skill = await getSkill(skillId, clientScope);
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
        skillRouteCache.set(cacheKey, { skillId: winner.candidate.skill.skill_id, domain: winner.candidate.skill.domain, endpointId: winner.trace.endpoint_id, ts: Date.now() });
        return { result: winner.result, trace: winner.trace, source: "marketplace" as const, skill: winner.candidate.skill, timing: finalize("marketplace", winner.result, winner.candidate.skill.skill_id, winner.candidate.skill, winner.trace), response_schema: winner.response_schema, extraction_hints: winner.extraction_hints };
      } catch (err) {
        console.log(`[race] all candidates failed after ${Date.now() - te0}ms: ${(err as Error).message}`);
        timing.execute_ms = Date.now() - te0;
      }
    } else {
      const best = viable[0];
      // Endpoint-level search hits are only hints. The agent still chooses/judges inside tryAutoExecute.
      if (best.endpointId) {
        console.log(`[search] endpoint-level hit hint: ${best.endpointId} score=${best.candidate.score.toFixed(3)}`);
      }
      // Fallback: try BM25 auto-execute across viable skills, then deferral
      const triedSkills = new Set<string>();
      for (const candidate of viable) {
        if (triedSkills.has(candidate.skill.skill_id)) continue;
        triedSkills.add(candidate.skill.skill_id);
        const autoResult = await tryAutoExecute(candidate.skill, "marketplace");
        if (autoResult) return autoResult;
      }
      if (!context?.url) {
        return buildDeferral(best.skill, "marketplace");
      }
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
  const domainHit = !forceCapture ? capturedDomainCache.get(cacheKey) : undefined;
  if (domainHit && Date.now() < domainHit.expires) {
    timing.cache_hit = true;
    let staleCachedEndpoint = false;
    if (agentChoseEndpoint) {
      const execOut = await executeSkill(domainHit.skill, { ...params, endpoint_id: params.endpoint_id ?? domainHit.endpointId }, projection, { ...options, intent, contextUrl: context?.url });
    if (execOut.trace.success && isAcceptableIntentResult(execOut.result, intent)) {
      promoteResultSnapshot(
        cacheKey,
        domainHit.skill,
        domainHit.endpointId,
        execOut.result,
        execOut.trace,
        execOut.response_schema,
        execOut.extraction_hints,
      );
      return { result: execOut.result, trace: execOut.trace, source: "marketplace", skill: domainHit.skill, timing: finalize("marketplace", execOut.result, domainHit.skill.skill_id, domainHit.skill, execOut.trace), response_schema: execOut.response_schema, extraction_hints: execOut.extraction_hints };
    }
      staleCachedEndpoint = true;
    }
    if (domainHit.endpointId) {
      const execOut = await executeSkill(
        domainHit.skill,
        { ...resolvedParams, endpoint_id: domainHit.endpointId },
        projection,
        { ...options, intent, contextUrl: context?.url }
      );
      if (execOut.trace.success && isAcceptableIntentResult(execOut.result, intent)) {
        return {
          result: execOut.result,
          trace: execOut.trace,
          source: "marketplace",
          skill: domainHit.skill,
          timing: finalize("marketplace", execOut.result, domainHit.skill.skill_id, domainHit.skill, execOut.trace),
          response_schema: execOut.response_schema,
          extraction_hints: execOut.extraction_hints,
        };
      }
      staleCachedEndpoint = true;
    }
    const autoResult = await tryAutoExecute(domainHit.skill, "marketplace");
    if (autoResult) return autoResult;
    if (!staleCachedEndpoint && !context?.url) return buildDeferral(domainHit.skill, "marketplace");
    staleCachedEndpoint = true;
    capturedDomainCache.delete(cacheKey);
  }

  // In-flight capture queue: wait for the same domain capture instead of failing.
  const bypassLiveCaptureQueue = shouldBypassLiveCaptureQueue(context?.url);
  const captureLockKey = scopedCacheKey(clientScope, captureDomain);
  if (!bypassLiveCaptureQueue) {
    const existingCapture = captureInFlight.get(captureLockKey);
    if (existingCapture) {
      const waited = await withOpTimeout("live_capture_wait", LIVE_CAPTURE_TIMEOUT_MS, existingCapture);
      trace = waited.trace;
      result = waited.result;
      learned_skill = waited.learned_skill;
      timing.execute_ms = 0;
      if (!learned_skill && !trace.success) {
        return { result, trace, source: "live-capture", skill: await getOrCreateBrowserCaptureSkill(), timing: finalize("live-capture", result, undefined, undefined, trace) };
      }
      if (learned_skill) {
        const autoResult = await tryAutoExecute(learned_skill, "live-capture");
        if (autoResult) {
          promoteLearnedSkill(clientScope, cacheKey, learned_skill, autoResult.trace.endpoint_id);
          autoResult.timing.cache_hit = true;
          return autoResult;
        }
        const captureResult = result as Record<string, unknown> | null;
        const authRecommended = captureResult?.auth_recommended === true;
        const deferred = buildDeferral(learned_skill, "live-capture", authRecommended ? {
          auth_recommended: true,
          auth_hint: captureResult!.auth_hint,
        } : undefined);
        deferred.timing.cache_hit = true;
        return deferred;
      }
    }
  }

  let learned_skill: SkillManifest | undefined;
  let trace: import("../types/index.js").ExecutionTrace;
  let result: unknown;
  let captureSkill: SkillManifest;
  const te0 = Date.now();
  if (bypassLiveCaptureQueue) {
    captureSkill = await getOrCreateBrowserCaptureSkill();
    const out = await withOpTimeout(
      "live_capture_execute",
      LIVE_CAPTURE_TIMEOUT_MS,
      executeSkill(captureSkill, { ...params, url: context.url, intent }),
    );
    trace = out.trace;
    result = out.result;
    learned_skill = out.learned_skill;
  } else {
    const capturePromise = withDomainCaptureLock(captureDomain, async () => {
      const captureSkill = await getOrCreateBrowserCaptureSkill();
      const out = await withOpTimeout(
        "live_capture_execute",
        LIVE_CAPTURE_TIMEOUT_MS,
        executeSkill(captureSkill, { ...params, url: context.url, intent }),
      );
      return {
        trace: out.trace,
        result: out.result,
        learned_skill: out.learned_skill,
      };
    });
    captureInFlight.set(captureLockKey, capturePromise);
    try {
      captureSkill = await getOrCreateBrowserCaptureSkill();
      const out = await capturePromise;
      trace = out.trace;
      result = out.result;
      learned_skill = out.learned_skill;
    } finally {
      captureInFlight.delete(captureLockKey);
    }
  }
  timing.execute_ms = Date.now() - te0;

  const directDomCaptureResult =
    trace.success &&
    trace.endpoint_id !== "browser-capture" &&
    !!result &&
    typeof result === "object" &&
    "_extraction" in (result as Record<string, unknown>);
  const learnedSkillUsable = learned_skill ? hasUsableEndpoints(learned_skill) : false;
  if (learned_skill && !learnedSkillUsable) {
    console.warn("[capture] dropping unusable learned skill with no replayable endpoints");
    if (!directDomCaptureResult) learned_skill = undefined;
  }

  // Stamp learned skill with real discovery cost so future cache hits use real baselines.
  if (learned_skill && learnedSkillUsable) {
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
  const hasNonDomApiEndpoints = !!learned_skill?.endpoints?.some((ep) => !ep.dom_extraction && ep.method !== "WS");
  const isDirectDomResult = directDomCaptureResult;
  if (isDirectDomResult && !hasNonDomApiEndpoints) {
    if (learned_skill) promoteLearnedSkill(clientScope, cacheKey, learned_skill, trace.endpoint_id);
    return { result, trace, source: "dom-fallback", skill: learned_skill ?? captureSkill!, timing: finalize("dom-fallback", result, learned_skill?.skill_id, learned_skill, trace) };
  }

  // Agent explicitly chose an endpoint — execute directly.
  if (agentChoseEndpoint && learned_skill) {
    const te1 = Date.now();
    const execOut = await executeSkill(learned_skill, params, projection, { ...options, intent, contextUrl: context?.url });
    timing.execute_ms += Date.now() - te1;
    if (execOut.trace.success) promoteLearnedSkill(clientScope, cacheKey, learned_skill, execOut.trace.endpoint_id);
    return { result: execOut.result, trace: execOut.trace, source: "live-capture", skill: learned_skill, timing: finalize("live-capture", execOut.result, learned_skill.skill_id, learned_skill, execOut.trace), response_schema: execOut.response_schema, extraction_hints: execOut.extraction_hints };
  }

  // Try auto-execute on the learned skill, fall back to deferral
  if (learned_skill) {
    const autoResult = await tryAutoExecute(learned_skill, "live-capture");
    if (autoResult) {
      promoteLearnedSkill(clientScope, cacheKey, learned_skill, autoResult.trace.endpoint_id);
      return autoResult;
    }
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
