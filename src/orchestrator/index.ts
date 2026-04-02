import { cachePublishedSkill, getLocalWalletContext, isX402Error, searchIntentResolve, recordOrchestrationPerf } from "../client/index.js";
import * as kuri from "../kuri/client.js";
import { emitRouteTrace, recordFailure } from "../telemetry.js";
import { publishSkill, getSkill } from "../marketplace/index.js";
import { buildCanonicalDocumentEndpoint, deriveStructuredDataReplayTemplate, deriveStructuredDataReplayUrl, executeSkill, rankEndpoints } from "../execution/index.js";
import { getSkillChunk, knownBindingsFromInputs, computeReachableEndpoints, ensureSkillOperationGraph } from "../graph/index.js";
import { fetchDagAdvisoryPlan, applyDagAdvisoryBoosts } from "./dag-advisor.js";
import { getRegistrableDomain } from "../domain.js";
import { extractTemplateQueryBindings, mergeContextTemplateParams } from "../template-params.js";
import { writeDebugTrace } from "../debug-trace.js";
import { recordDagSessionAction, recordDagNegative, upsertDagEdgesFromOperationGraph } from "./dag-feedback.js";
import { isStructuredSearchForm } from "../execution/search-forms.js";
import { attributeLifecycle, type LifecycleEvent } from "../runtime/lifecycle.js";
import { storeExecutionTrace, findTracesByIntent } from "../graph/trace-store.js";
import { queuePassiveSkillPublish } from "./passive-publish.js";
import { getPrefetchTargets, executePrefetch } from "../capture/prefetch.js";
import { tryFirstPassBrowserAction } from "./first-pass-action.js";
import { computeTimingEconomics } from "./timing-economics.js";
import { checkPaymentRequirement } from "../payments/index.js";
import { checkWalletConfigured } from "../payments/wallet.js";
import type {
  ExecutionOptions,
  ExecutionTrace,
  OrchestrationTiming,
  ProjectionOptions,
  ResponseSchema,
  SkillManifest,
} from "../types/index.js";
import { TRACE_VERSION } from "../version.js";
import { nanoid } from "nanoid";
import { assessIntentResult, projectIntentData } from "../intent-match.js";
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { resolveAuthPrerequisites, deriveAuthDependencies } from "../auth/runtime.js";

const CONFIDENCE_THRESHOLD = 0.3;
const LIVE_CAPTURE_TIMEOUT_MS = Number(process.env.UNBROWSE_LIVE_CAPTURE_TIMEOUT_MS ?? "120000");

/** Flat map of top-level property names → types from a ResponseSchema.
 *  Gives agents enough shape to pick --path targets without full schema bloat. */
/** Recursive schema tree limited to `maxDepth` levels.
 *  Gives agents the response shape they need to pick --path/--extract targets. */
export function summarizeSchema(schema: ResponseSchema, maxDepth = 3): Record<string, unknown> | null {
  function walk(s: ResponseSchema, depth: number): unknown {
    if (depth <= 0) return s.type;
    if (s.type === "array" && s.items) {
      const inner = walk(s.items, depth - 1);
      return inner && typeof inner === "object" ? [inner] : [`${s.items.type ?? "unknown"}`];
    }
    if (s.properties) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties)) {
        out[k] = walk(v, depth - 1);
      }
      return out;
    }
    return s.type;
  }
  if (schema.properties) return walk(schema, maxDepth) as Record<string, unknown>;
  if (schema.type === "array" && schema.items) return { "[]": walk(schema.items, maxDepth - 1) } as Record<string, unknown>;
  return null;
}

/** Extract a compact map of leaf key→value pairs from a sample response.
 *  Digs into the first array item at each level, stops at maxLeaves.
 *  Gives agents concrete examples of extractable data. */
/** Extract a compact map of leaf key→value pairs from a sample response.
 *  Digs into the first array item at each level, stops at maxLeaves.
 *  Skips metadata noise to surface actual data fields agents care about. */
export function extractSampleValues(sample: unknown, maxLeaves = 12): Record<string, unknown> | null {
  if (sample == null) return null;
  const SKIP_KEYS = new Set([
    "__typename", "entryType", "itemType", "clientEventInfo", "feedbackInfo",
    "controllerData", "injectionType", "sortIndex", "cursor", "cursorType",
    "displayTreatment", "socialContext", "promotedMetadata", "feedbackKeys",
    "tweetDisplayType", "element", "component", "details",
  ]);
  const out: Record<string, unknown> = {};
  let count = 0;
  function walk(obj: unknown, path: string, depth: number): void {
    if (count >= maxLeaves || depth > 10) return;
    if (obj == null) return;
    if (Array.isArray(obj)) {
      if (obj.length > 0) walk(obj[0], path + "[]", depth + 1);
      return;
    }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (count >= maxLeaves) break;
        if (SKIP_KEYS.has(k)) continue;
        const p = path ? `${path}.${k}` : k;
        if (v != null && typeof v === "object") {
          walk(v, p, depth + 1);
        } else if (v != null && v !== "" && v !== 0 && v !== false) {
          out[p] = typeof v === "string" && (v as string).length > 80
            ? (v as string).slice(0, 77) + "..."
            : v;
          count++;
        }
      }
      return;
    }
  }
  walk(sample, "", 0);
  return count > 0 ? out : null;
}
const BROWSER_CAPTURE_SKILL_ID = "browser-capture";

// Per-domain skill cache: after a live capture succeeds, cache the skill for 60s so
// subsequent requests hit the local cache instead of re-capturing (avoids EmergentDB lag).
const capturedDomainCache = new Map<
  string,
  { skill: SkillManifest; endpointId?: string; expires: number }
>();
// In-flight capture queue: concurrent callers for the same domain/scope should wait for
// the same live capture instead of failing fast.
const captureInFlight = new Map<
  string,
  Promise<{ learned_skill?: SkillManifest; trace: ExecutionTrace; result: unknown; parity_baseline?: unknown }>
>();
// Cross-client profile lock: some sites/profile dirs do not tolerate parallel browser
// launches against the same domain/profile. Serialize live captures per domain.
const captureDomainLocks = new Map<string, Promise<void>>();
// Route cache: intent+domain → skill_id, skips search+getSkill on repeat queries.
const skillRouteCache = new Map<
  string,
  { skillId: string; domain: string; endpointId?: string; localSkillPath?: string; ts: number }
>();
const ROUTE_CACHE_FILE = join(process.env.HOME ?? "/tmp", ".unbrowse", "route-cache.json");
const SKILL_SNAPSHOT_DIR = join(process.env.HOME ?? "/tmp", ".unbrowse", "skill-snapshots");

// Domain-level skill cache: maps domain → best skillId (independent of intent/URL)
// This enables cross-intent reuse: "find keyboards" seeds cache, "find monitors" reuses it
export const domainSkillCache = new Map<string, { skillId: string; endpointId?: string; localSkillPath?: string; ts: number }>();
const DOMAIN_CACHE_FILE = join(process.env.HOME ?? "/tmp", ".unbrowse", "domain-skill-cache.json");

export function persistDomainCache() {
  try {
    const dir = dirname(DOMAIN_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DOMAIN_CACHE_FILE, JSON.stringify(Object.fromEntries(domainSkillCache)), "utf-8");
  } catch { /* best effort */ }
}

try {
  if (existsSync(DOMAIN_CACHE_FILE)) {
    const data = JSON.parse(readFileSync(DOMAIN_CACHE_FILE, "utf-8"));
    for (const [k, v] of Object.entries(data)) {
      const entry = v as { skillId: string; endpointId?: string; localSkillPath?: string; ts: number };
      if (Date.now() - entry.ts < 7 * 24 * 60 * 60_000) { // 7 day TTL
        domainSkillCache.set(k, entry);
      }
    }
    console.error(`[domain-cache] loaded ${domainSkillCache.size} entries from disk`);
  }
} catch { /* fresh start */ }

// Persist route cache to disk (debounced)
let _routeCacheDirty = false;
function persistRouteCache() {
  _routeCacheDirty = true;
}
const routeCacheFlushTimer = setInterval(() => {
  if (!_routeCacheDirty) return;
  _routeCacheDirty = false;
  try {
    const dir = dirname(ROUTE_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entries = Object.fromEntries(skillRouteCache);
    writeFileSync(ROUTE_CACHE_FILE, JSON.stringify(entries), "utf-8");
  } catch { /* best effort */ }
}, 5_000);

/** Invalidate stale route cache entries for a domain and flush to disk immediately */
export function invalidateRouteCacheForDomain(domain: string): void {
  let deleted = 0;
  for (const [k] of skillRouteCache) {
    if (k.includes(`:${domain}:`) || k.includes(`:${domain.replace(/^www\./, "")}:`)) {
      skillRouteCache.delete(k);
      deleted++;
    }
  }
  if (deleted > 0) {
    // Flush immediately (not debounced) so other processes see the change
    try {
      const dir = dirname(ROUTE_CACHE_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(ROUTE_CACHE_FILE, JSON.stringify(Object.fromEntries(skillRouteCache)), "utf-8");
    } catch { /* best effort */ }
    console.log(`[route-cache] invalidated ${deleted} stale entries for ${domain}`);
  }
}
routeCacheFlushTimer.unref?.();

// Load route cache from disk on startup
try {
  if (existsSync(ROUTE_CACHE_FILE)) {
    const data = JSON.parse(readFileSync(ROUTE_CACHE_FILE, "utf-8"));
    for (const [k, v] of Object.entries(data)) {
      const entry = v as { skillId: string; domain: string; endpointId?: string; localSkillPath?: string; ts: number };
      // Only load entries less than 24h old
      if (Date.now() - entry.ts < 24 * 60 * 60_000) {
        skillRouteCache.set(k, entry);
      }
    }
    console.error(`[route-cache] loaded ${skillRouteCache.size} entries from disk`);
  }
} catch { /* fresh start */ }
const routeResultCache = new Map<
  string,
  {
    skill: SkillManifest;
    endpointId?: string;
    result: unknown;
    trace: ExecutionTrace;
    expires: number;
  }
>();
const ROUTE_CACHE_TTL = 24 * 60 * 60_000; // 24 hours (persisted to disk)
const MARKETPLACE_HYDRATE_LIMIT = Math.max(1, Number(process.env.UNBROWSE_MARKETPLACE_HYDRATE_LIMIT ?? 4));
const MARKETPLACE_GET_SKILL_TIMEOUT_MS = Math.max(250, Number(process.env.UNBROWSE_MARKETPLACE_GET_SKILL_TIMEOUT_MS ?? 2500));
const MARKETPLACE_DOMAIN_SEARCH_K = Math.max(1, Number(process.env.UNBROWSE_MARKETPLACE_DOMAIN_SEARCH_K ?? 5));
const MARKETPLACE_GLOBAL_SEARCH_K = Math.max(1, Number(process.env.UNBROWSE_MARKETPLACE_GLOBAL_SEARCH_K ?? 10));
type SkillRouteCacheEntry = {
  skillId: string;
  domain: string;
  endpointId?: string;
  localSkillPath?: string;
  ts: number;
};
type RouteCacheCandidate = {
  scopedKey: string;
  scope: string;
  entry: SkillRouteCacheEntry;
  skill: SkillManifest;
};

export function scopedCacheKey(scope: string, key: string): string {
  return `${scope}:${key}`;
}

function scopedResolveCacheKeys(scope: string, key: string): string[] {
  return scope === "global"
    ? [scopedCacheKey("global", key)]
    : [scopedCacheKey(scope, key), scopedCacheKey("global", key)];
}

export function snapshotPathForCacheKey(cacheKey: string): string {
  const digest = createHash("sha1").update(cacheKey).digest("hex");
  return join(SKILL_SNAPSHOT_DIR, `${digest}.json`);
}

export function writeSkillSnapshot(cacheKey: string, skill: SkillManifest): string | undefined {
  try {
    mkdirSync(SKILL_SNAPSHOT_DIR, { recursive: true });
    const target = snapshotPathForCacheKey(cacheKey);
    writeFileSync(target, JSON.stringify(skill), "utf-8");
    return target;
  } catch {
    return undefined;
  }
}

function hasSearchBindings(endpoint: SkillManifest["endpoints"][number]): boolean {
  const haystack = JSON.stringify({
    url: endpoint.url_template,
    query: endpoint.query ?? {},
    body_params: endpoint.body_params ?? {},
    body: endpoint.body ?? {},
    semantic: endpoint.semantic ?? {},
  }).toLowerCase();
  return /(basicsearchkey|query|keyword|search|lookup|find|term)/.test(haystack);
}

function scoreSkillSnapshot(skill: SkillManifest): number {
  let score = 0;
  for (const endpoint of skill.endpoints) {
    const active = endpoint.verification_status !== "disabled";
    if (active) score += 20;
    if (endpoint.dom_extraction || endpoint.response_schema) score += 10;
    if (hasSearchBindings(endpoint)) score += 40;
    if (endpoint.method === "POST") score += 6;
    if (/\/result-page\b/i.test(endpoint.url_template)) score += 12;
    if (/captured page artifact/i.test(endpoint.description ?? "")) score -= 18;
  }
  return score + skill.endpoints.length;
}

export function pickPreferredSkillSnapshot(
  primary: SkillManifest,
  candidates: SkillManifest[],
): SkillManifest {
  let best = primary;
  let bestScore = scoreSkillSnapshot(primary);
  for (const candidate of candidates) {
    if (candidate.skill_id !== primary.skill_id) continue;
    const candidateScore = scoreSkillSnapshot(candidate);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
}

function readSkillSnapshot(path?: string): SkillManifest | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const primary = JSON.parse(readFileSync(path, "utf-8")) as SkillManifest;
    if (!existsSync(SKILL_SNAPSHOT_DIR)) return primary;
    const siblingSnapshots: SkillManifest[] = [];
    for (const entry of readdirSync(SKILL_SNAPSHOT_DIR)) {
      if (!entry.endsWith(".json")) continue;
      const candidatePath = join(SKILL_SNAPSHOT_DIR, entry);
      if (candidatePath === path) continue;
      try {
        const candidate = JSON.parse(readFileSync(candidatePath, "utf-8")) as SkillManifest;
        if (candidate.skill_id === primary.skill_id) siblingSnapshots.push(candidate);
      } catch {
        /* ignore bad snapshot */
      }
    }
    return pickPreferredSkillSnapshot(primary, siblingSnapshots);
  } catch {
    return undefined;
  }
}

function findBestLocalDomainSnapshot(
  requestedDomain: string,
  intent: string,
  contextUrl?: string,
  excludeSkillIds?: ReadonlySet<string>,
): SkillManifest | undefined {
  if (!existsSync(SKILL_SNAPSHOT_DIR)) return undefined;
  const targetDomain = getRegistrableDomain(requestedDomain);
  const bestBySkill = new Map<string, SkillManifest>();
  for (const entry of readdirSync(SKILL_SNAPSHOT_DIR)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const candidate = JSON.parse(readFileSync(join(SKILL_SNAPSHOT_DIR, entry), "utf-8")) as SkillManifest;
      if (getRegistrableDomain(candidate.domain) !== targetDomain) continue;
      if (excludeSkillIds?.has(candidate.skill_id)) continue;
      const existing = bestBySkill.get(candidate.skill_id);
      bestBySkill.set(
        candidate.skill_id,
        existing ? pickPreferredSkillSnapshot(existing, [candidate]) : candidate,
      );
    } catch {
      /* ignore bad snapshot */
    }
  }
  let best: SkillManifest | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of bestBySkill.values()) {
    if (!hasUsableEndpoints(candidate)) continue;
    if (!isCachedSkillRelevantForIntent(candidate, intent, contextUrl)) continue;
    if (!marketplaceSkillMatchesContext(candidate, intent, contextUrl)) continue;
    const ranked = rankEndpoints(candidate.endpoints, intent, candidate.domain, contextUrl);
    const topScore = ranked[0]?.score ?? Number.NEGATIVE_INFINITY;
    const composite = topScore + scoreSkillSnapshot(candidate);
    if (composite > bestScore) {
      best = candidate;
      bestScore = composite;
    }
  }
  return best;
}

function isIpv4Hostname(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isIpv6Hostname(hostname: string): boolean {
  return hostname.includes(":");
}

function isPortSensitiveHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    isIpv4Hostname(normalized) ||
    isIpv6Hostname(normalized) ||
    !normalized.includes(".")
  );
}

export function getDomainReuseKey(input?: string | null): string | null {
  if (!input) return null;
  try {
    const parsed = new URL(input);
    if (isPortSensitiveHostname(parsed.hostname)) return parsed.host.toLowerCase();
    return getRegistrableDomain(parsed.hostname);
  } catch {
    return getRegistrableDomain(input);
  }
}

function endpointMatchesContextOrigin(
  endpoint: SkillManifest["endpoints"][number],
  contextUrl?: string,
): boolean {
  if (!contextUrl) return true;
  try {
    const context = new URL(contextUrl);
    if (!isPortSensitiveHostname(context.hostname)) return true;
    const sameOrigin = (candidate?: string | null): boolean => {
      if (!candidate) return false;
      try {
        return new URL(candidate).origin === context.origin;
      } catch {
        return false;
      }
    };
    return sameOrigin(endpoint.url_template) || sameOrigin(endpoint.trigger_url ?? null);
  } catch {
    return true;
  }
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

function promoteLearnedSkill(
  scope: string,
  cacheKey: string,
  skill: SkillManifest,
  endpointId?: string,
  contextUrl?: string,
): void {
  const localSkillPath = writeSkillSnapshot(cacheKey, skill);
  capturedDomainCache.set(cacheKey, { skill, endpointId, expires: Date.now() + 5 * 60_000 });
  skillRouteCache.set(cacheKey, {
    skillId: skill.skill_id,
    domain: skill.domain,
    endpointId,
    ...(localSkillPath ? { localSkillPath } : {}),
    ts: Date.now(),
  });
  persistRouteCache();
  // Also cache at domain level for cross-intent reuse
  const domainKey = getDomainReuseKey(contextUrl ?? skill.domain);
  if (domainKey) {
    domainSkillCache.set(domainKey, {
      skillId: skill.skill_id,
      endpointId,
      ...(localSkillPath ? { localSkillPath } : {}),
      ts: Date.now(),
    });
    persistDomainCache();
  }
}

function cacheResolvedSkill(
  cacheKey: string,
  skill: SkillManifest,
  endpointId?: string,
): void {
  const localSkillPath = writeSkillSnapshot(cacheKey, skill);
  skillRouteCache.set(cacheKey, {
    skillId: skill.skill_id,
    domain: skill.domain,
    endpointId,
    ...(localSkillPath ? { localSkillPath } : {}),
    ts: Date.now(),
  });
  persistRouteCache();
}

function promoteResultSnapshot(
  cacheKey: string,
  skill: SkillManifest,
  endpointId: string | undefined,
  result: unknown,
  trace: ExecutionTrace,
): void {
  routeResultCache.set(cacheKey, {
    skill,
    endpointId,
    result,
    trace,
    expires: Date.now() + ROUTE_CACHE_TTL,
  });
}

function buildCachedResultResponse(
  cached: {
    skill: SkillManifest;
    endpointId?: string;
    result: unknown;
    trace: ExecutionTrace;
  },
  source: "marketplace" | "live-capture",
  timing: OrchestrationTiming,
): OrchestratorResult {
  const now = new Date().toISOString();
  return {
    result: cached.result,
    trace: {
      ...cached.trace,
      trace_id: nanoid(),
      started_at: now,
      completed_at: now,
      endpoint_id: cached.endpointId ?? cached.trace.endpoint_id,
      skill_id: cached.skill.skill_id,
    },
    source,
    skill: cached.skill,
    timing,
  };
}

function invalidateResolveCacheEntries(cacheKeys: string[], domainKeys: string[] = []): void {
  let routeCacheDirty = false;
  let domainCacheDirty = false;
  for (const cacheKey of new Set(cacheKeys.filter(Boolean))) {
    routeResultCache.delete(cacheKey);
    capturedDomainCache.delete(cacheKey);
    if (skillRouteCache.delete(cacheKey)) routeCacheDirty = true;
  }
  for (const domainKey of new Set(domainKeys.filter(Boolean))) {
    if (domainSkillCache.delete(domainKey)) domainCacheDirty = true;
  }
  if (routeCacheDirty) persistRouteCache();
  if (domainCacheDirty) persistDomainCache();
}

async function getSkillWithTimeout(
  skillId: string,
  scope: string,
  timeoutMs = MARKETPLACE_GET_SKILL_TIMEOUT_MS,
): Promise<SkillManifest | null> {
  return Promise.race([
    getSkill(skillId, scope),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
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
  promoteLearnedSkill(scope, cacheKey, skill, endpointId, contextUrl);
  return true;
}

export function shouldBypassLiveCaptureQueue(url?: string): boolean {
  if (!url) return false;
  return deriveStructuredDataReplayUrl(url) !== url || deriveStructuredDataReplayTemplate(url) !== url;
}

function withContextReplayEndpoint(
  skill: SkillManifest,
  intent: string,
  contextUrl?: string,
): SkillManifest {
  if (!contextUrl) return skill;
  const canonical = buildCanonicalDocumentEndpoint(contextUrl, intent, !!skill.auth_profile_ref);
  if (!canonical) return skill;
  if (
    skill.endpoints.some(
      (endpoint) =>
        endpoint.method === canonical.method &&
        endpoint.url_template === canonical.url_template,
    )
  ) {
    return skill;
  }
  return {
    ...skill,
    endpoints: [canonical, ...skill.endpoints],
  };
}

function isSearchLikeIntent(intent?: string, contextUrl?: string): boolean {
  if (/\b(search|find|lookup|browse|discover)\b/i.test(intent ?? "")) return true;
  try {
    const pathname = contextUrl ? new URL(contextUrl).pathname.toLowerCase() : "";
    return /\/(?:search|basic-search|result-page|results?|discover|browse)\b/.test(pathname);
  } catch {
    return false;
  }
}

function buildLocalCanonicalReplaySkill(
  intent: string,
  contextUrl: string,
): SkillManifest | undefined {
  const endpoint = buildCanonicalDocumentEndpoint(contextUrl, intent, false);
  if (!endpoint) return undefined;
  const domain = new URL(contextUrl).hostname.replace(/^www\./, "");
  const now = new Date().toISOString();
  const skill: SkillManifest = {
    skill_id: `canonical-${createHash("sha1").update(contextUrl).digest("hex").slice(0, 12)}`,
    version: "1.0.0",
    schema_version: "1",
    name: `Canonical replay for ${domain}`,
    intent_signature: intent,
    intents: [intent],
    domain,
    description: `Deterministic structured replay for ${contextUrl}`,
    owner_type: "agent",
    execution_type: "http",
    endpoints: [endpoint],
    lifecycle: "active",
    created_at: now,
    updated_at: now,
  };
  cachePublishedSkill(skill);
  return skill;
}

export function isCachedSkillRelevantForIntent(
  skill: SkillManifest,
  intent?: string,
  contextUrl?: string,
): boolean {
  if (!hasUsableEndpoints(skill)) return false;
  if (contextUrl && !skill.endpoints.some((endpoint) => endpointMatchesContextOrigin(endpoint, contextUrl))) {
    return false;
  }
  if (!intent || intent.trim().length === 0) return true;
  if (isFeedTimelineIntent(intent, contextUrl)) {
    const hasFeedLikeEndpoint = skill.endpoints.some((endpoint) =>
      endpointMatchesFeedTimelineContext(endpoint, contextUrl),
    );
    if (!hasFeedLikeEndpoint) return false;
  }
  const resolvedSkill = withContextReplayEndpoint(skill, intent, contextUrl);
  const ranked = rankEndpoints(
    resolvedSkill.endpoints,
    intent,
    resolvedSkill.domain,
    contextUrl,
  );
  const top = ranked[0];
  const isSearchIntent = isSearchLikeIntent(intent, contextUrl);
  if (
    top &&
    isSearchIntent &&
    contextUrl &&
    /captured page artifact/i.test(top.endpoint.description ?? "") &&
    top.endpoint.response_schema?.type !== "array" &&
    top.endpoint.url_template === contextUrl &&
    !skillHasBetterStructuredSearchEndpoint(
      resolvedSkill,
      top.endpoint.endpoint_id,
      intent,
      contextUrl,
    )
  ) {
    return false;
  }
  if (
    top &&
    isEducationCatalogIntent(intent) &&
    isRootContextUrl(contextUrl) &&
    /captured page artifact/i.test(top.endpoint.description ?? "") &&
    top.endpoint.url_template === contextUrl
  ) {
    return false;
  }
  if (isSearchIntent) {
    const hasStructuredSearchEndpoint = resolvedSkill.endpoints.some((endpoint) =>
      endpointHasSearchBindings(endpoint) &&
      (!!endpoint.dom_extraction || !!endpoint.response_schema) &&
      endpointMatchesContextOrigin(endpoint, contextUrl),
    );
    if (hasStructuredSearchEndpoint) return true;
  }
  return (top?.score ?? Number.NEGATIVE_INFINITY) >= 0;
}

export function assessLocalExecutionResult(
  endpoint: SkillManifest["endpoints"][number],
  result: unknown,
  intent: string,
  trace?: ExecutionTrace,
): { verdict: "pass" | "fail" | "skip"; reason: string } {
  const semanticAssessment = assessIntentResult(result, intent);
  if (!/\b(search|find|lookup|browse|discover)\b/i.test(intent)) return semanticAssessment;
  if (endpoint.response_schema?.type !== "array") return semanticAssessment;
  if (Array.isArray(result)) {
    if (result.length === 0) return { verdict: "fail", reason: "search_empty_results" };
    const rows = result.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
    if (rows.length === 0) return semanticAssessment;
    const authBounce = rows.some((row) => {
      const title = String(row.title ?? row.name ?? "").trim().toLowerCase();
      const description = String(row.description ?? row.summary ?? "").trim().toLowerCase();
      const link = String(row.link ?? row.url ?? "").trim().toLowerCase();
      return /^(about|home|welcome)\b/.test(title) ||
        /\b(login|log in|sign in|password)\b/.test(`${title} ${description}`) ||
        /\/(?:about|home|login)\b/.test(link);
    });
    if (authBounce) return { verdict: "fail", reason: "search_auth_or_homepage_bounce" };
    const hasStructuredRows = rows.some((row) =>
      typeof row.title === "string" ||
      typeof row.name === "string" ||
      typeof row.case_name === "string" ||
      typeof row.citation === "string",
    );
    if (hasStructuredRows) return { verdict: "pass", reason: "search_result_rows" };
    return semanticAssessment;
  }
  if (result == null || typeof result !== "object") return semanticAssessment;

  const record = result as Record<string, unknown>;
  const title = String(record.title ?? "").trim().toLowerCase();
  const link = String(record.link ?? record.url ?? "").trim().toLowerCase();
  const description = String(record.description ?? "").trim().toLowerCase();
  const finalUrl = String(
    (trace?.result as Record<string, unknown> | undefined)?._extraction &&
      typeof (trace?.result as Record<string, unknown>)._extraction === "object"
      ? ((trace?.result as Record<string, unknown>)._extraction as Record<string, unknown>).final_url ?? ""
      : "",
  )
    .trim()
    .toLowerCase();
  const looksLikeHomeOrAuthPage =
    /^(about|home|welcome)\b/.test(title) ||
    /\b(login|log in|sign in|password)\b/.test(`${title} ${description}`) ||
    /\/(?:about|home|login)\b/.test(`${link} ${finalUrl}`);
  if (looksLikeHomeOrAuthPage) {
    return { verdict: "fail", reason: "search_auth_or_homepage_bounce" };
  }
  return { verdict: "fail", reason: "search_result_shape_mismatch" };
}

function isEducationCatalogIntent(intent?: string): boolean {
  return /\b(module|modules|course|courses|class|classes|lesson|lessons|timetable|schedule|semester|semesters)\b/i.test(intent ?? "");
}

function isFeedTimelineIntent(intent?: string, contextUrl?: string): boolean {
  const text = `${intent ?? ""} ${contextUrl ?? ""}`.toLowerCase();
  const asksForPosts = /\b(post|posts|tweet|tweets|status|statuses|update|updates)\b/.test(text);
  if (!asksForPosts) return false;
  return /\b(feed|timeline|stream|home|for-you|for_you|latest)\b/.test(text) || /\/(feed|home)\//.test(text);
}

function endpointMatchesFeedTimelineContext(
  endpoint: SkillManifest["endpoints"][number],
  contextUrl?: string,
): boolean {
  const haystack = [
    endpoint.url_template,
    endpoint.trigger_url ?? "",
    endpoint.description ?? "",
    endpoint.semantic?.action_kind ?? "",
    endpoint.semantic?.resource_kind ?? "",
    endpoint.semantic?.description_in ?? "",
    endpoint.semantic?.description_out ?? "",
    JSON.stringify(endpoint.response_schema ?? {}),
  ]
    .join(" ")
    .toLowerCase();
  const mentionsFeed = /\b(feed|timeline|stream|mainfeed|main feed|home)\b/.test(haystack);
  const mentionsPosts = /\b(post|posts|tweet|tweets|status|statuses|update|updates)\b/.test(haystack);
  if (mentionsFeed && mentionsPosts) return true;
  if (!contextUrl) return false;
  try {
    const contextPath = new URL(contextUrl).pathname;
    const endpointPath = new URL(endpoint.url_template).pathname;
    if (endpointPath === contextPath) return true;
  } catch {
    // ignore
  }
  try {
    if (!endpoint.trigger_url) return false;
    const triggerPath = new URL(endpoint.trigger_url).pathname;
    return triggerPath === new URL(contextUrl).pathname;
  } catch {
    return false;
  }
}

function endpointHasSearchBindings(
  endpoint: SkillManifest["endpoints"][number],
): boolean {
  // Primary check: if the endpoint carries a structured search form, use the
  // canonical isStructuredSearchForm predicate (fields.length > 0 && submit_selector set).
  if (endpoint.search_form && isStructuredSearchForm(endpoint.search_form)) {
    return true;
  }
  // Fallback: regex over serialised query/body/semantic keys for API-style search params.
  const haystack = JSON.stringify({
    query: endpoint.query ?? {},
    body: endpoint.body ?? {},
    body_params: endpoint.body_params ?? {},
    semantic: endpoint.semantic ?? {},
  }).toLowerCase();
  return /(basicsearchkey|basic_search_key|query|keyword|search|lookup|find|term)/.test(haystack);
}

function skillHasBetterStructuredSearchEndpoint(
  skill: SkillManifest,
  currentEndpointId: string | undefined,
  intent: string,
  contextUrl?: string,
): boolean {
  if (!isSearchLikeIntent(intent, contextUrl)) return false;
  return rankEndpoints(skill.endpoints, intent, skill.domain, contextUrl).some((candidate) =>
    candidate.endpoint.endpoint_id !== currentEndpointId &&
    endpointHasSearchBindings(candidate.endpoint) &&
    (!!candidate.endpoint.dom_extraction || !!candidate.endpoint.response_schema) &&
    candidate.score >= 0
  );
}

export function skillHasContextStructuredSearchEndpoint(
  skill: SkillManifest,
  intent: string,
  contextUrl?: string,
): boolean {
  if (!isSearchLikeIntent(intent, contextUrl)) return false;
  return skill.endpoints.some((endpoint) =>
    endpointHasSearchBindings(endpoint) &&
    (!!endpoint.dom_extraction || !!endpoint.response_schema) &&
    endpointMatchesContextOrigin(endpoint, contextUrl),
  );
}

function scoreRouteCacheCandidate(
  candidate: RouteCacheCandidate,
  intent: string,
  contextUrl?: string,
): number {
  const resolvedSkill = withContextReplayEndpoint(candidate.skill, intent, contextUrl);
  const ranked = dedupeObservedOverBundle(
    rankEndpoints(resolvedSkill.endpoints, intent, resolvedSkill.domain, contextUrl),
  );
  const top = ranked[0];
  let score = top?.score ?? Number.NEGATIVE_INFINITY;
  const cachedEndpoint = candidate.entry.endpointId
    ? resolvedSkill.endpoints.find((endpoint) => endpoint.endpoint_id === candidate.entry.endpointId)
    : undefined;

  if (!cachedEndpoint && candidate.entry.endpointId) return score - 25;
  if (!cachedEndpoint) return score;

  const cachedRank = ranked.findIndex(
    (rankedCandidate) => rankedCandidate.endpoint.endpoint_id === cachedEndpoint.endpoint_id,
  );
  if (cachedRank === 0) score += 25;
  else if (cachedRank > 0) score += Math.max(0, 10 - cachedRank);
  else score -= 20;

  if (endpointHasSearchBindings(cachedEndpoint)) score += 15;
  if (cachedEndpoint.dom_extraction || cachedEndpoint.response_schema) score += 8;

  const isCapturedPageArtifact = /captured page artifact/i.test(cachedEndpoint.description ?? "");
  if (isCapturedPageArtifact) score -= 10;
  if (
    isCapturedPageArtifact &&
    skillHasBetterStructuredSearchEndpoint(
      resolvedSkill,
      cachedEndpoint.endpoint_id,
      intent,
      contextUrl,
    )
  ) {
    score -= 80;
  }

  return score;
}

export function chooseBestRouteCacheCandidate(
  candidates: RouteCacheCandidate[],
  intent: string,
  contextUrl?: string,
): RouteCacheCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const scoreDelta = scoreRouteCacheCandidate(b, intent, contextUrl) - scoreRouteCacheCandidate(a, intent, contextUrl);
    if (scoreDelta !== 0) return scoreDelta;
    return b.entry.ts - a.entry.ts;
  })[0] ?? null;
}

function isRootContextUrl(contextUrl?: string): boolean {
  if (!contextUrl) return false;
  try {
    return new URL(contextUrl).pathname === "/";
  } catch {
    return false;
  }
}

async function withDomainCaptureLock<T>(domain: string, fn: () => Promise<T>): Promise<T> {
  const prev = captureDomainLocks.get(domain);
  if (prev) {
    try {
      await prev;
    } catch {
      /* previous capture failure shouldn't poison next */
    }
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
  source: "marketplace" | "live-capture" | "dom-fallback" | "first-pass";
  skill: SkillManifest;
  timing: OrchestrationTiming;
}

type AutoExecDecision = {
  orchestratorResult: OrchestratorResult;
  autoexecFailedAll: boolean;
};

export function shouldFallbackToLiveCaptureAfterAutoexecFailure(
  autoexecFailedAll: boolean,
  contextUrl?: string,
): boolean {
  return autoexecFailedAll && !!contextUrl;
}

export function shouldReuseRouteResultSnapshot(
  cached: {
    expires: number;
    skill: SkillManifest;
  },
  intent: string,
  contextUrl?: string,
  now = Date.now(),
): boolean {
  if (cached.expires <= now) return false;
  if (isRouteCacheEntryStale({ skillId: cached.skill.skill_id, domain: cached.skill.domain, ts: cached.expires - ROUTE_CACHE_TTL }, cached.skill)) return false;
  return isCachedSkillRelevantForIntent(cached.skill, intent, contextUrl);
}

/**
 * Returns true when a route cache entry is stale because its pinned endpoint
 * has been disabled, failed verification, or has a critically low reliability
 * score — indicating the endpoint is no longer reliably available.
 *
 * An entry with no pinned endpointId is never considered stale by this check
 * since the skill itself may still have usable endpoints.
 */
export function isRouteCacheEntryStale(
  entry: SkillRouteCacheEntry,
  skill: SkillManifest,
): boolean {
  if (!entry.endpointId) return false;
  const endpoint = skill.endpoints.find((ep) => ep.endpoint_id === entry.endpointId);
  if (!endpoint) return true; // endpoint removed from skill → stale
  if (endpoint.verification_status === "disabled" || endpoint.verification_status === "failed") return true;
  // Treat as stale when reliability has dropped below the auto-deprecation floor
  if (typeof endpoint.reliability_score === "number" && endpoint.reliability_score < 0.2) return true;
  return false;
}

function computeCompositeScore(embeddingScore: number, skill: SkillManifest): number {
  // Average reliability across endpoints
  const reliabilities = skill.endpoints.map((e) => e.reliability_score);
  const avgReliability =
    reliabilities.length > 0
      ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
      : 0.5;

  // Freshness: 1 / (1 + daysSinceUpdate / 30)
  const daysSinceUpdate =
    (Date.now() - new Date(skill.updated_at).getTime()) / (1000 * 60 * 60 * 24);
  const freshnessScore = 1 / (1 + daysSinceUpdate / 30);

  // Verification bonus: 1.0 if all verified, 0.5 if some, 0.0 if none
  const verifiedCount = skill.endpoints.filter((e) => e.verification_status === "verified").length;
  const verificationBonus =
    skill.endpoints.length > 0
      ? verifiedCount === skill.endpoints.length
        ? 1.0
        : verifiedCount > 0
          ? 0.5
          : 0.0
      : 0.0;

  return (
    0.4 * embeddingScore + 0.3 * avgReliability + 0.15 * freshnessScore + 0.15 * verificationBonus
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
    } catch {
      /* keep raw key */
    }
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
    if (normalized.includes('"pass"')) return "pass";
    if (normalized.includes('"fail"')) return "fail";
  }
  return "skip";
}

function obviousSemanticMismatch(
  intent: string,
  endpoint: SkillManifest["endpoints"][number],
  result: unknown,
): boolean {
  const haystack = `${intent} ${endpoint.url_template} ${endpoint.description ?? ""}`.toLowerCase();
  const wantsChannels =
    /\b(channel|channels|guild|guilds|message|messages|thread|threads|dm|chat)\b/.test(
      intent.toLowerCase(),
    );
  const resultKeys =
    result && typeof result === "object"
      ? Object.keys(result as Record<string, unknown>)
          .join(" ")
          .toLowerCase()
      : "";
  if (wantsChannels) {
    if (
      /\b(experiment|experiments|promotion|promotions|affinit|fingerprint|assignment|config|status)\b/.test(
        haystack,
      )
    )
      return true;
    if (/\b(guild_experiments|guild_affinities|fingerprint|assignments)\b/.test(resultKeys))
      return true;
  }
  const wantsPosts = /\b(post|posts|tweet|tweets|status|statuses|timeline|feed)\b/.test(
    intent.toLowerCase(),
  );
  if (wantsPosts && result && typeof result === "object") {
    const keys = JSON.stringify(result).toLowerCase();
    if (/\b(accounts|users|profiles)\b/.test(keys) && !/\b(statuses|posts|tweets)\b/.test(keys))
      return true;
  }
  return false;
}

function inferDefaultParam(
  paramName: string,
  intent: string,
): string | number | boolean | undefined {
  const name = paramName.toLowerCase();
  const intentLower = intent.toLowerCase();
  if (name === "limit" || name === "count" || name === "per_page" || name === "page_size")
    return 20;
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

/**
 * Use the LLM judge to infer template parameter values from a natural-language intent.
 * Given an endpoint's url_template and the user's intent, the LLM figures out what values
 * to fill in for each unbound {param}. This generalizes across ANY website — no hardcoded
 * param name lists or regex patterns needed.
 *
 * Returns a map of param_name → inferred_value for params the LLM could resolve.
 * Params it can't resolve are omitted.
 */
const SEARCH_INTENT_STOPWORDS = new Set([
  "a", "an", "and", "are", "at", "be", "boss", "but", "by", "do", "doing", "fact", "for", "from", "get",
  "going", "had", "has", "have", "i", "if", "im", "in", "into", "is", "it", "its", "just",
  "let", "like", "me", "my", "now", "of", "on", "or", "our", "s", "says", "search", "should",
  "show", "so", "take", "taking", "tell", "that", "the", "their", "them", "there", "these",
  "they", "this", "thoroughly", "to", "up", "us", "was", "we", "were", "what", "where", "which", "who",
  "why", "with", "would", "you", "your",
]);

const SEARCH_DIRECTIVE_PREFIX =
  /^(search\s+for|search|find\s+me|find|look\s+for|looking\s+for|show\s+me|show|get\s+me|get|browse|discover|shop\s+for|buy)\s+/i;
const SEARCH_TRAILING_SITE_HINT = /\s+(on|at|from|in|via)\s+\S+$/i;
const SEARCH_INSTRUCTION_NOISE =
  /\b(do not|don't|dont|tell me|let me know|extremely thoroughly|thoroughly|random cases|for the sake of it|if there is no such|if none exists|if no such)\b/i;
const SEARCH_PRIORITY_PATTERN =
  /\b(high|court|appeal|leave|adduce|evidence|assessment|damages?|tranche|tranches|started|late|stage|hearing|trial|mediation|case|cases|allow|allowed)\b/;

function isLikelySearchParam(
  urlTemplate: string,
  param: string,
): boolean {
  const lowerParam = param.toLowerCase();
  if (/(^q$|^k$|basicsearchkey|basic_search_key|query|keyword|keywords|search|lookup|find|term|phrase|querystr|query_string)/.test(lowerParam)) {
    return true;
  }
  try {
    const parsed = new URL(urlTemplate.replace(/\{[^}]+\}/g, "x"));
    for (const [key, value] of parsed.searchParams.entries()) {
      if (key === param || value === "x") {
        if (/(^q$|^k$|query|keyword|keywords|search|lookup|find|term|phrase|querystr|query_string)/.test(key.toLowerCase())) {
          return true;
        }
      }
    }
  } catch {
    /* ignore malformed templates */
  }
  return false;
}

function collectSearchBindingKeys(
  endpoint: SkillManifest["endpoints"][number],
): string[] {
  const keys = new Set<string>();
  for (const key of Object.keys(endpoint.body_params ?? {})) {
    if (isLikelySearchParam(endpoint.url_template, key)) keys.add(key);
  }
  for (const key of Object.keys(endpoint.query ?? {})) {
    if (isLikelySearchParam(endpoint.url_template, key)) keys.add(key);
  }
  for (const [rawKey, bindingKey] of Object.entries(extractTemplateQueryBindings(endpoint.url_template))) {
    if (isLikelySearchParam(endpoint.url_template, rawKey)
      || isLikelySearchParam(endpoint.url_template, bindingKey)) {
      keys.add(bindingKey);
    }
  }
  for (const match of endpoint.url_template.matchAll(/\{([^}]+)\}/g)) {
    const key = match[1];
    if (isLikelySearchParam(endpoint.url_template, key)) keys.add(key);
  }
  return [...keys];
}

function stripSearchIntentBoilerplate(intent: string): string {
  return intent
    .trim()
    .replace(SEARCH_DIRECTIVE_PREFIX, "")
    .replace(SEARCH_TRAILING_SITE_HINT, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractLiteralSearchTermsFromIntent(intent: string): string | null {
  const stripped = stripSearchIntentBoilerplate(intent);
  if (!stripped) return null;
  const clauses = stripped
    .split(/(?<=[.!?])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length <= 1) return stripped;

  const scored = clauses.map((clause, index) => {
    const tokens = clause
      .toLowerCase()
      .replace(/[^a-z0-9\-/]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !SEARCH_INTENT_STOPWORDS.has(token));
    let score = Math.min(tokens.length, 12);
    if (/["“”']/.test(clause)) score += 4;
    if (/[()]/.test(clause)) score += 2;
    if (/\d/.test(clause)) score += 2;
    if (SEARCH_INSTRUCTION_NOISE.test(clause)) score -= 8;
    return { clause, index, score };
  });

  const selected = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.clause.replace(/\s+/g, " ").trim());

  const joined = (selected.length > 0 ? selected.join(" ") : stripped).trim();
  return joined || null;
}

export function inferSearchParamOverrides(
  endpoint: SkillManifest["endpoints"][number],
  intent: string,
  explicitParams: Record<string, unknown> = {},
): Record<string, string> {
  if (!/\b(search|find|lookup|browse|discover)\b/i.test(intent)) return {};
  const keys = collectSearchBindingKeys(endpoint);
  if (keys.length === 0) return {};
  const selectedTerms = selectSearchTermsForExecution(intent);
  if (!selectedTerms) return {};
  const overrides: Record<string, string> = {};
  for (const key of keys) {
    if (explicitParams[key] != null && explicitParams[key] !== "") continue;
    overrides[key] = selectedTerms;
  }
  return overrides;
}

export function selectSearchTermsForExecution(intent: string): string | null {
  const literal = extractLiteralSearchTermsFromIntent(intent);
  const condensed = extractSearchTermsFromIntent(intent);
  if (!literal) return condensed;
  if (!condensed || condensed === literal) return literal;
  const wordCount = literal.split(/\s+/).filter(Boolean).length;
  const hasQuotedPhrase = /["“”]/.test(literal);
  const hasSentencePunctuation = /[.!?]/.test(literal);
  const tooLongForSingleField = literal.length > 180 || wordCount > 24;
  if (hasQuotedPhrase && !tooLongForSingleField) return literal;
  if (!hasSentencePunctuation && !tooLongForSingleField) return literal;
  if (tooLongForSingleField) {
    const compactPhraseQuery = buildCompactPhraseSearchQuery(intent);
    if (compactPhraseQuery) return compactPhraseQuery;
  }
  return condensed;
}

function buildCompactPhraseSearchQuery(intent: string): string | null {
  const stripped = stripSearchIntentBoilerplate(intent);
  if (!stripped) return null;
  const sourceText = extractLiteralSearchTermsFromIntent(intent) ?? stripped;
  const clauses = sourceText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const phraseScores = new Map<string, { score: number; clauseIndex: number }>();
  const remember = (rawPhrase: string, score: number, clauseIndex: number) => {
    const phrase = rawPhrase
      .toLowerCase()
      .replace(/[^a-z0-9\s/-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!phrase) return;
    const words = phrase.split(/\s+/).filter(Boolean);
    const contentWords = words.filter((word) => !SEARCH_INTENT_STOPWORDS.has(word));
    if (contentWords.length < 2) return;
    if (!contentWords.some((word) => SEARCH_PRIORITY_PATTERN.test(word))) return;
    if (words.length > 8) return;
    if (SEARCH_INSTRUCTION_NOISE.test(phrase)) return;
    const priorityHits = contentWords.filter((word) => SEARCH_PRIORITY_PATTERN.test(word)).length;
    const proceduralHits = contentWords.filter((word) => /^(started|tranche|tranches|allow|allowed)$/.test(word)).length;
    const startsBadly = /^(eg|\d)$/.test(words[0] ?? "") || /^\d+$/.test(words[0] ?? "");
    const endsBadly = /^(eg|\d)$/.test(words[words.length - 1] ?? "") || /^\d+$/.test(words[words.length - 1] ?? "");
    const connectorHits = words.filter((word) => ["of", "to", "for", "at", "after"].includes(word)).length;
    if (/\b(such|none|random)\b/.test(phrase)) return;
    const boostedScore =
      score
      + Math.min(contentWords.length, 4)
      + priorityHits * 3
      + proceduralHits * 4
      + connectorHits
      + (words.length >= 3 && words.length <= 5 ? 2 : 0)
      + (/\d/.test(phrase) ? 2 : 0)
      - (startsBadly ? 4 : 0)
      - (endsBadly ? 4 : 0)
      - (/\beg\b/.test(phrase) ? 6 : 0);
    const existing = phraseScores.get(phrase);
    if (!existing || boostedScore > existing.score) phraseScores.set(phrase, { score: boostedScore, clauseIndex });
  };

  for (const [clauseIndex, clause] of clauses.entries()) {
    for (const match of clause.matchAll(/["“”']([^"“”']{3,80})["“”']/g)) {
      remember(match[1], 12, clauseIndex);
    }
  }

  for (const [clauseIndex, clause] of clauses.entries()) {
    for (const match of clause.matchAll(/\b[a-z0-9-]+(?:\s+(?:of|to|for|at|after)\s+[a-z0-9-]+){1,4}\b/gi)) {
      remember(match[0], 14, clauseIndex);
    }
    const tokens = clause
      .toLowerCase()
      .replace(/[^a-z0-9\s/-]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    for (let start = 0; start < tokens.length; start++) {
      for (let size = 2; size <= 6 && start + size <= tokens.length; size++) {
        const slice = tokens.slice(start, start + size);
        if (SEARCH_INTENT_STOPWORDS.has(slice[0]) || SEARCH_INTENT_STOPWORDS.has(slice[slice.length - 1])) continue;
        remember(slice.join(" "), 6 - Math.abs(size - 4), clauseIndex);
      }
    }
  }

  const selected: string[] = [];
  const selectedRaw: string[] = [];
  let currentLength = 0;
  const clauseCounts = new Map<number, number>();
  for (const [phrase, meta] of Array.from(phraseScores.entries())
    .sort((a, b) => b[1].score - a[1].score || a[0].length - b[0].length)) {
    if (selectedRaw.some((chosen) => chosen.includes(phrase) || phrase.includes(chosen))) continue;
    if ((clauseCounts.get(meta.clauseIndex) ?? 0) >= 2) continue;
    const rendered = `"${phrase}"`;
    const nextLength = currentLength === 0 ? rendered.length : currentLength + 1 + rendered.length;
    if (nextLength > 140) continue;
    selected.push(rendered);
    selectedRaw.push(phrase);
    clauseCounts.set(meta.clauseIndex, (clauseCounts.get(meta.clauseIndex) ?? 0) + 1);
    currentLength = nextLength;
    if (selected.length >= 4) break;
  }

  return selected.length > 0 ? selected.join(" ") : null;
}

function condenseSearchIntent(intent: string): string | null {
  const wantsSearchAction = /\b(search|find|lookup|look\s+for|browse|discover)\b/i.test(intent);
  const tokens = intent
    .toLowerCase()
    .replace(/[^a-z0-9\][\-/]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !SEARCH_INTENT_STOPWORDS.has(token));
  const scored = new Map<string, { token: string; index: number; score: number }>();
  tokens.forEach((token, index) => {
    let score = 0;
    if (SEARCH_PRIORITY_PATTERN.test(token)) score += 10;
    if (token.length >= 8) score += 2;
    if (index < 12) score += 1;
    const existing = scored.get(token);
    if (!existing || score > existing.score) {
      scored.set(token, { token, index, score });
    }
  });
  const budget = wantsSearchAction ? 13 : 14;
  const selected = Array.from(scored.values())
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, budget)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.token);
  if (selected.length === 0) return null;
  if (wantsSearchAction && selected[0] !== "search") {
    selected.unshift("search");
  }
  return selected.join(" ");
}

/** Strip meta-phrases from intent to get raw search terms. Returns null if intent is too complex. */
export function extractSearchTermsFromIntent(intent: string): string | null {
  let terms = stripSearchIntentBoilerplate(intent).toLowerCase();
  if (!terms) return null;
  const words = terms.split(/\s+/).filter(Boolean);
  if (terms.length > 160 || words.length > 20 || /[.!?]/.test(terms)) {
    return condenseSearchIntent(terms);
  }
  // If there are multiple clauses (dates, locations, filters), fall back to LLM
  if (/\b(from|to|between|before|after|near|in\s+\w+,?\s+\w+|under\s+\$|over\s+\$|cheaper\s+than|more\s+than)\b/i.test(terms)) {
    return null;
  }
  return terms || null;
}

async function inferParamsFromIntent(
  urlTemplate: string,
  intent: string,
  unboundParams: string[],
  endpointDescription?: string,
): Promise<Record<string, string>> {
  if (unboundParams.length === 0) return {};

  // Fast path: single search-like param — extract search terms directly
  if (unboundParams.length === 1) {
    const param = unboundParams[0];
    if (isLikelySearchParam(urlTemplate, param, endpointDescription)) {
      const searchTerms = selectSearchTermsForExecution(intent);
      if (searchTerms) {
        return { [param]: searchTerms };
      }
    }
  }

  // Skip LLM call — unbound params will cause execution deferral, which shows
  // the agent the endpoint's input_params with examples. The agent fills them via --params.
  return {};
}


async function withOpTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  return await Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout:${ms}`)), ms),
    ),
  ]);
}

async function withAbortableOpTimeout<T>(
  label: string,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${label}_timeout:${ms}`)), ms);
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason ?? new Error(`${label}_timeout:${ms}`)),
          { once: true },
        ),
      ),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function inferPreferredEntityTokens(intent: string): string[] {
  const lower = intent.toLowerCase();
  if (/\b(post|posts|tweet|tweets|status|statuses)\b/.test(lower))
    return ["statuses", "posts", "tweets", "timeline"];
  if (/\b(person|people|profile|profiles|member|members|user|users)\b/.test(lower)) {
    return [
      "accounts",
      "user",
      "users",
      "profile",
      "profiles",
      "person",
      "people",
      "member",
      "members",
      "screen_name",
      "userbyscreenname",
    ];
  }
  if (/\b(company|companies|organization|organisations|business|org)\b/.test(lower))
    return ["company", "companies", "organization", "business", "org"];
  if (/\b(repo|repos|repository|repositories)\b/.test(lower))
    return ["repositories", "repository", "repo"];
  if (/\b(topic|topics|trend|trends|hashtag|hashtags)\b/.test(lower))
    return ["trends", "trend", "topic", "topics", "hashtag"];
  return [];
}

function isAcceptableIntentResult(result: unknown, intent: string): boolean {
  return assessIntentResult(result, intent).verdict !== "fail";
}

function candidateMatchesPreferredEntity(
  candidate: RankedCandidate,
  preferredTokens: string[],
): boolean {
  if (preferredTokens.length === 0) return false;
  if (candidate.endpoint.dom_extraction || candidate.endpoint.method === "WS") return false;
  if (/inferred from js bundle/i.test(candidate.endpoint.description ?? "")) return false;
  const haystack = [
    candidate.endpoint.url_template,
    candidate.endpoint.description ?? "",
    JSON.stringify(candidate.endpoint.response_schema ?? {}),
  ]
    .join(" ")
    .toLowerCase();
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
    return (
      endpointUrl.origin === contextPage.origin && endpointUrl.pathname === contextPage.pathname
    );
  } catch {
    return /captured page artifact/i.test(candidate.endpoint.description ?? "");
  }
}

function isConcreteEntityDetailIntent(intent: string, contextUrl?: string): boolean {
  if (!/\b(get|fetch|view)\b/i.test(intent)) return false;
  if (
    !/\b(company|companies|organization|organisations|business|org|person|people|profile|profiles|member|members|user|users|product|products|item|items|listing|listings)\b/i.test(
      intent,
    )
  )
    return false;
  if (!contextUrl) return false;
  try {
    const leaf = decodeURIComponent(
      new URL(contextUrl).pathname.split("/").filter(Boolean).pop() ?? "",
    ).toLowerCase();
    return (
      !!leaf &&
      !/^(search|explore|trending|tabs|home|for-you|foryou|latest|live|people|posts|videos)$/.test(
        leaf,
      )
    );
  } catch {
    return false;
  }
}

export function marketplaceSkillMatchesContext(
  skill: SkillManifest,
  intent: string,
  contextUrl?: string,
): boolean {
  if (contextUrl && !skill.endpoints.some((endpoint) => endpointMatchesContextOrigin(endpoint, contextUrl))) {
    return false;
  }
  if (isFeedTimelineIntent(intent, contextUrl)) {
    return skill.endpoints.some((endpoint) => endpointMatchesFeedTimelineContext(endpoint, contextUrl));
  }
  if (!contextUrl || !isConcreteEntityDetailIntent(intent, contextUrl)) return true;
  let contextPath = "";
  try {
    contextPath = new URL(contextUrl).pathname;
  } catch {
    return true;
  }
  if (!contextPath) return true;

  let hasApiLikeEndpoint = false;
  for (const endpoint of skill.endpoints ?? []) {
    let path = "";
    let triggerPath = "";
    try { path = new URL(endpoint.url_template).pathname; } catch { /* ignore */ }
    try { triggerPath = endpoint.trigger_url ? new URL(endpoint.trigger_url).pathname : ""; } catch { /* ignore */ }
    if (path === contextPath || triggerPath === contextPath) return true;

    const apiLike =
      /\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(endpoint.url_template) ||
      (!endpoint.dom_extraction && !!endpoint.response_schema && !/captured page artifact/i.test(endpoint.description ?? ""));
    if (apiLike) hasApiLikeEndpoint = true;
  }

  return hasApiLikeEndpoint;
}

function prioritizeIntentMatchedApis(
  ranked: RankedCandidate[],
  intent: string,
  contextUrl?: string,
): RankedCandidate[] {
  const preferred = inferPreferredEntityTokens(intent);
  if (preferred.length === 0) return ranked;
  const preferredApis = ranked.filter((candidate) =>
    candidateMatchesPreferredEntity(candidate, preferred),
  );
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
  _intent: string,
  _skill: SkillManifest,
  _ranked: RankedCandidate[],
  _contextUrl?: string,
): Promise<string[] | null> {
  // Deterministic scoring from rankEndpoints + readiness bonuses is already applied upstream.
  // LLM reranking added ~8s latency for marginal benefit — removed.
  return null;
}

function agentJudgeExecution(
  intent: string,
  endpoint: SkillManifest["endpoints"][number],
  result: unknown,
): "pass" | "fail" | "skip" {
  // Fast deterministic heuristic — the host agent judges the data when it sees it.
  if (obviousSemanticMismatch(intent, endpoint, result)) return "fail";
  if (result == null) return "fail";
  if (Array.isArray(result)) return result.length > 0 ? "pass" : "fail";
  if (typeof result === "object") return Object.keys(result as Record<string, unknown>).length > 0 ? "pass" : "fail";
  if (typeof result === "string") return result.length > 0 ? "pass" : "fail";
  return "skip";
}

function normalizeParityRows(data: unknown, intent: string): Array<Record<string, unknown>> {
  const projected = projectIntentData(data, intent);
  if (Array.isArray(projected)) {
    return projected.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  }
  if (projected && typeof projected === "object") return [projected as Record<string, unknown>];
  return [];
}

function compactParityValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim().toLowerCase().slice(0, 160);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => compactParityValue(item)).filter(Boolean).join("|");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).slice(0, 3).map((item) => compactParityValue(item)).filter(Boolean).join("|");
  }
  return "";
}

function parityFingerprint(row: Record<string, unknown>): string {
  const preferredKeys = [
    "id",
    "entityUrn",
    "urn",
    "url",
    "link",
    "slug",
    "name",
    "title",
    "headline",
    "author",
    "user",
    "content",
    "text",
    "body",
  ];
  const parts = preferredKeys
    .map((key) => compactParityValue(row[key]))
    .filter(Boolean)
    .slice(0, 4);
  if (parts.length > 0) return parts.join("::");
  return compactParityValue(row);
}

function localParityVerdict(
  intent: string,
  browserBaseline: unknown,
  replayResult: unknown,
): { verdict: "pass" | "fail" | "skip"; reason: string } {
  const browserAssessment = assessIntentResult(browserBaseline, intent);
  const replayAssessment = assessIntentResult(replayResult, intent);
  if (replayAssessment.verdict === "fail") return { verdict: "fail", reason: `replay_${replayAssessment.reason}` };
  if (browserAssessment.verdict === "fail") return { verdict: "skip", reason: `browser_${browserAssessment.reason}` };

  const browserRows = normalizeParityRows(browserBaseline, intent);
  const replayRows = normalizeParityRows(replayResult, intent);
  if (browserRows.length === 0 || replayRows.length === 0) return { verdict: "skip", reason: "insufficient_rows" };

  const browserPrints = new Set(browserRows.map(parityFingerprint).filter(Boolean));
  const replayPrints = new Set(replayRows.map(parityFingerprint).filter(Boolean));
  if (browserPrints.size === 0 || replayPrints.size === 0) return { verdict: "skip", reason: "insufficient_fingerprints" };

  let overlap = 0;
  for (const fingerprint of browserPrints) {
    if (replayPrints.has(fingerprint)) overlap += 1;
  }
  const overlapRatio = overlap / Math.max(1, Math.min(browserPrints.size, replayPrints.size));
  if (overlapRatio >= 0.4) return { verdict: "pass", reason: `fingerprint_overlap_${overlap}/${Math.min(browserPrints.size, replayPrints.size)}` };
  if (overlap === 0 && browserPrints.size >= 2 && replayPrints.size >= 1) {
    return { verdict: "fail", reason: "zero_overlap" };
  }
  return { verdict: "skip", reason: `low_overlap_${overlapRatio.toFixed(2)}` };
}

function agentJudgeParity(
  intent: string,
  browserBaseline: unknown,
  replayResult: unknown,
): "pass" | "fail" | "skip" {
  // Use local fingerprint-based parity only — LLM call removed.
  const local = localParityVerdict(intent, browserBaseline, replayResult);
  return local.verdict;
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
  options?: ExecutionOptions,
): Promise<OrchestratorResult> {
  const t0 = Date.now();
  const timing: OrchestrationTiming = {
    search_ms: 0,
    get_skill_ms: 0,
    execute_ms: 0,
    total_ms: 0,
    source: "marketplace",
    cache_hit: false,
    candidates_found: 0,
    candidates_tried: 0,
    tokens_saved: 0,
    response_bytes: 0,
    time_saved_pct: 0,
    tokens_saved_pct: 0,
    actual_total_ms: 0,
    trace_version: TRACE_VERSION,
  };
  const decisionTrace: Record<string, unknown> = {
    intent,
    params,
    context,
    search_candidates: [] as unknown[],
    autoexec_attempts: [] as unknown[],
  };
  const queryIntent = selectSearchTermsForExecution(intent) ?? extractSearchTermsFromIntent(intent) ?? intent;
  if (queryIntent !== intent) decisionTrace.query_intent = queryIntent;

  // When the agent explicitly passes endpoint_id, execute directly — they already chose.
  const agentChoseEndpoint = !!params.endpoint_id;

  const forceCapture = !!options?.force_capture;
  const clientScope = options?.client_scope ?? "global";
  // force_capture: clear domain caches so we go straight to browser capture
  if (forceCapture && context?.url) {
    const d = getDomainReuseKey(context.url) ?? new URL(context.url).hostname;
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

  function finalize(
    source: OrchestrationTiming["source"],
    result: unknown,
    skillId?: string,
    skill?: SkillManifest,
    trace?: ExecutionTrace,
  ): OrchestrationTiming {
    timing.total_ms = Date.now() - t0;
    timing.actual_total_ms = timing.total_ms;
    timing.source = source;
    timing.skill_id = skillId;

    const economics = computeTimingEconomics({
      source,
      totalMs: timing.total_ms,
      result,
      skill,
      paidSearchUc: timing.paid_search_uc ?? 0,
      paidExecutionUc: timing.paid_execution_uc ?? 0,
    });
    timing.response_bytes = economics.response_bytes;
    timing.tokens_saved = economics.tokens_saved;
    timing.tokens_saved_pct = economics.tokens_saved_pct;
    timing.time_saved_pct = economics.time_saved_pct;
    timing.actual_cost_uc = economics.actual_cost_uc;
    if (economics.baseline_total_ms != null) timing.baseline_total_ms = economics.baseline_total_ms;
    if (economics.time_saved_ms != null) timing.time_saved_ms = economics.time_saved_ms;
    if (economics.baseline_cost_uc != null) timing.baseline_cost_uc = economics.baseline_cost_uc;
    if (economics.cost_saved_uc != null) timing.cost_saved_uc = economics.cost_saved_uc;

    // Stamp trace with token metrics so they persist in trace files
    if (trace) {
      trace.tokens_used = economics.response_tokens;
      trace.tokens_saved = timing.tokens_saved;
      trace.tokens_saved_pct = timing.tokens_saved_pct;
    }

    console.log(
      `[perf] ${source}: ${timing.total_ms}ms (time_saved=${timing.time_saved_pct}% tokens_saved=${timing.tokens_saved_pct}%${economics.baseline_source === "real" ? " [real baseline]" : economics.baseline_source === "estimated" ? " [estimated]" : ""})`,
    );

    // Lifecycle attribution: aggregate per-phase durations for observability
    const lifecycleSource: LifecycleEvent["source"] =
      source === "marketplace" ? "marketplace" : source === "route-cache" ? "cache" : "live-capture";
    const skillIdForLifecycle = skillId ?? "unknown";
    const now = new Date().toISOString();
    const lifecycleEvents: LifecycleEvent[] = [];
    if (timing.get_skill_ms > 0) {
      lifecycleEvents.push({ phase: "resolve", skill_id: skillIdForLifecycle, timestamp: now, duration_ms: timing.get_skill_ms, source: lifecycleSource });
    }
    if (timing.execute_ms > 0) {
      lifecycleEvents.push({ phase: "execute", skill_id: skillIdForLifecycle, timestamp: now, duration_ms: timing.execute_ms, source: lifecycleSource });
    }
    if (timing.total_ms > 0) {
      lifecycleEvents.push({ phase: "discover", skill_id: skillIdForLifecycle, timestamp: now, duration_ms: timing.total_ms, source: lifecycleSource });
    }
    const lifecycleTotals = attributeLifecycle(lifecycleEvents);
    if (lifecycleTotals.size > 0) {
      const breakdown = [...lifecycleTotals.entries()].map(([phase, ms]) => `${phase}=${ms}ms`).join(" ");
      console.log(`[lifecycle] ${breakdown}`);
    }
    // Fire-and-forget to backend
    recordOrchestrationPerf(timing).catch(() => {});
    // Persist anonymized local trace artifact (#28)
    emitRouteTrace({
      trace_id: trace?.trace_id ?? nanoid(),
      session_scope: clientScope,
      goal: intent,
      domain: context?.domain ?? (context?.url ? (() => { try { return new URL(context.url!).hostname; } catch { return ""; } })() : ""),
      started_at: new Date(t0).toISOString(),
      skill_id: skillId,
      endpoint_id: trace?.endpoint_id,
      source,
      status_code: trace?.status_code,
      response_bytes: timing.response_bytes,
      result,
      schema_match: trace?.success ?? false,
      candidates_considered: timing.candidates_found,
      bindings_before: params,
      bindings_resolved: {},
      bindings_missing: [],
      outcome: trace?.success === false ? "failure" : trace?.success ? "success" : "skip",
      error: trace?.error,
    });
    // Auto-file GitHub issues on repeated failures
    if (trace?.success === false && trace?.error && skillId) {
      const domain = context?.domain ?? (context?.url ? (() => { try { return new URL(context.url!).hostname; } catch { return ""; } })() : "");
      recordFailure({
        skillId,
        endpointId: trace.endpoint_id,
        domain,
        intent,
        url: context?.url,
        error: trace.error,
      });
    }
    return timing;
  }
  /** Always defer to the agent — auto-exec is unreliable and picks wrong endpoints. */
  async function buildDeferralWithAutoExec(
    skill: SkillManifest,
    source: "marketplace" | "live-capture",
    extraFields?: Record<string, unknown>,
  ): Promise<AutoExecDecision> {
    return {
      orchestratorResult: buildDeferral(skill, source, extraFields),
      autoexecFailedAll: false,
    };
  }

  /** Build a deferral response — returns the skill + ranked endpoints for the agent to choose. */
  function buildDeferral(
    skill: SkillManifest,
    source: "marketplace" | "live-capture",
    extraFields?: Record<string, unknown>,
  ): OrchestratorResult {
    const resolvedSkill = withContextReplayEndpoint(skill, queryIntent, context?.url);
    const chunk = getSkillChunk(resolvedSkill, {
      intent: queryIntent,
      known_bindings: knownBindingsFromInputs(params, context?.url),
      max_operations: 8,
    });
    let epRanked = rankEndpoints(resolvedSkill.endpoints, queryIntent, resolvedSkill.domain, context?.url);
    // Graph-aware reachability filter
    const known = knownBindingsFromInputs(params, context?.url);
    const deferGraph = ensureSkillOperationGraph(resolvedSkill);
    const reachableIds = computeReachableEndpoints(deferGraph, known);
    if (reachableIds.size > 0) {
      epRanked = epRanked.filter(r => reachableIds.has(r.endpoint.endpoint_id));
    }
    const deferTrace: ExecutionTrace = {
      trace_id: nanoid(),
      skill_id: resolvedSkill.skill_id,
      endpoint_id: "",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: true,
    };
    writeDebugTrace("resolve", {
      ...decisionTrace,
      outcome: "deferral",
      source,
      skill_id: resolvedSkill.skill_id,
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
        message: `Found ${epRanked.length} endpoint(s). Pick one and call POST /v1/skills/${resolvedSkill.skill_id}/execute with params.endpoint_id.`,
        skill_id: resolvedSkill.skill_id,
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
          url:
            r.endpoint.url_template.length > 120
              ? r.endpoint.url_template.slice(0, 120) + "..."
              : r.endpoint.url_template,
          score: Math.round(r.score * 10) / 10,
          schema_summary: r.endpoint.response_schema
            ? summarizeSchema(r.endpoint.response_schema)
            : null,
          input_params: r.endpoint.semantic?.requires?.map((b) => ({
            key: b.key,
            type: b.type ?? b.semantic_type,
            required: b.required ?? false,
            example: b.example_value,
          })) ?? [],
          description_in: r.endpoint.semantic?.description_in,
          example_fields: r.endpoint.semantic?.example_fields?.slice(0, 12),
          sample_values: extractSampleValues(r.endpoint.semantic?.example_response_compact),
          dom_extraction: !!r.endpoint.dom_extraction,
          trigger_url: r.endpoint.trigger_url,
          needs_params: r.endpoint.semantic?.requires?.some((b) => b.required) ?? false,
        })),
        ...extraFields,
      },
      trace: deferTrace,
      source,
      skill: resolvedSkill,
      timing: finalize(source, null, resolvedSkill.skill_id, resolvedSkill, deferTrace),
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

  const UNSAFE_ACTION_BLOCK_THRESHOLD = 0.6;

  function computeUnsafeActionScore(endpoint: SkillManifest["endpoints"][number]): number {
    let score = 0;
    if (endpoint.idempotency === "unsafe") score += 0.4;
    if (endpoint.method === "POST" || endpoint.method === "PUT" || endpoint.method === "DELETE") score += 0.2;
    const inferredFromBundle = /inferred from js bundle/i.test(endpoint.description ?? "");
    if (inferredFromBundle) score += 0.2; // guessed from bundle = risky
    if (!endpoint.response_schema) score += 0.1;
    if (endpoint.verification_status === "failed") score += 0.1;
    if (endpoint.reliability_score < 0.3) score += 0.1;
    // Reduce score for strong evidence
    if (endpoint.trigger_url) score -= 0.1;
    if (endpoint.verification_status === "verified") score -= 0.15;
    return Math.max(0, Math.min(1, score));
  }


  function canAutoExecuteEndpoint(endpoint: SkillManifest["endpoints"][number]): boolean {
    const endpointParams = resolveEndpointTemplateBindings(endpoint, resolvedParams, context?.url);
    const missing = missingTemplateParams(endpoint, endpointParams);
    // For params that inferDefaultParam can't resolve synchronously, check if LLM
    // inference is plausible (i.e. we have an intent string and unbound params).
    // The actual LLM call happens at execution time, not here.
    const unresolvedBySync = missing.filter((name) => inferDefaultParam(name, queryIntent) === undefined);
    if (unresolvedBySync.length > 0) {
      // If we have an intent, assume the LLM can likely resolve remaining params
      // (search terms, locations, dates, etc.) — don't block execution.
      if (!queryIntent || queryIntent.trim().length === 0) return false;
      // Safety: don't auto-execute if there are too many unresolved params (likely wrong endpoint)
      if (unresolvedBySync.length > 4) return false;
    }
    if (endpoint.dom_extraction) return true;
    if (endpoint.method !== "GET" && endpoint.idempotency !== "safe") {
      // Block high-risk non-safe endpoints unless caller has confirmed
      const unsafeScore = computeUnsafeActionScore(endpoint);
      if (unsafeScore >= UNSAFE_ACTION_BLOCK_THRESHOLD && !options?.confirm_unsafe) {
        console.log(
          `[auto-exec] blocked unsafe endpoint ${endpoint.endpoint_id} (unsafe_score=${unsafeScore.toFixed(2)})`,
        );
        return false;
      }
    }
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
      } catch {
        /* ignore */
      }
    }
    return merged;
  })();

  // --- Prior trace retrieval (lightweight RAG signal) ---
  // Retrieve prior execution traces for this domain+intent to boost endpoints that worked before.
  const requestedDomainForTraces = context?.domain ?? (context?.url ? (() => { try { return new URL(context.url!).hostname; } catch { return null; } })() : null);
  let priorSuccessEndpoints: Set<string> | undefined;
  if (requestedDomainForTraces && queryIntent) {
    try {
      const priorTraces = findTracesByIntent(requestedDomainForTraces, queryIntent, 3);
      if (priorTraces.length > 0) {
        priorSuccessEndpoints = new Set(
          priorTraces.filter(t => t.success && t.selected_endpoint_id)
            .map(t => t.selected_endpoint_id!),
        );
        (decisionTrace as Record<string, unknown>).prior_traces = priorTraces.length;
        (decisionTrace as Record<string, unknown>).prior_success_endpoints = [...priorSuccessEndpoints];
      }
    } catch {
      // Trace retrieval must never block the resolve path
    }
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
    source: "marketplace" | "live-capture",
  ): Promise<OrchestratorResult | null> {
    let epRanked = rankEndpoints(skill.endpoints, queryIntent, skill.domain, context?.url);
    const originalRanked = epRanked;
    const chunk = getSkillChunk(skill, {
      intent: queryIntent,
      known_bindings: knownBindingsFromInputs(resolvedParams, context?.url),
      max_operations: 8,
    });
    const preferredAutoexecIds = new Set(
      epRanked.slice(0, Math.min(5, epRanked.length)).map((ranked) => ranked.endpoint.endpoint_id),
    );
    const graphEndpointIds = new Set(
      chunk.available_operation_ids.length > 0
        ? [...chunk.available_operation_ids, ...preferredAutoexecIds]
        : [...chunk.operations.map((operation) => operation.operation_id), ...preferredAutoexecIds],
    );
    if (graphEndpointIds.size > 0) {
      epRanked = epRanked.filter((ranked) => graphEndpointIds.has(ranked.endpoint.endpoint_id));
      const hasObservedAfterFilter = epRanked.some(
        (ranked) => !/inferred from js bundle/i.test(ranked.endpoint.description ?? ""),
      );
      const observedBeforeFilter = originalRanked.filter(
        (ranked) => !/inferred from js bundle/i.test(ranked.endpoint.description ?? ""),
      );
      if (!hasObservedAfterFilter && observedBeforeFilter.length > 0) {
        epRanked = dedupeObservedOverBundle([...observedBeforeFilter, ...epRanked]);
      }
    }

    // --- Hard reachability filter (A_reachable from the Machine Intent paper) ---
    // Unreachable endpoints are removed, not just penalized. Only applied when the
    // graph has at least one reachable entry point to avoid degenerate cases.
    const reachableIds = computeReachableEndpoints(
      ensureSkillOperationGraph(skill),
      knownBindingsFromInputs(resolvedParams, context?.url),
    );
    if (reachableIds.size > 0) {
      epRanked = epRanked.filter((r) => reachableIds.has(r.endpoint.endpoint_id));
    }
    // --- end reachability filter ---
    if (epRanked.length === 0) return null;
    decisionTrace.search_candidates = epRanked.slice(0, 10).map((ranked) => ({
      endpoint_id: ranked.endpoint.endpoint_id,
      score: Math.round(ranked.score * 10) / 10,
      description: ranked.endpoint.description,
      url: ranked.endpoint.url_template,
      dom_extraction: !!ranked.endpoint.dom_extraction,
      unsafe_action_score: Math.round(computeUnsafeActionScore(ranked.endpoint) * 100) / 100,
    }));

    // When BM25 scores are tied, use schema field overlap with intent as tiebreaker.
    // "get subreddit posts" → intent tokens ["subreddit","posts","get"]
    // Endpoint with schema {title, author, score, num_comments} > {token, expires}
    if (epRanked.length >= 2 && queryIntent) {
      const intentTokens = new Set(
        queryIntent
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 2),
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
        if (
          /recaptcha|captcha|csrf|token$|consent|badge|drawer|header-action|logging|telemetry/i.test(
            url,
          )
        ) {
          schemaBonus -= 20;
        }
        return { ...r, score: r.score + schemaBonus };
      });
      epRanked.sort((a, b) => b.score - a.score);
    }
    epRanked = dedupeObservedOverBundle(epRanked);

    const hasInternalApiCandidate = epRanked.some(
      (r) => !r.endpoint.dom_extraction && r.endpoint.method !== "WS",
    );
    const hasObservedApiCandidate = epRanked.some(
      (r) =>
        !r.endpoint.dom_extraction &&
        r.endpoint.method !== "WS" &&
        !/inferred from js bundle/i.test(r.endpoint.description ?? ""),
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
        } catch {
          /* ignore */
        }
      }
      const endpointBindings = resolveEndpointTemplateBindings(
        r.endpoint,
        resolvedParams,
        context?.url,
      );
      const missing = missingTemplateParams(r.endpoint, endpointBindings);
      if (missing.length === 0) readinessBonus += 40;
      else {
        const syncSatisfiable = missing.filter((name) => inferDefaultParam(name, queryIntent) !== undefined);
        const remaining = missing.length - syncSatisfiable.length;
        // Sync-resolvable params get full bonus; remaining params get partial credit
        // if we have an intent (LLM can likely resolve them at execution time)
        if (remaining === 0) {
          readinessBonus += 8;
        } else if (queryIntent && remaining <= 4) {
          // Likely LLM-resolvable — small penalty instead of catastrophic one
          readinessBonus += 4 - (remaining * 5);
        } else {
          readinessBonus -= missing.length * 25;
        }
      }
      if (r.endpoint.method === "GET" || r.endpoint.idempotency === "safe") readinessBonus += 15;
      if (r.endpoint.response_schema || r.endpoint.dom_extraction) readinessBonus += 10;
      if (!r.endpoint.dom_extraction && r.endpoint.method !== "WS") readinessBonus += 20;
      if (inferredFromBundle) readinessBonus -= 20;
      if (hasObservedApiCandidate && inferredFromBundle) readinessBonus -= 45;
      if (hasInternalApiCandidate && r.endpoint.dom_extraction) readinessBonus -= 35;
      if (hasInternalApiCandidate && isDocumentRoute) readinessBonus -= 80;
      if (isSearchLikeIntent(queryIntent, context?.url)) {
        const isCapturedPageArtifact = /captured page artifact/i.test(r.endpoint.description ?? "");
        if (endpointHasSearchBindings(r.endpoint)) readinessBonus += 70;
        if (endpointHasSearchBindings(r.endpoint) && r.endpoint.trigger_url) readinessBonus += 20;
        if (isCapturedPageArtifact) readinessBonus -= 55;
      }
      if (r.endpoint.trigger_url && context?.url) {
        try {
          if (new URL(r.endpoint.trigger_url).pathname === new URL(context.url).pathname)
            readinessBonus += 5;
        } catch {
          /* ignore */
        }
      }
      return { ...r, score: r.score + readinessBonus };
    });
    epRanked.sort((a, b) => b.score - a.score);
    epRanked = prioritizeIntentMatchedApis(epRanked, queryIntent, context?.url);

    // --- DAG advisory boosts (discover-choose-act) ---
    // Backend-first advisory call: tries the EmergentDB graph for cross-session
    // intelligence, falls back to local planner if backend is unavailable.
    if (epRanked.length > 1 && skill.domain) {
      const bindings = Object.keys(knownBindingsFromInputs(resolvedParams, context?.url));
      const dagPlan = await fetchDagAdvisoryPlan(
        skill,
        epRanked[0].endpoint.endpoint_id,
        bindings,
      );
      if (dagPlan) {
        epRanked = applyDagAdvisoryBoosts(epRanked, dagPlan);
        (decisionTrace as Record<string, unknown>).dag_advisory = {
          chain_ready: dagPlan.chain_ready,
          predicted_next: dagPlan.predicted_next,
          auth_dependencies: dagPlan.auth_dependencies,
        };
      }
    }
    // --- end DAG advisory ---

    // --- Auth prerequisite gate ---
    // When the top candidate targets an auth-gated endpoint, resolve auth
    // via the runtime before attempting execution.
    if (epRanked.length > 0) {
      const topEndpoint = epRanked[0].endpoint;
      const authDeps = deriveAuthDependencies(skill, topEndpoint.endpoint_id);
      if (authDeps.length > 0) {
        const authResults = await resolveAuthPrerequisites(authDeps);
        const allAuthed = authResults.every((r) => r.authenticated);
        (decisionTrace as Record<string, unknown>).auth_prerequisites = {
          dependencies: authDeps.map((d) => ({ domain: d.domain, strategy: d.strategy })),
          resolved: allAuthed,
        };
        if (!allAuthed) {
          console.log(`[auth] auth prerequisite unresolved for ${skill.domain} — continuing with best effort`);
        }
      }
    }
    // --- end auth prerequisite gate ---

    // Try top candidates in order until one succeeds. If all fail, fall through to deferral.
    const ready = epRanked.filter((r) => canAutoExecuteEndpoint(r.endpoint));
    const tryList =
      ready.length > 0
        ? [...ready, ...epRanked.filter((r) => !canAutoExecuteEndpoint(r.endpoint))]
        : epRanked;
    const MAX_TRIES = Math.min(tryList.length, 5);
    const deterministicStructuredSearchLeader =
      /\b(search|find|lookup|browse|discover)\b/i.test(queryIntent) &&
      !!epRanked[0] &&
      endpointHasSearchBindings(epRanked[0].endpoint) &&
      (!!epRanked[0].endpoint.dom_extraction || !!epRanked[0].endpoint.response_schema);
    const agentOrder =
      !agentChoseEndpoint && tryList.length > 1 && !deterministicStructuredSearchLeader
        ? await agentSelectEndpoint(queryIntent, skill, tryList.slice(0, MAX_TRIES), context?.url)
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
      console.log(
        `[auto-exec] trying #${i + 1}: ${candidate.endpoint.endpoint_id} score=${candidate.score.toFixed(1)}`,
      );
      try {
        const endpointParams = mergeContextTemplateParams(
          resolvedParams,
          candidate.endpoint.url_template,
          context?.url,
        );
        const templateDefaults: Record<string, string | number | boolean> = {
          ...(candidate.endpoint.path_params ?? {}),
          ...(candidate.endpoint.body_params ?? {}),
        };
        const searchOverrides = inferSearchParamOverrides(candidate.endpoint, intent, params);
        const inferredOptionalParams: Record<string, string | number | boolean> = {};
        const inferredType = inferDefaultParam("type", queryIntent);
        if (
          inferredType !== undefined &&
          endpointParams.type == null &&
          /\/(search|lookup|find)\b/i.test(candidate.endpoint.url_template)
        ) {
          inferredOptionalParams.type = inferredType;
        }
        // Sync inference for simple params (pagination, type, etc.)
        const syncInferred = Object.fromEntries(
          [...candidate.endpoint.url_template.matchAll(/\{([^}]+)\}/g)]
            .map((m) => m[1])
            .filter((name) => endpointParams[name] == null || endpointParams[name] === "")
            .map((name) => [name, inferDefaultParam(name, queryIntent)] as const)
            .filter(
              (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
            ),
        );
        // LLM inference for remaining unbound params (search queries, locations, dates, etc.)
        const allBound = {
          ...templateDefaults,
          ...endpointParams,
          ...syncInferred,
          ...searchOverrides,
          ...inferredOptionalParams,
        };
        const stillUnbound = [...candidate.endpoint.url_template.matchAll(/\{([^}]+)\}/g)]
          .map((m) => m[1])
          .filter((name) => allBound[name] == null || allBound[name] === "");
        let llmInferred: Record<string, string> = {};
        if (stillUnbound.length > 0 && queryIntent) {
          llmInferred = await inferParamsFromIntent(
            candidate.endpoint.url_template,
            queryIntent,
            stillUnbound,
            candidate.endpoint.description,
          );
        }
        const execOut = await executeSkill(
          skill,
          {
            ...templateDefaults,
            ...endpointParams,
            ...syncInferred,
            ...searchOverrides,
            ...llmInferred,
            ...inferredOptionalParams,
            endpoint_id: candidate.endpoint.endpoint_id,
            ...(queryIntent !== intent ? { intent: queryIntent } : {}),
          },
          projection,
          { ...options, intent: queryIntent, contextUrl: context?.url },
        );
        timing.execute_ms = Date.now() - te0;
        if (execOut.trace.success) {
          const localAssessment = assessLocalExecutionResult(
            candidate.endpoint,
            execOut.result,
            queryIntent,
            execOut.trace,
          );
          if (localAssessment.verdict === "fail") {
            (decisionTrace.autoexec_attempts as unknown[]).push({
              endpoint_id: candidate.endpoint.endpoint_id,
              score: Math.round(candidate.score * 10) / 10,
              trace_success: true,
              judge: "fail",
              status_code: execOut.trace.status_code ?? null,
              local_reason: localAssessment.reason,
            });
            console.log(
              `[auto-exec] #${i + 1} local fail: ${candidate.endpoint.endpoint_id} (${localAssessment.reason})`,
            );
            continue;
          }
          const isCapturedPageArtifact = /captured page artifact/i.test(
            candidate.endpoint.description ?? "",
          );
          if (candidate.endpoint.dom_extraction && isCapturedPageArtifact && localAssessment.verdict !== "pass") {
            (decisionTrace.autoexec_attempts as unknown[]).push({
              endpoint_id: candidate.endpoint.endpoint_id,
              score: Math.round(candidate.score * 10) / 10,
              trace_success: true,
              judge: "fail",
              status_code: execOut.trace.status_code ?? null,
              local_reason: `artifact_${localAssessment.reason}`,
            });
            console.log(
              `[auto-exec] #${i + 1} local fail: ${candidate.endpoint.endpoint_id} (artifact_${localAssessment.reason})`,
            );
            continue;
          }
          // For DOM extraction endpoints, trust the local assessment more — the LLM judge
          // often fails on DOM-extracted data because the schema (heading_1, heading_2, etc.)
          // looks unfamiliar. If the extraction succeeded and wasn't locally rejected, pass it.
          const trustDomExtraction =
            candidate.endpoint.dom_extraction &&
            !isCapturedPageArtifact &&
            localAssessment.verdict !== "fail" &&
            candidate.score >= 0;
          const judged =
            localAssessment.verdict === "pass" || trustDomExtraction
              ? "pass"
              : agentJudgeExecution(intent, candidate.endpoint, execOut.result);
          (decisionTrace.autoexec_attempts as unknown[]).push({
            endpoint_id: candidate.endpoint.endpoint_id,
            score: Math.round(candidate.score * 10) / 10,
            trace_success: true,
            judge: judged,
            status_code: execOut.trace.status_code ?? null,
            local_reason: localAssessment.reason,
          });
          if (judged !== "pass") {
            console.log(
              `[auto-exec] #${i + 1} rejected: ${candidate.endpoint.endpoint_id} (${judged})`,
            );
            recordDagNegative(skill, candidate.endpoint.endpoint_id);
            continue;
          }
          cacheResolvedSkill(cacheKey, skill, candidate.endpoint.endpoint_id);
          recordDagSessionAction(skill, candidate.endpoint.endpoint_id, true);
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
          );
          // --- Store successful execution trace for future RAG retrieval ---
          try {
            const endpointSeq = (decisionTrace.autoexec_attempts as { endpoint_id: string }[])
              .map(a => a.endpoint_id);
            storeExecutionTrace({
              trace_id: execOut.trace.trace_id ?? nanoid(),
              domain: skill.domain,
              intent: queryIntent,
              endpoint_sequence: endpointSeq,
              selected_endpoint_id: candidate.endpoint.endpoint_id,
              params: resolvedParams,
              success: true,
              timestamp: new Date().toISOString(),
              duration_ms: timing.execute_ms,
              context_url: context?.url,
            });
          } catch {
            // Trace storage must never block the execution path
          }
          // Prefetch related endpoints via parent_child edges
          let prefetched: import("../capture/prefetch.js").PrefetchResult[] = [];
          try {
            const execGraph = ensureSkillOperationGraph(skill);
            const resolvedOp = execGraph.operations.find(op => op.endpoint_id === candidate.endpoint.endpoint_id);
            if (resolvedOp) {
              const prefetchTargets = getPrefetchTargets(execGraph, resolvedOp.operation_id, resolvedParams);
              if (prefetchTargets.length > 0) {
                console.log(`[prefetch] ${prefetchTargets.length} target(s) for ${candidate.endpoint.endpoint_id}`);
                prefetched = await executePrefetch(skill, prefetchTargets, resolvedParams);
                console.log(`[prefetch] ${prefetched.filter(r => r.success).length}/${prefetched.length} succeeded`);
              }
            }
          } catch (prefetchErr) {
            console.log(`[prefetch] error: ${(prefetchErr as Error).message}`);
          }
          // --- Payment gate: only for marketplace-sourced paid skills ---
          if (source === "marketplace" && skill.base_price_usd && skill.base_price_usd > 0) {
            try {
              const walletCheck = checkWalletConfigured();
              const wallet = getLocalWalletContext();
              const paymentResult = await checkPaymentRequirement(
                skill.skill_id,
                candidate.endpoint.endpoint_id,
                {
                  price_usd: String(skill.base_price_usd),
                  wallet_configured: walletCheck.configured,
                },
              );
              if (paymentResult.status !== "free" && paymentResult.status !== "paid") {
                // Apply indexing fallback for unpaid users — they can still capture and contribute
                const { resolveUnpaidAccess } = await import("../payments/index.js");
                const fallback = resolveUnpaidAccess(paymentResult);
                if (fallback.status === "indexing_fallback") {
                  console.log(`[payment] ${skill.skill_id}: unpaid, falling back to indexing mode`);
                  // Allow execution but tag result as indexing-mode
                } else {
                  return {
                    result: {
                      error: "payment_required",
                      price_usd: skill.base_price_usd,
                      payment_status: paymentResult.status,
                      message: paymentResult.message,
                      next_step: paymentResult.next_step,
                      wallet_provider: wallet.wallet_provider ?? "lobster.cash",
                      wallet_address: wallet.wallet_address,
                      indexing_fallback_available: true,
                    },
                    trace: execOut.trace,
                    source,
                    skill,
                    timing: finalize(source, null, skill.skill_id, skill, execOut.trace),
                  };
                }
              }
            } catch (payErr) {
              console.warn(`[payment] check failed, proceeding without payment gate: ${(payErr as Error).message}`);
            }
          }
          // --- end payment gate ---
          return {
            result: prefetched.length > 0 ? {
              ...(typeof execOut.result === "object" && execOut.result !== null ? execOut.result as Record<string, unknown> : { data: execOut.result }),
              prefetched: prefetched.filter(r => r.success).map(r => ({
                endpoint_id: r.endpoint_id,
                action_kind: r.action_kind,
                resource_kind: r.resource_kind,
                data: r.data,
              })),
            } : execOut.result,
            trace: execOut.trace,
            source,
            skill,
            timing: finalize(source, execOut.result, skill.skill_id, skill, execOut.trace),
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
    // --- Store failed execution trace for future RAG retrieval ---
    try {
      const endpointSeq = (decisionTrace.autoexec_attempts as { endpoint_id: string }[])
        .map(a => a.endpoint_id);
      storeExecutionTrace({
        trace_id: nanoid(),
        domain: skill.domain,
        intent: queryIntent,
        endpoint_sequence: endpointSeq,
        params: resolvedParams,
        success: false,
        timestamp: new Date().toISOString(),
        duration_ms: timing.execute_ms,
        context_url: context?.url,
      });
    } catch {
      // Trace storage must never block the execution path
    }
    return null; // All candidates failed, fall through to deferral
  }

  const requestedDomain = context?.domain ?? (context?.url ? new URL(context.url).hostname : null);
  const requestedDomainCacheKey = getDomainReuseKey(context?.url ?? requestedDomain);
  const resolveCacheKey = buildResolveCacheKey(requestedDomain, intent, context?.url);
  const cacheKey = scopedCacheKey(clientScope, resolveCacheKey);

  if (!forceCapture && !agentChoseEndpoint) {
    const cachedResult = routeResultCache.get(cacheKey);
    if (cachedResult) {
      if (!shouldReuseRouteResultSnapshot(cachedResult, queryIntent, context?.url)) {
        routeResultCache.delete(cacheKey);
      } else {
        timing.cache_hit = true;
        writeDebugTrace("resolve", {
          ...decisionTrace,
          outcome: "route_result_cache_hit",
          source: "route-cache",
          skill_id: cachedResult.skill.skill_id,
          selected_endpoint_id: cachedResult.endpointId ?? cachedResult.trace.endpoint_id,
        });
        return buildCachedResultResponse(
          cachedResult,
          "marketplace",
          finalize(
            "route-cache",
            cachedResult.result,
            cachedResult.skill.skill_id,
            cachedResult.skill,
            cachedResult.trace,
          ),
        );
      }
    }
  }

  // Route-cache fast path: exact intent+url match from prior resolve
  if (!forceCapture && !agentChoseEndpoint) {
    const routeCacheCandidates: RouteCacheCandidate[] = [];
    for (const scopedKey of scopedResolveCacheKeys(clientScope, resolveCacheKey)) {
      const cached = skillRouteCache.get(scopedKey);
      if (!cached) continue;
      if (Date.now() - cached.ts >= ROUTE_CACHE_TTL) {
        skillRouteCache.delete(scopedKey);
        persistRouteCache();
        continue;
      }
      const skill =
        readSkillSnapshot(cached.localSkillPath) ??
        await getSkillWithTimeout(cached.skillId, clientScope);
      if (!skill || !isCachedSkillRelevantForIntent(skill, queryIntent, context?.url)) {
        skillRouteCache.delete(scopedKey);
        persistRouteCache();
        continue;
      }
      routeCacheCandidates.push({
        scopedKey,
        scope: scopedKey.slice(0, scopedKey.indexOf(":")),
        entry: cached,
        skill,
      });
    }
    const bestCached = chooseBestRouteCacheCandidate(routeCacheCandidates, queryIntent, context?.url);
    if (bestCached) {
      if (bestCached.scopedKey !== cacheKey) {
        promoteLearnedSkill(
          clientScope,
          resolveCacheKey,
          bestCached.skill,
          bestCached.entry.endpointId,
          context?.url,
        );
      }
      const deferred = await buildDeferralWithAutoExec(bestCached.skill, "marketplace");
      if (shouldFallbackToLiveCaptureAfterAutoexecFailure(deferred.autoexecFailedAll, context?.url)) {
        console.log("[route-cache] stale cached skill; retrying via live capture");
        invalidateResolveCacheEntries(
          [cacheKey, bestCached.scopedKey],
          requestedDomainCacheKey ? [requestedDomainCacheKey] : [],
        );
      } else {
        timing.cache_hit = true;
        deferred.orchestratorResult.timing.cache_hit = true;
        return deferred.orchestratorResult;
      }
    }
  }

  // Domain-level cache: different intent, same domain → reuse skill with new params
  if (!forceCapture && !agentChoseEndpoint && requestedDomain) {
    const domainKey = getDomainReuseKey(context?.url ?? requestedDomain);
    const domainCached = domainKey ? domainSkillCache.get(domainKey) : null;
    if (domainCached && Date.now() - domainCached.ts < 7 * 24 * 60 * 60_000) {
      const skill = readSkillSnapshot(domainCached.localSkillPath) ?? await getSkill(domainCached.skillId, clientScope);
      if (skill && isCachedSkillRelevantForIntent(skill, queryIntent, context?.url)) {
        console.log(`[domain-cache] hit for ${domainKey} → skill ${skill.skill_id.slice(0, 15)}`);
        const result = await buildDeferralWithAutoExec(skill, "marketplace");
        if (shouldFallbackToLiveCaptureAfterAutoexecFailure(result.autoexecFailedAll, context?.url)) {
          console.log(`[domain-cache] stale skill for ${domainKey}; retrying via live capture`);
          invalidateResolveCacheEntries([cacheKey], [domainKey]);
        } else {
          timing.cache_hit = true;
          result.orchestratorResult.timing.cache_hit = true;
          return result.orchestratorResult;
        }
      } else if (skill) {
        const ranked = rankEndpoints(skill.endpoints, queryIntent, skill.domain, context?.url);
        const top = ranked[0];
        console.log(
          `[domain-cache] skip ${domainKey}: no relevant endpoint for "${queryIntent}"` +
            (top ? ` (${top.endpoint.endpoint_id} score=${top.score.toFixed(1)})` : ""),
        );
      }
    }

    const localDomainSkill = findBestLocalDomainSnapshot(requestedDomain, queryIntent, context?.url);
    if (localDomainSkill) {
      console.log(`[local-snapshot] hit for ${requestedDomain} → skill ${localDomainSkill.skill_id.slice(0, 15)}`);
      const result = await buildDeferralWithAutoExec(localDomainSkill, "marketplace");
      if (shouldFallbackToLiveCaptureAfterAutoexecFailure(result.autoexecFailedAll, context?.url)) {
        console.log(`[local-snapshot] stale skill for ${requestedDomain}; retrying via live capture`);
      } else {
        timing.cache_hit = true;
        result.orchestratorResult.timing.cache_hit = true;
        promoteLearnedSkill(clientScope, cacheKey, localDomainSkill, result.orchestratorResult.trace.endpoint_id, context?.url);
        return result.orchestratorResult;
      }
    }
  }

  // --- Agent explicitly chose an endpoint — execute directly via any cache/skill path ---
  if (!forceCapture && agentChoseEndpoint) {
    // Route cache
    const routeCacheCandidates: RouteCacheCandidate[] = [];
    for (const scopedKey of scopedResolveCacheKeys(clientScope, resolveCacheKey)) {
      const cached = skillRouteCache.get(scopedKey);
      if (!cached) continue;
      if (Date.now() - cached.ts >= ROUTE_CACHE_TTL) {
        skillRouteCache.delete(scopedKey);
        persistRouteCache();
        continue;
      }
      const skill =
        readSkillSnapshot(cached.localSkillPath) ??
        await getSkillWithTimeout(cached.skillId, clientScope);
      if (!skill) continue;
      routeCacheCandidates.push({
        scopedKey,
        scope: scopedKey.slice(0, scopedKey.indexOf(":")),
        entry: cached,
        skill,
      });
    }
    const cached = chooseBestRouteCacheCandidate(routeCacheCandidates, queryIntent, context?.url);
    if (cached) {
      if (cached.scopedKey !== cacheKey) {
        promoteLearnedSkill(
          clientScope,
          resolveCacheKey,
          cached.skill,
          cached.entry.endpointId,
          context?.url,
        );
      }
      const skill = cached.skill;
      if (skill) {
        const te0 = Date.now();
        try {
          const execOut = await executeSkill(
            skill,
            { ...params, endpoint_id: params.endpoint_id ?? cached.entry.endpointId, ...(queryIntent !== intent ? { intent: queryIntent } : {}) },
            projection,
            { ...options, intent: queryIntent, contextUrl: context?.url },
          );
          timing.execute_ms = Date.now() - te0;
          if (execOut.trace.success && isAcceptableIntentResult(execOut.result, queryIntent)) {
              timing.cache_hit = true;
            promoteResultSnapshot(
              cacheKey,
              skill,
              params.endpoint_id ?? cached.entry.endpointId,
              execOut.result,
              execOut.trace,
            );
            return {
              result: execOut.result,
              trace: execOut.trace,
              source: "marketplace",
              skill,
              timing: finalize("route-cache", execOut.result, cached.entry.skillId, skill, execOut.trace),
            };
          }
        } catch {
          timing.execute_ms = Date.now() - te0;
        }
      }
      skillRouteCache.delete(cached.scopedKey);
    }
  }

  if (!forceCapture && !agentChoseEndpoint && requestedDomain) {
    const localSnapshot = findBestLocalDomainSnapshot(requestedDomain, queryIntent, context?.url);
    if (localSnapshot) {
      console.log(`[local-snapshot:default] hit for ${requestedDomain} → skill ${localSnapshot.skill_id.slice(0, 15)}`);
      const deferred = await buildDeferralWithAutoExec(localSnapshot, "marketplace");
      if (shouldFallbackToLiveCaptureAfterAutoexecFailure(deferred.autoexecFailedAll, context?.url)) {
        console.log(`[local-snapshot:default] stale skill for ${requestedDomain}; retrying via live capture`);
      } else {
        timing.cache_hit = true;
        deferred.orchestratorResult.timing.cache_hit = true;
        promoteLearnedSkill(
          clientScope,
          cacheKey,
          localSnapshot,
          deferred.orchestratorResult.trace.endpoint_id,
          context?.url,
        );
        return deferred.orchestratorResult;
      }
    }
  }

  const shouldBypassBrowserFirstPass = shouldBypassLiveCaptureQueue(context?.url);

  // --- Fast path: URL given, no local cache → skip marketplace, go straight to browser ---
  // Marketplace search can take 10-60s+ and blocks the agent. When we have a URL,
  // the browser can achieve the goal via UI immediately while indexing passively.
  // Marketplace search runs in the background to populate cache for next time.
  if (context?.url && !agentChoseEndpoint && !forceCapture && !shouldBypassBrowserFirstPass) {
    console.log(`[fast-path] no local cache for ${requestedDomain} — skipping marketplace, going to browser`);

    // Fire-and-forget: marketplace search populates cache for future resolves
    void (async () => {
      try {
        const { domain_results, global_results } = await searchIntentResolve(
          queryIntent, requestedDomain ?? undefined,
          MARKETPLACE_DOMAIN_SEARCH_K, MARKETPLACE_GLOBAL_SEARCH_K,
        );
        const totalResults = domain_results.length + global_results.length;
        if (totalResults > 0) {
          console.log(`[fast-path:bg] marketplace found ${totalResults} candidates — will be cached for next resolve`);
        }
      } catch { /* marketplace down — doesn't matter, browser is working */ }
    })();

    // Jump straight to first-pass browser action (8s) then browse session handoff
    const firstPassResult = await tryFirstPassBrowserAction(
      intent, params, context.url,
      { signal: options?.signal, clientScope: options?.client_scope },
    );
    decisionTrace.first_pass = {
      intentClass: firstPassResult.intentClass,
      actionTaken: firstPassResult.actionTaken,
      hit: firstPassResult.hit,
      interceptedCount: firstPassResult.interceptedEntries.length,
      timeMs: firstPassResult.timeMs,
      fast_path: true,
    };
    if (firstPassResult.hit && firstPassResult.miniSkill) {
      const fpNow = new Date().toISOString();
      const trace: ExecutionTrace = {
        trace_id: nanoid(),
        skill_id: firstPassResult.miniSkill.skill_id,
        endpoint_id: firstPassResult.miniSkill.endpoints[0]?.endpoint_id ?? "",
        started_at: fpNow,
        completed_at: fpNow,
        success: true,
        network_events: firstPassResult.interceptedEntries,
      };
      return {
        result: firstPassResult.result,
        trace,
        source: "first-pass",
        skill: firstPassResult.miniSkill,
        timing: finalize("first-pass", firstPassResult.result, firstPassResult.miniSkill.skill_id, firstPassResult.miniSkill, trace),
      };
    }
    console.log(`[fast-path] first-pass miss — opening browse session for agent`);

    // Browse session handoff — agent drives with snap/click/fill/close
    if (firstPassResult.tabId && context.url) {
      const tabId = firstPassResult.tabId;
      const domain = new URL(context.url).hostname.replace(/^www\./, "");
      try {
        const { extractBrowserCookies } = await import("../auth/browser-cookies.js");
        const { cookies } = extractBrowserCookies(domain);
        for (const c of cookies) await kuri.setCookie(tabId, c).catch(() => {});
      } catch { /* non-fatal */ }
      await kuri.evaluate(tabId, (await import("../capture/index.js")).INTERCEPTOR_SCRIPT).catch(() => {});
      await kuri.harStart(tabId).catch(() => {});
      try {
        const routesModule = await import("../api/routes.js");
        if (typeof routesModule.registerBrowseSession === "function") {
          routesModule.registerBrowseSession(tabId, context.url, domain);
        }
      } catch { /* routes module may not expose this yet */ }
      const fpNow = new Date().toISOString();
      const trace: ExecutionTrace = {
        trace_id: nanoid(),
        skill_id: "browse-session",
        endpoint_id: "",
        started_at: fpNow,
        completed_at: fpNow,
        success: true,
      };
      return {
        result: {
          status: "browse_session_open",
          tab_id: tabId,
          url: context.url,
          domain,
          next_step: "unbrowse snap",
          commands: [
            "unbrowse snap --filter interactive",
            "unbrowse click <ref>",
            "unbrowse fill <ref> <value>",
            "unbrowse close",
          ],
        },
        trace,
        source: "browser-action" as any,
        skill: undefined as any,
        timing: finalize("browser-action" as any, null, "browse-session", undefined as any, trace),
      };
    }
  }


  // --- Marketplace search with hard timeout ---
  // When a URL is available, cap marketplace search at 5s. Beyond that, browser is faster.
  const MARKETPLACE_TIMEOUT_MS = context?.url ? 5_000 : 30_000;

  if (!forceCapture) {
    // 1. Search marketplace — single remote call, capped by timeout when URL available
    const ts0 = Date.now();
    type SearchResult = { id: number; score: number; metadata: Record<string, unknown> };
    let searchResponse: {
      domain_results: SearchResult[];
      global_results: SearchResult[];
      skipped_global: boolean;
      actual_cost_uc?: number;
    };
    try {
      searchResponse = await Promise.race([
        searchIntentResolve(
          queryIntent,
          requestedDomain ?? undefined,
          MARKETPLACE_DOMAIN_SEARCH_K,
          MARKETPLACE_GLOBAL_SEARCH_K,
        ),
        new Promise<{ domain_results: SearchResult[]; global_results: SearchResult[]; skipped_global: boolean; actual_cost_uc?: number }>((resolve) =>
          setTimeout(() => {
            console.log(`[marketplace] timeout after ${MARKETPLACE_TIMEOUT_MS}ms — falling through to browser`);
            resolve({ domain_results: [], global_results: [], skipped_global: true });
          }, MARKETPLACE_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      if (isX402Error(err)) {
        const localCanonicalSkill =
          context?.url && !isSearchLikeIntent(queryIntent, context.url)
            ? buildLocalCanonicalReplaySkill(queryIntent, context.url)
            : undefined;
        if (localCanonicalSkill) {
          const deferred = await buildDeferralWithAutoExec(localCanonicalSkill, "marketplace", {
            local_canonical_replay: true,
            payment_bypass: "canonical-detail-page",
          });
          return deferred.orchestratorResult;
        }
        const trace: ExecutionTrace = {
          trace_id: nanoid(),
          skill_id: "marketplace-search",
          endpoint_id: "search",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: false,
          status_code: 402,
          error: "payment_required",
        };
        return {
          result: {
            error: "payment_required",
            payment_status: "payment_required",
            wallet_provider: getLocalWalletContext().wallet_provider ?? "lobster.cash",
            wallet_address: getLocalWalletContext().wallet_address,
            message: "Marketplace search requires payment before shared graph results are returned.",
            next_step: "Pay the Tier 3 search fee, or re-run with force capture for free local discovery.",
            indexing_fallback_available: true,
            tier: "tier3",
            terms: err.terms,
          },
          trace,
          source: "marketplace",
          skill: undefined as any,
          timing: finalize("marketplace", null, undefined, undefined, trace),
        };
      }
      searchResponse = {
        domain_results: [] as SearchResult[],
        global_results: [] as SearchResult[],
        skipped_global: false,
      };
    }
    if (typeof searchResponse.actual_cost_uc === "number" && searchResponse.actual_cost_uc > 0) {
      timing.paid_search_uc = searchResponse.actual_cost_uc;
    }
    const { domain_results: domainResults, global_results: globalResults } = searchResponse;
    timing.search_ms = Date.now() - ts0;
    console.log(`[marketplace] search: ${domainResults.length} domain + ${globalResults.length} global results (${timing.search_ms}ms)`);

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
    type RankedCandidate = {
      candidate: (typeof candidates)[0];
      skill: SkillManifest;
      composite: number;
      endpointId?: string;
    };
    const tg0 = Date.now();
    const uniqueSkillIds = selectSkillIdsToHydrate(candidates, requestedDomain, MARKETPLACE_HYDRATE_LIMIT);
    const skillMap = new Map<string, SkillManifest>();
    await Promise.all(
      uniqueSkillIds.map(async (skillId) => {
        const skill = await getSkillWithTimeout(skillId, clientScope);
        if (skill) skillMap.set(skillId, skill);
      }),
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
      if (!isCachedSkillRelevantForIntent(skill, queryIntent, context?.url)) continue;
      if (!marketplaceSkillMatchesContext(skill, queryIntent, context?.url)) continue;
      if (targetRegDomain && getRegistrableDomain(skill.domain) !== targetRegDomain) continue;
      const endpointId = extractEndpointId(c.metadata) ?? undefined;
      ranked.push({
        candidate: c,
        skill,
        composite: computeCompositeScore(c.score, skill),
        endpointId,
      });
    }
    ranked.sort((a, b) => b.composite - a.composite);

    // If marketplace found viable skills, defer to the agent unless they already chose an endpoint.
    const viable = ranked.filter((c) => c.composite >= CONFIDENCE_THRESHOLD).slice(0, 3);
    timing.candidates_tried = viable.length;
    console.log(`[marketplace] viable=${viable.length}/${ranked.length} candidates (threshold=${CONFIDENCE_THRESHOLD}), top=${viable[0]?.composite?.toFixed(1) ?? "n/a"} skill=${viable[0]?.skill?.skill_id?.slice(0,10) ?? "n/a"}`);
    if (viable.length > 0) {
      if (agentChoseEndpoint) {
        // Agent already picked an endpoint — race top candidates to execute it
        const te0 = Date.now();
        try {
          const winner = await Promise.any(
            viable.map((candidate, i) =>
              Promise.race([
                executeSkill(candidate.skill, params, projection, {
                  ...options,
                  intent: queryIntent,
                  contextUrl: context?.url,
                })
                  .then((execOut) => {
                    if (!execOut.trace.success) {
                      console.log(
                        `[race] candidate ${i} (${candidate.skill.skill_id}) failed: status=${execOut.trace.status_code}`,
                      );
                      throw new Error("execution failed");
                    }
                    return { ...execOut, candidate };
                  })
                  .catch((err) => {
                    console.log(
                      `[race] candidate ${i} (${candidate.skill.skill_id}) error: ${(err as Error).message}`,
                    );
                    throw err;
                  }),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("timeout")), 30_000),
                ),
              ]),
            ),
          );
          timing.execute_ms = Date.now() - te0;
          cacheResolvedSkill(
            cacheKey,
            winner.candidate.skill,
            winner.trace.endpoint_id,
          );
          promoteResultSnapshot(
            cacheKey,
            winner.candidate.skill,
            winner.trace.endpoint_id,
            winner.result,
            winner.trace,
          );
          return {
            result: winner.result,
            trace: winner.trace,
            source: "marketplace" as const,
            skill: winner.candidate.skill,
            timing: finalize(
              "marketplace",
              winner.result,
              winner.candidate.skill.skill_id,
              winner.candidate.skill,
              winner.trace,
            ),
          };
        } catch (err) {
          console.log(
            `[race] all candidates failed after ${Date.now() - te0}ms: ${(err as Error).message}`,
          );
          timing.execute_ms = Date.now() - te0;
        }
      } else {
        const best = viable[0];
        // Endpoint-level search hits are only hints. Resolve returns them; execute happens only
        // after the agent explicitly chooses an endpoint.
        if (best.endpointId) {
          console.log(
            `[search] endpoint-level hit hint: ${best.endpointId} score=${best.candidate.score.toFixed(3)}`,
          );
        }
        const deferred = await buildDeferralWithAutoExec(best.skill, "marketplace");
        if (!shouldFallbackToLiveCaptureAfterAutoexecFailure(deferred.autoexecFailedAll, context?.url)) {
          return deferred.orchestratorResult;
        }
        console.log("[marketplace] stale top skill; retrying via live capture");
      }
    }
  } // end !forceCapture

  // 1.4 Direct JSON fetch: if URL looks like a raw API endpoint, try fetching directly
  if (context?.url && (
    /\.(json|xml)(\?|$)|\/api\/|\/v\d+\//.test(context.url) ||
    /[?&]format=(j\d*|json)\b/i.test(context.url) ||
    /^https?:\/\/api\./i.test(context.url)
  )) {
    try {
      const directRes = await fetch(context.url, {
        headers: { "Accept": "application/json", "User-Agent": "unbrowse/1.0" },
        signal: AbortSignal.timeout(5000),
        redirect: "follow",
      });
      const ct = directRes.headers.get("content-type") ?? "";
      if (directRes.ok && (ct.includes("json") || ct.includes("+json"))) {
        const data = await directRes.json();
        const trace: ExecutionTrace = {
          trace_id: nanoid(),
          skill_id: "direct-fetch",
          endpoint_id: "direct-fetch",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: true,
        };
        const t = finalize("direct-fetch", data, "direct-fetch", undefined as any, trace);
        console.log(`[direct-fetch] ${context.url} returned JSON directly — skipping browser`);
        return {
          result: data,
          trace,
          source: "direct-fetch" as any,
          skill: undefined as any,
          timing: t,
        };
      }
    } catch { /* not a direct JSON API — continue to browser */ }
  }

  // 1.5 First-pass browser action: lightweight 8s attempt before full capture
  if (context?.url && !forceCapture && !shouldBypassBrowserFirstPass) {
    const firstPassResult = await tryFirstPassBrowserAction(
      intent, params, context.url,
      { signal: options?.signal, clientScope: options?.client_scope },
    );
    decisionTrace.first_pass = {
      intentClass: firstPassResult.intentClass,
      actionTaken: firstPassResult.actionTaken,
      hit: firstPassResult.hit,
      interceptedCount: firstPassResult.interceptedEntries.length,
      timeMs: firstPassResult.timeMs,
    };
    if (firstPassResult.hit && firstPassResult.miniSkill) {
      const fpNow = new Date().toISOString();
      const trace: ExecutionTrace = {
        trace_id: nanoid(),
        skill_id: firstPassResult.miniSkill.skill_id,
        endpoint_id: firstPassResult.miniSkill.endpoints[0]?.endpoint_id ?? "",
        started_at: fpNow,
        completed_at: fpNow,
        success: true,
        network_events: firstPassResult.interceptedEntries,
      };
      const t = finalize(
        "first-pass", firstPassResult.result,
        firstPassResult.miniSkill.skill_id,
        firstPassResult.miniSkill, trace,
      );
      return {
        result: firstPassResult.result,
        trace,
        source: "first-pass",
        skill: firstPassResult.miniSkill,
        timing: t,
      };
    }
    console.log(`[first-pass] miss (${firstPassResult.intentClass}/${firstPassResult.actionTaken}) — opening browse session for agent`);

    // Phase 4: Browse session handoff — open a browser session with auth,
    // interceptor, and HAR, then tell the calling agent to drive it.
    // The agent uses snap/click/fill/close. All traffic is passively indexed.
    if (firstPassResult.tabId && context?.url) {
      const tabId = firstPassResult.tabId;
      const domain = new URL(context.url).hostname.replace(/^www\./, "");

      // Inject cookies from user Chrome + interceptor for full capture
      try {
        const { extractBrowserCookies } = await import("../auth/browser-cookies.js");
        const { cookies } = extractBrowserCookies(domain);
        for (const c of cookies) await kuri.setCookie(tabId, c).catch(() => {});
      } catch { /* non-fatal */ }
      await kuri.evaluate(tabId, (await import("../capture/index.js")).INTERCEPTOR_SCRIPT).catch(() => {});
      await kuri.harStart(tabId).catch(() => {});

      // Register this as an active browse session on the server
      // so snap/click/fill/close commands work against it
      try {
        const routesModule = await import("../api/routes.js");
        if (typeof routesModule.registerBrowseSession === "function") {
          routesModule.registerBrowseSession(tabId, context.url, domain);
        }
      } catch { /* routes module may not expose this yet */ }

      const fpNow = new Date().toISOString();
      const trace: ExecutionTrace = {
        trace_id: nanoid(),
        skill_id: "browse-session",
        endpoint_id: "",
        started_at: fpNow,
        completed_at: fpNow,
        success: true,
      };
      const t = finalize("browse-session", null, "browse-session", undefined as any, trace);
      return {
        result: {
          status: "browse_session_open",
          tab_id: tabId,
          url: context.url,
          domain,
          message: `No cached API for this intent. Browser session open with auth on ${domain}. Use unbrowse snap/click/fill to achieve your intent. All traffic is being passively captured and indexed — run unbrowse close when done.`,
          next_step: "unbrowse snap --filter interactive",
          commands: [
            "unbrowse snap --filter interactive",
            "unbrowse click <ref>",
            "unbrowse fill <ref> <value>",
            "unbrowse press Enter",
            "unbrowse scroll",
            "unbrowse text",
            "unbrowse close",
          ],
        },
        trace,
        source: "browse-session" as any,
        skill: undefined as any,
        timing: t,
      };
    }
  }
  // 2. No match (or force_capture) — invoke browser-capture skill
  if (!context?.url) {
    throw new Error(
      "No matching skill found. Pass context.url to trigger live capture and discovery.",
    );
  }

  const captureDomain = new URL(context.url).hostname;

  // Check recently-captured cache: avoids re-capturing when EmergentDB hasn't indexed yet
  const domainHit = !forceCapture ? capturedDomainCache.get(cacheKey) : undefined;
  if (domainHit && Date.now() < domainHit.expires) {
    if (!isCachedSkillRelevantForIntent(domainHit.skill, queryIntent, context?.url)) {
      capturedDomainCache.delete(cacheKey);
    } else {
      if (agentChoseEndpoint) {
        const execOut = await executeSkill(
          domainHit.skill,
          { ...params, endpoint_id: params.endpoint_id ?? domainHit.endpointId, ...(queryIntent !== intent ? { intent: queryIntent } : {}) },
          projection,
          { ...options, intent: queryIntent, contextUrl: context?.url },
        );
        if (execOut.trace.success && isAcceptableIntentResult(execOut.result, queryIntent)) {
          promoteResultSnapshot(
            cacheKey,
            domainHit.skill,
            params.endpoint_id ?? domainHit.endpointId,
            execOut.result,
            execOut.trace,
          );
          return {
            result: execOut.result,
            trace: execOut.trace,
            source: "marketplace",
            skill: domainHit.skill,
            timing: finalize(
              "marketplace",
              execOut.result,
              domainHit.skill.skill_id,
              domainHit.skill,
              execOut.trace,
            ),
          };
        }
        invalidateResolveCacheEntries([cacheKey], requestedDomainCacheKey ? [requestedDomainCacheKey] : []);
      }
      const deferred = await buildDeferralWithAutoExec(domainHit.skill, "marketplace");
      if (shouldFallbackToLiveCaptureAfterAutoexecFailure(deferred.autoexecFailedAll, context?.url)) {
        console.log("[captured-domain-cache] stale skill; retrying via live capture");
        invalidateResolveCacheEntries([cacheKey], requestedDomainCacheKey ? [requestedDomainCacheKey] : []);
      } else {
        timing.cache_hit = true;
        deferred.orchestratorResult.timing.cache_hit = true;
        return deferred.orchestratorResult;
      }
    }
  }

  // In-flight capture queue: wait for the same domain capture instead of failing.
  const bypassLiveCaptureQueue = shouldBypassBrowserFirstPass;
  const captureLockKey = scopedCacheKey(clientScope, captureDomain);
  let learned_skill: SkillManifest | undefined;
  let trace: import("../types/index.js").ExecutionTrace;
  let result: unknown;
  if (!bypassLiveCaptureQueue) {
    const existingCapture = captureInFlight.get(captureLockKey);
    if (existingCapture) {
      const waited = await withOpTimeout(
        "live_capture_wait",
        LIVE_CAPTURE_TIMEOUT_MS,
        existingCapture,
      );
      trace = waited.trace;
      result = waited.result;
      learned_skill = waited.learned_skill;
      const parityBaseline = waited.parity_baseline;
      timing.execute_ms = 0;
      if (!learned_skill && !trace.success) {
        return {
          result,
          trace,
          source: "live-capture",
          skill: await getOrCreateBrowserCaptureSkill(),
          timing: finalize("live-capture", result, undefined, undefined, trace),
        };
      }
      if (learned_skill) {
        const captureResult = result as Record<string, unknown> | null;
        const authRecommended = captureResult?.auth_recommended === true;
        const deferred = await buildDeferralWithAutoExec(
          learned_skill,
          "live-capture",
          authRecommended
            ? {
                auth_recommended: true,
              auth_hint: captureResult!.auth_hint,
            }
            : undefined,
        );
        queuePassivePublishIfExecuted(learned_skill, deferred.orchestratorResult, parityBaseline);
        deferred.orchestratorResult.timing.cache_hit = true;
        return deferred.orchestratorResult;
      }
      return {
        result,
        trace,
        source: "live-capture",
        skill: await getOrCreateBrowserCaptureSkill(),
        timing: finalize("live-capture", result, undefined, undefined, trace),
      };
    }
  }

  let parityBaseline: unknown;
  let captureSkill: SkillManifest;
  const te0 = Date.now();
  if (bypassLiveCaptureQueue) {
    captureSkill = await getOrCreateBrowserCaptureSkill();
    const out = await withAbortableOpTimeout(
      "live_capture_execute",
      LIVE_CAPTURE_TIMEOUT_MS,
      (signal) =>
        executeSkill(captureSkill, { ...params, url: context.url, intent }, undefined, {
          ...options,
          intent,
          contextUrl: context?.url,
          signal,
        }),
    );
    trace = out.trace;
    result = out.result;
    learned_skill = out.learned_skill;
    parityBaseline = out.parity_baseline;
  } else {
    const capturePromise = withDomainCaptureLock(captureDomain, async () => {
      const captureSkill = await getOrCreateBrowserCaptureSkill();
      const out = await withAbortableOpTimeout(
        "live_capture_execute",
        LIVE_CAPTURE_TIMEOUT_MS,
        (signal) =>
          executeSkill(captureSkill, { ...params, url: context.url, intent }, undefined, {
            ...options,
            intent,
            contextUrl: context?.url,
            signal,
          }),
      );
      return {
        trace: out.trace,
        result: out.result,
        learned_skill: out.learned_skill,
        parity_baseline: out.parity_baseline,
      };
    });
    captureInFlight.set(captureLockKey, capturePromise);
    try {
      captureSkill = await getOrCreateBrowserCaptureSkill();
      const out = await capturePromise;
      trace = out.trace;
      result = out.result;
      learned_skill = out.learned_skill;
      parityBaseline = out.parity_baseline;
    } finally {
      captureInFlight.delete(captureLockKey);
    }
  }
  timing.execute_ms = Date.now() - te0;
  const captureResult = result as Record<string, unknown> | null;
  const authRecommended = captureResult?.auth_recommended === true;

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

  if (learned_skill && learnedSkillUsable && !isCachedSkillRelevantForIntent(learned_skill, queryIntent, context?.url)) {
    const repairedSnapshot =
      requestedDomain
        ? findBestLocalDomainSnapshot(
            requestedDomain,
            queryIntent,
            context?.url,
            new Set([learned_skill.skill_id]),
          )
        : undefined;
    if (repairedSnapshot) {
      console.log(
        `[capture] reviving local snapshot ${repairedSnapshot.skill_id.slice(0, 15)} after irrelevant learned skill`,
      );
      const repaired = await buildDeferralWithAutoExec(repairedSnapshot, "marketplace");
      repaired.orchestratorResult.timing.cache_hit = true;
      return repaired.orchestratorResult;
    }
    const resolvedSkill = withContextReplayEndpoint(learned_skill, queryIntent, context?.url);
    const ranked = rankEndpoints(
      resolvedSkill.endpoints,
      queryIntent,
      resolvedSkill.domain,
      context?.url,
    );
    const rejectedTrace: ExecutionTrace = {
      ...trace,
      success: false,
      error: `No relevant endpoint discovered for "${queryIntent}"`,
    };
    console.warn(`[capture] dropping learned skill with no relevant endpoints for "${queryIntent}"`);
    return {
      result: {
        error: `No relevant endpoint discovered for "${queryIntent}"`,
        discovered_endpoints: ranked.slice(0, 3).map((candidate) => ({
          endpoint_id: candidate.endpoint.endpoint_id,
          score: Math.round(candidate.score * 10) / 10,
          description: candidate.endpoint.description,
          url: candidate.endpoint.url_template,
        })),
        ...(authRecommended
          ? {
              auth_recommended: true,
              auth_hint: captureResult?.auth_hint,
            }
          : {}),
      },
      trace: rejectedTrace,
      source: "live-capture",
      skill: captureSkill!,
      timing: finalize("live-capture", result, undefined, undefined, rejectedTrace),
    };
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
  }

  function queuePassivePublishIfExecuted(
    skill: SkillManifest,
    orchestratorResult: OrchestratorResult,
    browserBaseline?: unknown,
  ): void {
    if (!orchestratorResult.trace.success || !orchestratorResult.trace.endpoint_id) return;
    const parity = browserBaseline === undefined
      ? undefined
      : Promise.resolve(agentJudgeParity(intent, browserBaseline, orchestratorResult.result));
    void queuePassiveSkillPublish(skill, { parity });
  }

  // Auth-gated or no data: pass through error
  if (!learned_skill && !trace.success) {
    return {
      result,
      trace,
      source: "live-capture",
      skill: captureSkill!,
      timing: finalize("live-capture", result, undefined, undefined, trace),
    };
  }

  // DOM-extracted skill: data already extracted during capture, return directly
  const hasNonDomApiEndpoints = !!learned_skill?.endpoints?.some(
    (ep) => !ep.dom_extraction && ep.method !== "WS",
  );
  const hasBetterStructuredSearchEndpoint = learned_skill
    ? skillHasBetterStructuredSearchEndpoint(learned_skill, trace.endpoint_id, queryIntent, context?.url)
    : false;
  const isDirectDomResult = directDomCaptureResult;
  const directExtractionSource =
    isDirectDomResult && result && typeof result === "object"
      ? ((result as Record<string, unknown>)._extraction as Record<string, unknown> | undefined)?.source
      : undefined;
  if (
    isDirectDomResult &&
    (
      (directExtractionSource === "html-embedded" && !hasBetterStructuredSearchEndpoint) ||
      !hasNonDomApiEndpoints
    )
  ) {
    if (learned_skill) {
      const direct: OrchestratorResult = {
        result,
        trace,
        source: directExtractionSource === "html-embedded" ? "live-capture" : "dom-fallback",
        skill: learned_skill,
        timing: finalize(
          directExtractionSource === "html-embedded" ? "live-capture" : "dom-fallback",
          result,
          learned_skill.skill_id,
          learned_skill,
          trace,
        ),
      };
      queuePassivePublishIfExecuted(learned_skill, direct, parityBaseline);
      return direct;
    }
    return {
      result,
      trace,
      source: "dom-fallback",
      skill: captureSkill!,
      timing: finalize("dom-fallback", result, undefined, undefined, trace),
    };
  }

  if (!learned_skill) {
    return {
      result,
      trace,
      source: "live-capture",
      skill: captureSkill!,
      timing: finalize("live-capture", result, undefined, undefined, trace),
    };
  }

  // Agent explicitly chose an endpoint — execute directly.
  if (agentChoseEndpoint && learned_skill) {
    const te1 = Date.now();
    const execOut = await executeSkill(learned_skill, params, projection, {
      ...options,
      intent: queryIntent,
      contextUrl: context?.url,
    });
    timing.execute_ms += Date.now() - te1;
    if (execOut.trace.success)
      promoteLearnedSkill(clientScope, cacheKey, learned_skill, execOut.trace.endpoint_id, context?.url);
    if (execOut.trace.success && isAcceptableIntentResult(execOut.result, queryIntent)) {
      queuePassivePublishIfExecuted(
        learned_skill,
        {
          result: execOut.result,
          trace: execOut.trace,
          source: "live-capture",
          skill: learned_skill,
          timing: finalize(
            "live-capture",
            execOut.result,
            learned_skill.skill_id,
            learned_skill,
            execOut.trace,
          ),
        },
        parityBaseline,
      );
    }
    if (execOut.trace.success && isAcceptableIntentResult(execOut.result, queryIntent)) {
      promoteResultSnapshot(
        cacheKey,
        learned_skill,
        execOut.trace.endpoint_id,
        execOut.result,
        execOut.trace,
      );
    }
    return {
      result: execOut.result,
      trace: execOut.trace,
      source: "live-capture",
      skill: learned_skill,
      timing: finalize(
        "live-capture",
        execOut.result,
        learned_skill.skill_id,
        learned_skill,
        execOut.trace,
      ),
    };
  }
  const deferred = await buildDeferralWithAutoExec(
    learned_skill!,
    "live-capture",
    authRecommended
      ? {
          auth_recommended: true,
          auth_hint: captureResult!.auth_hint,
        }
      : undefined,
  );
  queuePassivePublishIfExecuted(learned_skill, deferred.orchestratorResult, parityBaseline);
  upsertDagEdgesFromOperationGraph(learned_skill!);
  return deferred.orchestratorResult;
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
    description:
      "Meta-skill: launches a headless browser, records HAR, reverse-engineers API endpoints, and publishes a new skill to the marketplace.",
    owner_type: "agent",
    execution_type: "browser-capture",
    endpoints: [],
    lifecycle: "active",
    created_at: now,
    updated_at: now,
  };

  await publishSkill(skill).catch((err) =>
    console.error("[publish] browser-capture skill update failed:", (err as Error).message),
  );
  return skill;
}

/** Reject skills where no endpoint returns structured data or a replayable canonical document route. */
export function hasUsableEndpoints(skill: SkillManifest): boolean {
  if (!skill.endpoints || skill.endpoints.length === 0) return false;
  return skill.endpoints.some((ep) => {
    try {
      const isCanonicalReplay =
        typeof ep.trigger_url === "string" &&
        !!ep.trigger_url &&
        (ep.url_template === deriveStructuredDataReplayUrl(ep.trigger_url) ||
          ep.url_template === deriveStructuredDataReplayTemplate(ep.trigger_url));
      if (isCanonicalReplay) return true;

      const u = new URL(ep.url_template);
      const onDomain = u.hostname === skill.domain || u.hostname.endsWith(`.${skill.domain}`);
      if (!onDomain) return false;
      // Must have a response schema (JSON) or be an API-style path
      return !!ep.response_schema || /\/api\//i.test(u.pathname) || !!ep.dom_extraction;
    } catch {
      return false;
    }
  });
}

/** Generate a local heuristic description for an endpoint so BM25 can work immediately. */
export function generateLocalDescription(ep: import("../types/index.js").EndpointDescriptor): string {
  let id = "";
  try {
    const u = new URL(ep.url_template);
    // GraphQL: extract operation name from path (/graphql/HASH/OperationName)
    const graphqlMatch = u.pathname.match(/\/graphql\/\w+\/(\w+)/);
    if (graphqlMatch) id = graphqlMatch[1];
    // GraphQL: queryId param
    if (!id) {
      const qid = u.searchParams.get("queryId") ?? "";
      const qidMatch = qid.match(/^([a-zA-Z]+)\./);
      if (qidMatch) id = qidMatch[1];
    }
    // REST: last meaningful path segment (skip hashes, {params}, version prefixes)
    if (!id) {
      const segs = u.pathname
        .split("/")
        .filter((s) => s.length > 1 && !s.startsWith("{") && !/^v\d+$/.test(s) && !/^[a-zA-Z0-9_-]{20,}$/.test(s));
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

function extractDomain(metadata: Record<string, unknown>): string | null {
  try {
    const content = JSON.parse(metadata.content as string) as { domain?: string };
    return typeof content.domain === "string" ? content.domain : null;
  } catch {
    return null;
  }
}

export function selectSkillIdsToHydrate(
  candidates: Array<{ metadata: Record<string, unknown> }>,
  requestedDomain?: string | null,
  limit = MARKETPLACE_HYDRATE_LIMIT,
): string[] {
  const prioritizedCandidates = [
    ...candidates.filter((candidate) => {
      if (!requestedDomain) return false;
      try {
        const endpointDomain = extractDomain(candidate.metadata);
        return !!endpointDomain && getRegistrableDomain(endpointDomain) === getRegistrableDomain(requestedDomain);
      } catch {
        return false;
      }
    }),
    ...candidates.filter((candidate) => {
      if (!requestedDomain) return true;
      try {
        const endpointDomain = extractDomain(candidate.metadata);
        return !endpointDomain || getRegistrableDomain(endpointDomain) !== getRegistrableDomain(requestedDomain);
      } catch {
        return true;
      }
    }),
  ];
  return [...new Set(prioritizedCandidates.map((c) => extractSkillId(c.metadata)).filter((value): value is string => !!value))].slice(0, limit);
}
