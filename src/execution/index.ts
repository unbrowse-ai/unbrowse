import { executeInBrowser, triggerAndIntercept } from "../capture/index.js";
import { captureSession } from "../capture/index.js";
import * as kuri from "../kuri/client.js";
import type { CaptureResult, RawRequest } from "../capture/index.js";
import { extractEndpoints, extractAuthHeaders, type ExtractionContext } from "../reverse-engineer/index.js";
import { scanBundlesForRoutes } from "../reverse-engineer/bundle-scanner.js";
import { resolveAuthTokens } from "./token-resolver.js";
import { publishSkill, mergeEndpoints } from "../marketplace/index.js";
import { selectMarketplacePublishEndpoints } from "../publish-admission.js";
import { updateEndpointScore } from "../marketplace/index.js";
import { getCredential, storeCredential, deleteCredential } from "../vault/index.js";
import { forceVisibleKuriEnv, getStoredAuth, getAuthCookies, refreshAuthFromBrowser } from "../auth/index.js";
import { recordStaleEndpoint } from "../auth/stale-endpoints.js";
import { authRuntime } from "../auth/runtime.js";
import { applyProjection, inferSchema } from "../transform/index.js";
import { detectSchemaDrift } from "../transform/drift.js";
import { classifyDrift } from "../transform/drift-classifier.js";
import { buildDriftRecaptureSignal } from "./drift-recapture-signal.js";
import { recordExecution, recordTransaction, cachePublishedSkill, evictCachedEndpoint, findExistingSkillForDomain, getLocalWalletContext, updateEndpointSchema } from "../client/index.js";
import { validateManifest } from "../client/index.js";
import { recordEndpointStrike, clearEndpointStrikes } from "../client/eviction-strikes.js";
import { withRetry, isRetryableStatus, parseRetryAfter } from "./retry.js";
import { deriveRecipeReplayNextStep } from "./recipe-replay-hints.js";
import { probeUrl, decideFromProbe } from "./probe.js";
import type { ChainWalkContext, DecisionTraceStep, EndpointDescriptor, ExecutionOptions, ExecutionTrace, OperationBinding, ProjectionOptions, ProvenRecipe, ProvenRecipeResponseSignal, SessionYield, SessionYieldCache, SkillManifest } from "../types/index.js";
import { isBindingStale } from "../orchestrator/dag-feedback.js";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { bm25Score, BM25_K1, BM25_B, BM25_DELTA_WEIGHT } from "../ranking/signals/bm25.js";
import { semanticIntentAdjustment, AGENT_DESC_DELTA_WEIGHT, CURRENCY_TIME_DELTA_WEIGHT, COMMS_PATH_DELTA_WEIGHT, CHART_PRICING_DELTA_WEIGHT } from "../ranking/signals/intent-yield.js";
import { NOISE_HOSTS, NOISE_PATHS, I18N_CONFIG_PATHS, AUTH_CONFIG_PATHS, SESSION_PLUMBING, STATIC_ASSET_PATTERNS, UI_ASSET_PATHS } from "../ranking/filters/noise-patterns.js";
import { HARD_NEGATIVE_FLOOR, WEAK_NEGATIVE_FLOOR, PAGE_ARTIFACT_DEMOTION, clampToFloor } from "../ranking/clamps.js";

function stableEndpointId(method: string, urlTemplate: string): string {
  if (!method || !urlTemplate) return nanoid();
  return createHash("sha256").update(`${method}:${urlTemplate}`).digest("base64url").slice(0, 21);
}
import { getRegistrableDomain } from "../domain.js";
import { extractFromDOM, extractFromDOMWithHint } from "../extraction/index.js";
import { buildSkillOperationGraph, getEndpointDescriptionMetadata, inferEndpointSemantic, resolveEndpointSemantic } from "../graph/index.js";
import { log } from "../logger.js";
import { TRACE_VERSION } from "../version.js";
import { buildQueryBindingMap, extractTemplateQueryBindings, mergeContextTemplateParams } from "../template-params.js";
import { assessIntentResult, projectIntentData } from "../intent-match.js";
import { isStructuredSearchForm, detectSearchForms, type SearchFormSpec } from "./search-forms.js";
import { attributeLifecycle, type LifecycleEvent, type LifecyclePhase } from "../runtime/lifecycle.js";
import { queueBackgroundIndex } from "../indexer/index.js";
import { readActiveSessions } from "../api/session-store.js";
import {
  writeSkillSnapshot,
  domainSkillCache,
  persistDomainCache,
  getDomainReuseKey,
  scopedCacheKey,
  buildResolveCacheKey,
  snapshotPathForCacheKey,
  generateLocalDescription,
  findEndpointInSkillHistory,
} from "../orchestrator/index.js";
import { checkPaymentRequirement } from "../payments/index.js";
import { annotateEndpointPolicy, endpointRequiresThirdPartyTermsConfirmation, getEndpointPolicy } from "../site-policy.js";
import {
  mergeWorkflowArtifacts,
  readWorkflowArtifact,
  recordWorkflowRecipeOutcome,
  writeWorkflowArtifact,
} from "../workflow/artifact.js";
import { buildWorkflowArtifactFromCapture } from "../workflow/compile.js";
import {
  needsWorkflowTokenRefresh,
  pickWorkflowRecipe,
  resolveWorkflowBindings,
  translateWorkflowStrategy,
  validateWorkflowReplayParams,
} from "../workflow/runtime.js";
import { buildWorkflowPublishArtifact, writeWorkflowPublishArtifact } from "../workflow/publish.js";
import { decodeProtobufBytes, isProtobufContentType, isProtobufLikeEndpoint } from "../protobuf/wire.js";
/** Stamp every trace with the code version hash for telemetry tracking */
function stampTrace(trace: ExecutionTrace): ExecutionTrace {
  trace.trace_version = TRACE_VERSION;
  return trace;
}

function buildBrowserFallbackCommands(contextUrl: string, skill: SkillManifest): string[] {
  const target = contextUrl || `https://${skill.domain}`;
  return [
    `unbrowse go "${target}"`,
    "unbrowse snap --filter interactive",
    "unbrowse text",
    "unbrowse close",
  ];
}

function staleEndpointResult(
  status: number,
  skill: SkillManifest,
  endpoint: EndpointDescriptor,
  contextUrl?: string,
  message?: string,
): Record<string, unknown> {
  const target = contextUrl || endpoint.trigger_url || `https://${skill.domain}`;
  // Loop 5 (B-023 follow-up #2): persist the auth-failure as a structured
  // stale record so the next resolve hides this endpoint from
  // available_endpoints. 401 is the ground truth that cookies are stale
  // for this endpoint; the agent shouldn't keep being shown it.
  try {
    recordStaleEndpoint(skill.domain, endpoint.endpoint_id, status, "unknown");
  } catch {
    /* best-effort; never break the human-facing error path */
  }
  return {
    error: "stale_endpoint",
    status_code: status,
    skill_id: skill.skill_id,
    endpoint_id: endpoint.endpoint_id,
    message: message ?? `Endpoint ${endpoint.endpoint_id} returned HTTP ${status} after replay recovery. Treat this marketplace route as stale and use browser capture for this task.`,
    next_step: `Use browser fallback: unbrowse go "${target}", inspect with snap/text, then close to checkpoint and publish a fresh route.`,
    commands: buildBrowserFallbackCommands(target, skill),
  };
}
/**
 * Live-session fallback for 4xx after server_fetch fails.
 *
 * When an agent has an open browse session for the endpoint's domain, the real
 * Chrome tab already has: real cookies (including HttpOnly), real UA, real IP,
 * any anti-bot challenge clearance, and any JS-set state. Issuing the fetch
 * inside that tab's JS context via Runtime.evaluate bypasses libcurl-class bot
 * detection that the server-side recovery chain can't unwind.
 *
 * Returns the live-session result (success or final failure status) or null
 * when no usable session exists. Decision-trace steps follow the convention
 * documented in CLAUDE.md (`4xx_live_session_fallback_<sub_state>`).
 */
async function tryLiveSessionFallback(
  domain: string,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  decisionTrace: Array<Record<string, unknown>>,
): Promise<{ status: number; data: unknown } | null> {
  let sessions: ReturnType<typeof readActiveSessions>;
  try {
    sessions = readActiveSessions();
  } catch (err) {
    decisionTrace.push({
      step: "4xx_live_session_fallback_error",
      reason: "read_active_sessions_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (sessions.length === 0) {
    decisionTrace.push({ step: "4xx_live_session_fallback_no_session", reason: "no_active_sessions" });
    return null;
  }
  // Match by registrable domain (so reddit.com session matches www.reddit.com endpoint).
  const targetReg = getRegistrableDomain(domain) || domain;
  const match = sessions.find((s) => {
    const sReg = getRegistrableDomain(s.domain) || s.domain;
    return sReg === targetReg;
  });
  if (!match) {
    decisionTrace.push({
      step: "4xx_live_session_fallback_no_session",
      reason: "no_session_for_domain",
      target_domain: domain,
      active_domains: sessions.map((s) => s.domain).slice(0, 8),
    });
    return null;
  }
  decisionTrace.push({
    step: "4xx_live_session_fallback",
    session_id: match.sessionId,
    tab_id: match.tabId,
    target_url: url,
  });
  try {
    const tabResult = await kuri.executeInPageFetch(match.tabId, url, method, headers, body);
    if (tabResult.status === 0) {
      decisionTrace.push({
        step: "4xx_live_session_fallback_kuri_unavailable",
        session_id: match.sessionId,
      });
      return null;
    }
    if (tabResult.status >= 200 && tabResult.status < 300) {
      decisionTrace.push({
        step: "4xx_live_session_fallback_success",
        status: tabResult.status,
        session_id: match.sessionId,
      });
    } else {
      decisionTrace.push({
        step: "4xx_live_session_fallback_still_blocked",
        status: tabResult.status,
        session_id: match.sessionId,
      });
    }
    return tabResult;
  } catch (err) {
    decisionTrace.push({
      step: "4xx_live_session_fallback_error",
      reason: "kuri_fetch_threw",
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const DEFAULT_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

function cloneReplayBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map((entry) => cloneReplayBody(entry));
  return { ...(body as Record<string, unknown>) };
}

function serializeReplayBody(body: unknown, headers: Record<string, string>): BodyInit | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) return body;
  const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
  if (/application\/x-www-form-urlencoded/i.test(contentType) && body && typeof body === "object" && !Array.isArray(body)) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value == null) continue;
      params.set(key, String(value));
    }
    return params.toString();
  }
  return JSON.stringify(body);
}

export async function reloadExecutionAuthState(
  skill: SkillManifest,
  epDomain: string,
  authHeaders: Record<string, string>,
  cookies: Array<{ name: string; value: string; domain: string }>,
): Promise<void> {
  for (const key of Object.keys(authHeaders)) delete authHeaders[key];
  cookies.splice(0, cookies.length);

  if (skill.auth_profile_ref) {
    const stored = await getCredential(skill.auth_profile_ref);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as {
          headers?: Record<string, string>;
          cookies?: Array<{ name: string; value: string; domain: string }>;
        };
        Object.assign(authHeaders, parsed.headers ?? {});
        cookies.push(...(parsed.cookies ?? []));
      } catch {
        /* ignore malformed auth state */
      }
    }
  }

  if (cookies.length === 0) {
    try {
      const resolved = await getAuthCookies(epDomain, {
        autoExtract: !!skill.auth_profile_ref,
      });
      if (resolved?.length) cookies.push(...resolved);
    } catch {
      /* ignore */
    }
  }

  // Always check domain-session vault keys — auth_profile_ref may point to a partial entry
  {
    for (const sessionKey of [`${epDomain}-session`, `${getRegistrableDomain(epDomain)}-session`]) {
      try {
        const sessionData = await getCredential(sessionKey);
        if (sessionData) {
          const parsed = JSON.parse(sessionData) as { headers?: Record<string, string>; cookies?: typeof cookies };
          if (parsed.headers) Object.assign(authHeaders, parsed.headers);
          if (parsed.cookies && cookies.length === 0) cookies.push(...parsed.cookies);
          if (Object.keys(authHeaders).length > 0) break;
        }
      } catch { /* ignore */ }
    }
  }

  // LinkedIn CSRF fix: LinkedIn validates csrf-token against JSESSIONID cookie value.
  // CDP captures the ajax-style csrf-token but LinkedIn actually needs the JSESSIONID.
  if (cookies.length > 0 && authHeaders["csrf-token"]) {
    const jsessionId = cookies.find((c) => c.name === "JSESSIONID");
    if (jsessionId) {
      authHeaders["csrf-token"] = jsessionId.value.replace(/"/g, "");
    }
  }
}

function persistWorkflowArtifactForCapture(
  artifactSkill: SkillManifest,
  captured: Pick<CaptureResult, "requests" | "har_lineage_id" | "final_url" | "html" | "js_bundles" | "cookies">,
  capturedAuthHeaders?: Record<string, string>,
): void {
  try {
    if (process.env.UNBROWSE_DEBUG_WORKFLOW === "1") {
      log(
        "workflow",
        `capture artifact attempt skill=${artifactSkill.skill_id} requests=${captured.requests.length} final_url=${captured.final_url}`,
      );
    }
    const nextArtifact = mergeWorkflowArtifacts(
      buildWorkflowArtifactFromCapture(artifactSkill, captured, { authHeaders: capturedAuthHeaders }),
      readWorkflowArtifact(artifactSkill.skill_id),
    );
    const writtenPath = writeWorkflowArtifact(nextArtifact);
    const exportPath = writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(artifactSkill, nextArtifact, {
      publishStatus: "captured",
    }));
    if (process.env.UNBROWSE_DEBUG_WORKFLOW === "1") {
      log(
        "workflow",
        `capture persisted skill=${artifactSkill.skill_id} requests=${captured.requests.length} path=${writtenPath ?? "write-failed"} export=${exportPath ?? "write-failed"}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("workflow", `capture persistence failed for ${artifactSkill.skill_id}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Quality gate — validate extracted data before marketplace publishing
// ---------------------------------------------------------------------------

interface QualityResult {
  valid: boolean;
  quality_note?: string;
}

const VALID_VERIFICATION_STATUSES = new Set(["verified", "unverified", "failed", "pending"]);

function normalizeEndpointForManifest(endpoint: EndpointDescriptor): EndpointDescriptor {
  const verification_status = VALID_VERIFICATION_STATUSES.has(endpoint.verification_status)
    ? endpoint.verification_status
    : (endpoint.response_schema || endpoint.dom_extraction ? "verified" : "pending");
  return { ...endpoint, verification_status };
}

async function prepareLearnedEndpoints(
  endpoints: EndpointDescriptor[],
  _intent: string,
  _domain: string,
): Promise<EndpointDescriptor[]> {
  return endpoints.map(normalizeEndpointForManifest);
}

function intentWantsStructuredRecords(intent?: string): boolean {
  return /\b(search|list|find|get|fetch|timeline|feed|trending)\b/i.test(intent ?? "");
}

export function isBundleInferredEndpoint(endpoint: Pick<EndpointDescriptor, "description">): boolean {
  return /inferred from js bundle/i.test(endpoint.description ?? "");
}

function isSupportEvidenceEndpoint(endpoint: EndpointDescriptor): boolean {
  if (endpoint.dom_extraction && endpoint.response_schema) return true;
  if (isBundleInferredEndpoint(endpoint)) return false;
  return !!endpoint.response_schema;
}

function looksLikeUiChromeText(value: string): boolean {
  const lower = value.toLowerCase();
  let hits = 0;
  for (const token of [
    "advanced search",
    "pull requests",
    "discussions",
    "languages",
    "more languages",
    "owner",
    "number of stars",
    "number of forks",
    "date created",
    "date pushed",
    "public private",
    "results",
  ]) {
    if (lower.includes(token)) hits++;
  }
  return hits >= 2;
}

/** Detect concatenated values like "AAPLApple" or "Inc978,583".
 * The bare letter-then-digits shape `[a-zA-Z]\d{3,}` over-matches on
 * legitimate identifiers (cache-busted asset hashes, OpenLibrary work
 * IDs, version strings, GitHub issue refs, build numbers). The original
 * intent — per the function header comment — was financial concatenation
 * like "Inc978,583", which is uniquely signalled by the thousand-
 * separator commas in the numeric tail. Webpack/Vite/npm asset hashes
 * routinely contain digit runs ≥7 (e.g. `bdb4cdf27288716a27f6`), so a
 * length-only heuristic still misclassifies them — the COMMA is the
 * only reliable signal that the digits represent a finance value rather
 * than an opaque identifier. Surfaced by 2026-05-18 MCP gate run
 * 20260518T115632Z probe 002 (npm package page rejected at confidence
 * 0.9 because asset URLs contain letter+digit hash segments).
 */
function isConcatenatedValue(s: string): boolean {
  // Uppercase ticker jammed onto capitalized word: AAPLApple, NVDANvidia
  if (/[A-Z]{2,}[A-Z][a-z]/.test(s)) return true;
  // Word ending in letter immediately followed by a comma-formatted
  // number: "Inc978,583", "Acme1,234". The thousand-separator is what
  // makes this a finance value rather than an opaque identifier.
  if (/[a-zA-Z]\d{1,3}(?:,\d{3})+/.test(s)) return true;
  return false;
}
/**
 * Validate extraction quality. Always returns data to the caller —
 * this only gates whether we publish to the marketplace.
 */
export function validateExtractionQuality(data: unknown, confidence: number, intent?: string): QualityResult {
  // 1. Min confidence
  if (confidence < 0.5) {
    return { valid: false, quality_note: `confidence too low (${confidence.toFixed(2)} < 0.5)` };
  }

  // Only validate arrays (repeated data structures)
  if (!Array.isArray(data)) return { valid: true };
  if (data.length === 0) return { valid: true };
  if (intentWantsStructuredRecords(intent) && data.every((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    return { valid: false, quality_note: "primitive rows only — expected structured records" };
  }

  const stringRows = data.filter((item): item is string => typeof item === "string");
  if (stringRows.length === data.length) {
    const uiChromeRows = stringRows.filter((item) => looksLikeUiChromeText(item));
    if (uiChromeRows.length / stringRows.length >= 0.5) {
      return { valid: false, quality_note: "ui chrome text detected instead of structured records" };
    }
  }

  // 2. Deduplication check
  const serialized = data.map((item) => JSON.stringify(item));
  const unique = new Set(serialized);
  const dupeRatio = 1 - unique.size / serialized.length;
  if (dupeRatio > 0.5) {
    return { valid: false, quality_note: `${Math.round(dupeRatio * 100)}% duplicate rows` };
  }

  // 3. Concatenation detection
  let totalStrings = 0;
  let concatStrings = 0;
  for (const item of data) {
    if (item && typeof item === "object") {
      for (const val of Object.values(item as Record<string, unknown>)) {
        if (typeof val === "string" && val.length > 3) {
          totalStrings++;
          if (isConcatenatedValue(val)) concatStrings++;
        }
      }
    }
  }
  if (totalStrings > 0 && concatStrings / totalStrings > 0.3) {
    return { valid: false, quality_note: `${Math.round((concatStrings / totalStrings) * 100)}% concatenated values detected` };
  }

  // 4. Diversity check — reject if all items share the same link/title (nav chrome)
  if (data.length >= 3) {
    for (const field of ["link", "href", "url", "title"]) {
      const vals = data
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)[field] : undefined))
        .filter((v) => v != null);
      if (vals.length >= 3) {
        const uniqueVals = new Set(vals.map(String));
        if (uniqueVals.size === 1) {
          return { valid: false, quality_note: `all items share the same "${field}" — likely navigation chrome` };
        }
      }
    }
  }

  return { valid: true };
}

export interface ExecutionResult {
  trace: ExecutionTrace;
  result: unknown;
  learned_skill?: SkillManifest;
  /** Phase 7.2 — top-level dispatch trace.
   *  Steps the executor took: recipe_replay (if any), probe, decision, server_fetch /
   *  trigger_intercept / browser / return_error. Mirrored on trace.decision_trace
   *  for backward compat with 7.1 tests; will become the single source in Phase 8. */
  decision_trace?: Array<Record<string, unknown>>;
}

export function projectResultForIntent(data: unknown, intent?: string): unknown {
  return projectIntentData(data, intent);
}

function inferActionKindFromIntent(intent: string): string {
  const lower = intent.toLowerCase();
  if (/\b(search|find|lookup)\b/.test(lower)) return "search";
  if (/\b(list|feed|timeline|trending)\b/.test(lower)) return "list";
  return "detail";
}

function sanitizeNavigationQueryParams(url: URL): URL {
  const out = new URL(url.toString());
  for (const key of [...out.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower === "url" || lower === "context_url" || lower === "intent" || lower === "redirect" || lower === "redirect_url") {
      out.searchParams.delete(key);
    }
  }
  return out;
}

function restoreTemplatePlaceholderEncoding(url: string): string {
  // Only restore template placeholders like {variable_name}, not arbitrary JSON braces.
  // Template placeholders: %7Bword_chars%7D (no spaces, no quotes, no colons inside)
  return url.replace(/%7B(\w+)%7D/gi, "{$1}");
}

function compactSchemaSample(value: unknown, depth = 0): unknown {
  if (depth >= 4) return Array.isArray(value) ? [] : value && typeof value === "object" ? "[truncated]" : value;
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => compactSchemaSample(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, next]) => [key, compactSchemaSample(next, depth + 1)]),
    );
  }
  return value;
}

function isDocumentLikeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return !/\/api\/|graphql|\/rest\/|\/rpc\/|\/ajax\/|\/1\.1\/|\/2\/|voyager/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function resolveExecutionUrlTemplate(
  endpoint: EndpointDescriptor,
  contextUrl?: string,
): string {
  if (!contextUrl) return endpoint.url_template;
  if (endpoint.method !== "GET") return endpoint.url_template;
  if (!isDocumentLikeUrl(endpoint.url_template)) return endpoint.url_template;
  if (endpoint.trigger_url && !isDocumentLikeUrl(endpoint.trigger_url)) return endpoint.url_template;
  // Regression: executor-drops-url-template-and-params.
  // When the captured url_template carries intent-bearing structure (template
  // placeholders like `{q}`, a non-trivial querystring, or path segments
  // beyond the root), flattening it to `contextUrl` loses that signal.
  // Three distinct templated endpoints all collapse to the same bare
  // homepage probe otherwise. Document-replay context preference only kicks
  // in when the captured template is genuinely bare (root path, no query,
  // no placeholders) and the contextUrl carries the specific target.
  if (templateCarriesIntentSignal(endpoint.url_template)) return endpoint.url_template;
  return contextUrl;
}

function templateCarriesIntentSignal(template: string): boolean {
  try {
    const parsed = new URL(template);
    if (parsed.search && parsed.search.length > 1) return true;
    const trimmedPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (trimmedPath.length > 0) return true;
    return false;
  } catch {
    // If url_template still has unparsed placeholders (e.g. `{base}/path`),
    // assume it carries signal. Better to keep the captured template than
    // silently overwrite intent-bearing structure.
    return /\{[^}]+\}/.test(template);
  }
}

export function shouldIgnoreLearnedBrowserStrategy(
  endpoint: EndpointDescriptor,
  resolvedUrl: string,
): boolean {
  return endpoint.method === "GET" && !endpoint.dom_extraction && !isDocumentLikeUrl(resolvedUrl);
}

export function buildStructuredReplayHeaders(
  originalUrl: string,
  replayUrl: string,
  baseHeaders: Record<string, string>,
): Record<string, string> {
  const headers = { ...baseHeaders };
  try {
    const replayTarget = new URL(replayUrl);
    const originalTarget = new URL(originalUrl);
    const needsApiReplayHeaders =
      replayTarget.hostname !== originalTarget.hostname ||
      /\/api\/|graphql|\/rest\/|\/rpc\/|\/v\d+\//i.test(replayTarget.pathname);
    if (needsApiReplayHeaders) {
      headers["user-agent"] ??= DEFAULT_BROWSER_UA;
      headers["accept-language"] ??= "en-US,en;q=0.9";
      headers["referer"] ??= originalTarget.toString();
      headers["accept"] ??= "application/json,text/plain,*/*";
    }
  } catch {
    return headers;
  }
  return headers;
}

function normalizeReplayHeaders(
  ...bags: Array<Record<string, string> | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const bag of bags) {
    for (const [key, value] of Object.entries(bag ?? {})) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      normalized[key.toLowerCase()] = trimmed;
    }
  }
  return normalized;
}

function shouldFallbackToBrowserReplay(
  data: unknown,
  endpoint: EndpointDescriptor,
  intent?: string,
  contextUrl?: string,
): boolean {
  const replayUrl = resolveExecutionUrlTemplate(endpoint, contextUrl);
  if (!isDocumentLikeUrl(replayUrl)) return false;
  if (typeof data === "string") return isHtml(data) || isSpaShell(data);
  const assessment = assessIntentResult(data, intent);
  return assessment.verdict === "fail";
}

function buildSampleRequestFromUrl(url: string): Record<string, unknown> {
  try {
    return Object.fromEntries(sanitizeNavigationQueryParams(new URL(url)).searchParams.entries());
  } catch {
    return {};
  }
}

function looksLikeApiUrl(url: string): boolean {
  return /\/api\/|graphql|\/rest\/|\/rpc\/|voyager|\/v\d+(?:\/|$)|\/\d+\.\d+\/|\.json(?:\?|$)/i.test(url)
    || /^(api|gql|graphql|rest|registry|services?|backend|query\d*|edge|quote-api)\./i.test((() => {
      try { return new URL(url).hostname; } catch { return ""; }
    })())
    || /\.api\./i.test((() => {
      try { return new URL(url).hostname; } catch { return ""; }
    })());
}

export function buildPageArtifactCapture(
  url: string,
  intent: string,
  html: string,
  authRequired = false,
): {
  endpoint?: EndpointDescriptor;
  result?: { data: unknown; _extraction: Record<string, unknown> };
  quality_note?: string;
  search_form?: SearchFormSpec;
} {
  const extracted = extractFromDOM(html, intent);
  if (!extracted.data || extracted.confidence <= 0.2) return {};
  const quality = validateExtractionQuality(extracted.data, extracted.confidence, intent);
  if (!quality.valid) {
    return { quality_note: quality.quality_note ?? "low_quality_dom_extraction" };
  }
  const semanticAssessment = assessIntentResult(extracted.data, intent);
  if (semanticAssessment.verdict === "fail") {
    return { quality_note: semanticAssessment.reason };
  }

  // Detect structured search forms from the captured HTML
  const searchForms = detectSearchForms(html);
  const validSearchForm = searchForms.find((spec: SearchFormSpec) => isStructuredSearchForm(spec));

  // SPA-sourced data (Next.js __NEXT_DATA__, Nuxt, __INITIAL_STATE__, etc.)
  // is structurally distinct from DOM repeated-elements scraping: it's the
  // same payload the server ships to hydrate the page, so it's effectively a
  // real SSR API response. Surface that in the description so the publish
  // admission gate and the bench rubric don't lump it in with synthetic
  // page-artifact fallbacks.
  const isSpaSource = extracted.extraction_method.startsWith("spa-");
  const response_schema = inferSchema([extracted.data]);
  const computedTemplate = templatizeQueryParams(url);
  const sampleRequest = buildSampleRequestFromUrl(url);
  const description = validSearchForm
    ? `Captured search form artifact for ${intent}`
    : isSpaSource
      ? `SSR embedded data (${extracted.extraction_method}) for ${intent}`
      : `Captured page artifact for ${intent}`;
  const endpoint: EndpointDescriptor = {
    endpoint_id: stableEndpointId("GET", computedTemplate),
    method: "GET",
    url_template: computedTemplate,
    idempotency: "safe" as const,
    verification_status: "verified" as const,
    reliability_score: extracted.confidence,
    description,
    response_schema,
    dom_extraction: {
      extraction_method: extracted.extraction_method,
      confidence: extracted.confidence,
      ...(extracted.selector ? { selector: extracted.selector } : {}),
      ...(validSearchForm ? { search_form: validSearchForm } : {}),
    },
    trigger_url: url,
    ...(Object.keys(sampleRequest).length > 0 ? { query: sampleRequest } : {}),
  };
  endpoint.semantic = {
    ...inferEndpointSemantic(endpoint, {
      sampleResponse: extracted.data,
      sampleRequest,
      observedAt: new Date().toISOString(),
      sampleRequestUrl: url,
    }),
    ...(authRequired ? { auth_required: true } : {}),
  };
  if (validSearchForm && endpoint.semantic) {
    endpoint.semantic.action_kind = "search";
  }

  if (validSearchForm) {
    log("execution", `detected structured search form: ${validSearchForm.form_selector} with ${validSearchForm.fields.length} fields`);
  }

  return {
    endpoint,
    result: {
      data: extracted.data,
      _extraction: {
        method: extracted.extraction_method,
        confidence: extracted.confidence,
        source: "dom-fallback",
        ...(validSearchForm ? { search_form_detected: true } : {}),
      },
    },
    ...(validSearchForm ? { search_form: validSearchForm } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// page_fetch — the invariant floor endpoint.
//
// Every captured skill carries one of these. It's a plain GET against
// the captured URL whose response is the rendered HTML page. When all
// captured XHRs are telemetry (Amazon, Bing search), or when DOM
// extraction failed, page_fetch is the always-callable bedrock the
// agent can fall back on. Identified via dom_extraction.extraction_method
// === "page_fetch"; ranks as a normal endpoint (with one targeted bonus
// for content-read intents in rankEndpoints).
// See .bench-history/ROOT_FIX_GUIDE.md for the full architecture.
// ─────────────────────────────────────────────────────────────────────

export function buildPageFetchEndpoint(
  url: string,
  intent: string,
  authRequired = false,
): EndpointDescriptor {
  const computedTemplate = templatizeQueryParams(url);
  const sampleRequest = buildSampleRequestFromUrl(url);
  return {
    endpoint_id: stableEndpointId("GET", computedTemplate + "#page_fetch"),
    method: "GET",
    url_template: computedTemplate,
    idempotency: "safe" as const,
    verification_status: "verified" as const,
    reliability_score: 0.5,
    description: `Returns rendered page for "${intent}" on ${url}`,
    response_schema: { type: "string", format: "html" } as Record<string, unknown>,
    dom_extraction: {
      extraction_method: "page_fetch",
      // 0.5 confidence is intentionally moderate: above the 0.2 quality
      // floor (so it's never filtered out), below typical structured-API
      // scores (so a real /api/ endpoint that matches intent still wins),
      // above DOM-extracted page-artifacts (so when an agent specifically
      // wants the raw page they get it).
      confidence: 0.5,
    },
    trigger_url: url,
    ...(Object.keys(sampleRequest).length > 0 ? { query: sampleRequest } : {}),
    semantic: {
      action_kind: "fetch",
      resource_kind: "page",
      ...(authRequired ? { auth_required: true } : {}),
      description_in: `Fetches the rendered page at ${url}`,
      description_out: `Returns the rendered HTML for "${intent}"`,
      ...(Object.keys(sampleRequest).length > 0 ? { example_request: sampleRequest } : {}),
    },
  };
}

function derivePublicApiEndpointsFromUrl(
  url: string,
  intent: string,
  authRequired = false,
): EndpointDescriptor[] {
  try {
    const u = new URL(url);
    const publicEndpoint = (input: {
      method?: "GET";
      urlTemplate: string;
      query?: Record<string, string>;
      path_params?: Record<string, string>;
      description: string;
      reliability_score?: number;
      response_schema: Record<string, unknown>;
      action_kind: string;
      resource_kind: string;
      description_out: string;
      example_fields: string[];
      provides?: Array<{ key: string; semantic_type: string; source: string }>;
    }): EndpointDescriptor => ({
      endpoint_id: stableEndpointId(input.method ?? "GET", input.urlTemplate),
      method: input.method ?? "GET",
      url_template: input.urlTemplate,
      ...(input.query ? { query: input.query } : {}),
      ...(input.path_params ? { path_params: input.path_params } : {}),
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: input.reliability_score ?? 0.85,
      description: input.description,
      response_schema: input.response_schema,
      trigger_url: url,
      semantic: {
        action_kind: input.action_kind,
        resource_kind: input.resource_kind,
        ...(authRequired ? { auth_required: true } : {}),
        description_in: "Public read-only API endpoint derived from the requested URL",
        description_out: input.description_out,
        example_request: { ...(input.path_params ?? {}), ...(input.query ?? {}) },
        example_fields: input.example_fields,
        provides: input.provides ?? [],
      },
    });

    if (u.hostname === "crates.io" && u.pathname === "/search" && /\b(crate|crates|rust|package|packages|search)\b/i.test(intent)) {
      const q = u.searchParams.get("q") || "";
      if (q) {
        const urlTemplate = "https://crates.io/api/v1/crates?page={page}&per_page={per_page}&sort={sort}&q={q}";
        const endpoint: EndpointDescriptor = {
          endpoint_id: stableEndpointId("GET", urlTemplate),
          method: "GET",
          url_template: urlTemplate,
          query: { page: "1", per_page: "10", sort: "relevance", q },
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
          description: `Public crates.io search API for ${q}`,
          response_schema: {
            type: "object",
            properties: {
              crates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    downloads: { type: "number" },
                    repository: { type: "string" },
                  },
                },
              },
              meta: { type: "object" },
            },
          },
          trigger_url: url,
          semantic: {
            action_kind: "search",
            resource_kind: "crate",
            ...(authRequired ? { auth_required: true } : {}),
            description_in: "Requires page, per_page, sort, q",
            description_out: `Searches crates.io crates for ${q}`,
            example_request: { page: "1", per_page: "10", sort: "relevance", q },
            example_fields: ["crates[].id", "crates[].name", "crates[].description", "crates[].downloads", "meta.total"],
            requires: [
              { key: "page", required: false, source: "query", semantic_type: "input" },
              { key: "per_page", required: false, source: "query", semantic_type: "input" },
              { key: "sort", required: false, source: "query", semantic_type: "input" },
              { key: "q", required: false, source: "query", semantic_type: "input" },
            ],
            provides: [
              { key: "crate_name", semantic_type: "resource_name", source: "response" },
              { key: "crate_id", semantic_type: "resource_identifier", source: "response" },
            ],
          },
        };
        return [endpoint];
      }
    }
    const stackQuestion = u.hostname === "stackoverflow.com"
      ? u.pathname.match(/^\/questions\/(\d+)(?:\/|$)/)
      : null;
    if (stackQuestion && /\b(stack ?overflow|question|answer|answers)\b/i.test(intent)) {
      const question_id = stackQuestion[1];
      const urlTemplate = `https://api.stackexchange.com/2.3/questions/${question_id}?order={order}&sort={sort}&site={site}&filter={filter}`;
      return [publicEndpoint({
        urlTemplate,
        path_params: { question_id },
        query: { order: "desc", sort: "activity", site: "stackoverflow", filter: "withbody" },
        description: `Public Stack Exchange question API for ${question_id}`,
        reliability_score: 0.9,
        response_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  question_id: { type: "number" },
                  title: { type: "string" },
                  body: { type: "string" },
                  link: { type: "string" },
                  tags: { type: "array" },
                  answer_count: { type: "number" },
                },
              },
            },
          },
        },
        action_kind: "fetch",
        resource_kind: "question",
        description_out: `Returns StackOverflow question ${question_id} with title, body, tags, and answer counts`,
        example_fields: ["items[].question_id", "items[].title", "items[].body", "items[].link", "items[].answer_count"],
        provides: [
          { key: "question_id", semantic_type: "resource_identifier", source: "response" },
          { key: "question_title", semantic_type: "resource_name", source: "response" },
        ],
      })];
    }
    const openLibraryWork = u.hostname === "openlibrary.org"
      ? u.pathname.match(/^\/works\/([^/?#]+)/)
      : null;
    if (openLibraryWork && /\b(openlibrary|work|book|author|description)\b/i.test(intent)) {
      const work_id = decodeURIComponent(openLibraryWork[1]).replace(/\.json$/i, "");
      const urlTemplate = `https://openlibrary.org/works/${work_id}.json`;
      return [publicEndpoint({
        urlTemplate,
        path_params: { work_id },
        description: `Public OpenLibrary work API for ${work_id}`,
        reliability_score: 0.9,
        response_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: {},
            subjects: { type: "array" },
            authors: { type: "array" },
            first_publish_date: { type: "string" },
            key: { type: "string" },
          },
        },
        action_kind: "fetch",
        resource_kind: "book",
        description_out: `Returns OpenLibrary work metadata for ${work_id}`,
        example_fields: ["title", "description", "subjects", "authors[].author.key", "first_publish_date"],
        provides: [
          { key: "work_id", semantic_type: "resource_identifier", source: "response" },
          { key: "title", semantic_type: "resource_name", source: "response" },
        ],
      })];
    }
    if (u.hostname === "beatsaver.com" && /\b(beatsaver|beat saber|maps?|search)\b/i.test(intent)) {
      const q = u.searchParams.get("q") || "";
      if (q) {
        const urlTemplate = "https://api.beatsaver.com/search/text/0?q={q}";
        return [publicEndpoint({
          urlTemplate,
          path_params: { page: "0" },
          query: { q },
          description: `Public BeatSaver text search API for ${q}`,
          response_schema: {
            type: "object",
            properties: {
              docs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    uploader: { type: "object" },
                    stats: { type: "object" },
                  },
                },
              },
            },
          },
          action_kind: "search",
          resource_kind: "map",
          description_out: `Searches BeatSaver maps for ${q}`,
          example_fields: ["docs[].id", "docs[].name", "docs[].description", "docs[].uploader.name", "docs[].stats.downloads"],
          provides: [
            { key: "map_id", semantic_type: "resource_identifier", source: "response" },
            { key: "map_name", semantic_type: "resource_name", source: "response" },
          ],
        })];
      }
    }
    const jupiterSwap = u.hostname === "jup.ag"
      ? u.pathname.match(/^\/swap\/([A-Za-z0-9]+)-([A-Za-z0-9]+)/)
      : null;
    if (jupiterSwap && /\b(jupiter|jup|swap|quote|price)\b/i.test(intent)) {
      const mintBySymbol: Record<string, string> = {
        SOL: "So11111111111111111111111111111111111111112",
        USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        USDT: "Es9vMFrzaCERmJfrF4H2FYD4T2nJw6T5ShZMQ4tXoFd",
      };
      const inputSymbol = jupiterSwap[1].toUpperCase();
      const outputSymbol = jupiterSwap[2].toUpperCase();
      const inputMint = mintBySymbol[inputSymbol];
      const outputMint = mintBySymbol[outputSymbol];
      if (inputMint && outputMint) {
        const urlTemplate = "https://api.jup.ag/swap/v1/quote?inputMint={inputMint}&outputMint={outputMint}&amount={amount}";
        return [publicEndpoint({
          urlTemplate,
          query: { inputMint, outputMint, amount: "1000000000" },
          description: `Public Jupiter quote API for ${inputSymbol}-${outputSymbol}`,
          response_schema: {
            type: "object",
            properties: {
              inputMint: { type: "string" },
              outputMint: { type: "string" },
              inAmount: { type: "string" },
              outAmount: { type: "string" },
              routePlan: { type: "array" },
            },
          },
          action_kind: "fetch",
          resource_kind: "quote",
          description_out: `Returns Jupiter swap quote from ${inputSymbol} to ${outputSymbol}`,
          example_fields: ["inputMint", "outputMint", "inAmount", "outAmount", "routePlan[].swapInfo.label"],
          provides: [
            { key: "outAmount", semantic_type: "price_or_quote", source: "response" },
          ],
        })];
      }
    }
    if (u.hostname === "www.espn.com" && /^\/nba\/scoreboard\/?$/i.test(u.pathname) && /\b(scoreboard|nba|scores?|games?)\b/i.test(intent)) {
      const urlTemplate = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";
      return [publicEndpoint({
        urlTemplate,
        description: "Public ESPN NBA scoreboard API",
        reliability_score: 0.9,
        response_schema: {
          type: "object",
          properties: {
            events: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  date: { type: "string" },
                  competitions: { type: "array" },
                  status: { type: "object" },
                },
              },
            },
          },
        },
        action_kind: "list",
        resource_kind: "game",
        description_out: "Returns NBA scoreboard events, competitors, status, and scores",
        example_fields: ["events[].name", "events[].date", "events[].competitions[].competitors[].score", "events[].status.type.description"],
        provides: [
          { key: "game_name", semantic_type: "resource_name", source: "response" },
          { key: "score", semantic_type: "score", source: "response" },
        ],
      })];
    }
    const dockerMatch = u.hostname === "hub.docker.com"
      ? u.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/tags\/?$/)
      : null;
    if (dockerMatch && /\b(image tags?|docker(?:hub)?|tags?)\b/i.test(intent)) {
      const namespace = decodeURIComponent(dockerMatch[1]);
      const repository = decodeURIComponent(dockerMatch[2]);
      const urlTemplate = "https://registry.hub.docker.com/v2/repositories/{namespace}/{repository}/tags?page_size={page_size}";
      const endpoint: EndpointDescriptor = {
        endpoint_id: stableEndpointId("GET", urlTemplate),
        method: "GET",
        url_template: urlTemplate,
        path_params: { namespace, repository },
        query: { page_size: "25" },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.85,
        description: `Public Docker Hub tags API for ${namespace}/${repository}`,
        response_schema: {
          type: "object",
          properties: {
            count: { type: "number" },
            next: { type: ["string", "null"] },
            previous: { type: ["string", "null"] },
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  full_size: { type: "number" },
                  last_updated: { type: "string" },
                  images: { type: "array" },
                },
              },
            },
          },
        },
        trigger_url: url,
        semantic: {
          action_kind: "list",
          resource_kind: "image",
          ...(authRequired ? { auth_required: true } : {}),
          description_in: "Requires namespace, repository, page_size",
          description_out: `Returns Docker Hub image tags for ${namespace}/${repository}`,
          example_request: { namespace, repository, page_size: "25" },
          example_fields: ["results[].name", "results[].full_size", "results[].last_updated", "results[].images"],
          requires: [
            { key: "namespace", required: false, source: "path_params", semantic_type: "input" },
            { key: "repository", required: false, source: "path_params", semantic_type: "input" },
            { key: "page_size", required: false, source: "query", semantic_type: "input" },
          ],
          provides: [
            { key: "tag_name", semantic_type: "image_tag_name", source: "response" },
          ],
        },
      };
      return [endpoint];
    }
    const devToUser = u.hostname === "dev.to"
      ? u.pathname.match(/^\/([^/?#]+)\/?$/)
      : null;
    if (devToUser && /\b(devto|dev\.to|post|posts|article|articles)\b/i.test(intent)) {
      const username = decodeURIComponent(devToUser[1]);
      if (!/^(enter|signin|login|search|tags|new|settings|notifications)$/i.test(username)) {
        const urlTemplate = "https://dev.to/api/articles?username={username}";
        const endpoint: EndpointDescriptor = {
          endpoint_id: stableEndpointId("GET", urlTemplate),
          method: "GET",
          url_template: urlTemplate,
          query: { username },
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.85,
          description: `Public DEV articles API for ${username}`,
          response_schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                description: { type: "string" },
                published_at: { type: "string" },
                tag_list: { type: "array" },
              },
            },
          },
          trigger_url: url,
          semantic: {
            action_kind: "list",
            resource_kind: "post",
            ...(authRequired ? { auth_required: true } : {}),
            description_in: "Requires username",
            description_out: `Returns DEV articles for ${username}`,
            example_request: { username },
            example_fields: ["[].title", "[].url", "[].description", "[].published_at", "[].tag_list"],
            requires: [
              { key: "username", required: false, source: "query", semantic_type: "input" },
            ],
            provides: [
              { key: "post_title", semantic_type: "post_title", source: "response" },
              { key: "post_url", semantic_type: "post_url", source: "response" },
            ],
          },
        };
        return [endpoint];
      }
    }
  } catch {
    return [];
  }
  return [];
}

export function isPageFetchEndpoint(ep: EndpointDescriptor): boolean {
  if (ep.dom_extraction?.extraction_method === "page_fetch") return true;
  const schema = ep.response_schema as Record<string, unknown> | undefined;
  const description = ep.description ?? "";
  if (ep.dom_extraction && /rendered (?:html|page)|fetches the rendered page|returns the rendered html/i.test(description)) return true;
  return !!ep.dom_extraction
    && schema?.type === "string"
    && schema?.format === "html"
    && /rendered (?:html|page)|fetches the rendered page|returns the rendered html/i.test(description);
}

async function trySeedPublicDocumentFetchSkill(
  skill: SkillManifest,
  url: string,
  intent: string,
  targetDomain: string,
  authHeaders: Record<string, string> | undefined,
  cookies: Array<{ name: string; value: string; domain: string }> | undefined,
  usedStoredAuth: boolean,
): Promise<ExecutionResult | undefined> {
  const directPublicEndpoints = derivePublicApiEndpointsFromUrl(url, intent, usedStoredAuth);
  if (directPublicEndpoints.length > 0) {
    const domain = getRegistrableDomain(targetDomain);
    const existingSkill = findExistingSkillForDomain(domain, intent);
    const localEndpoints = await prepareLearnedEndpoints(
      existingSkill ? mergeEndpoints(existingSkill.endpoints, directPublicEndpoints) : directPublicEndpoints,
      intent,
      domain,
    );
    const localDraft: SkillManifest = {
      skill_id: existingSkill?.skill_id ?? nanoid(),
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active" as const,
      execution_type: "http" as const,
      created_at: existingSkill?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      name: domain,
      intent_signature: intent,
      domain,
      description: `API skill for ${domain}`,
      owner_type: "agent" as const,
      endpoints: localEndpoints,
      operation_graph: buildSkillOperationGraph(localEndpoints),
      intents: Array.from(new Set([...(existingSkill?.intents ?? []), intent])),
      ...(usedStoredAuth ? { auth_profile_ref: `${domain}-session` } : {}),
    };
    try { cachePublishedSkill(localDraft); } catch { /* best-effort */ }
    const trace: ExecutionTrace = stampTrace({
      trace_id: nanoid(),
      skill_id: localDraft.skill_id,
      endpoint_id: "browser-capture",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: true,
      result: {
        learned_skill_id: localDraft.skill_id,
        endpoints_discovered: localEndpoints.length,
        seeded_from: "public_api_template",
      },
    });
    return {
      trace,
      result: trace.result,
      learned_skill: localDraft,
    };
  }

  const headers: Record<string, string> = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "user-agent": DEFAULT_BROWSER_UA,
    "accept-language": "en-US,en;q=0.9",
    ...(authHeaders ?? {}),
  };
  if (cookies && cookies.length > 0) {
    headers.cookie = cookies.map((c) => {
      const v = c.value.startsWith('"') && c.value.endsWith('"') ? c.value.slice(1, -1) : c.value;
      return `${c.name}=${v}`;
    }).join("; ");
  }

  const response = await fetch(url, {
    method: "GET",
    headers: buildStructuredReplayHeaders(url, url, headers),
    redirect: "follow",
  });
  const html = await response.text();

  // JSON short-circuit: if the URL directly serves JSON, the URL IS the endpoint.
  // No browser capture needed — build a stable GET endpoint from the response.
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (response.ok && (contentType.includes("application/json") || contentType.includes("text/json"))) {
    try {
      const parsed = JSON.parse(html);
      const urlObj = new URL(response.url || url);
      const pathTemplate = `${urlObj.origin}${urlObj.pathname}`;
      const responseSchema = inferSchema([parsed]);
      const endpoint: EndpointDescriptor = {
        endpoint_id: stableEndpointId("GET", pathTemplate),
        method: "GET",
        url_template: pathTemplate,
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.95,
        description: `Direct JSON API for ${intent}`,
        response_schema: responseSchema,
      };
      endpoint.semantic = inferEndpointSemantic(endpoint, {
        sampleResponse: parsed,
        observedAt: new Date().toISOString(),
        sampleRequestUrl: url,
      });

      const domain = getRegistrableDomain(targetDomain);
      const existingSkill = findExistingSkillForDomain(domain, intent);
      const localEndpoints = await prepareLearnedEndpoints(
        existingSkill ? mergeEndpoints(existingSkill.endpoints, [endpoint]) : [endpoint],
        intent,
        domain,
      );
      const localDraft: SkillManifest = {
        skill_id: existingSkill?.skill_id ?? nanoid(),
        version: "1.0.0",
        schema_version: "1",
        lifecycle: "active" as const,
        execution_type: "http" as const,
        created_at: existingSkill?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        name: domain,
        intent_signature: intent,
        domain,
        description: `API skill for ${domain}`,
        owner_type: "agent" as const,
        endpoints: localEndpoints,
        operation_graph: buildSkillOperationGraph(localEndpoints),
        intents: [intent],
      };
      try { cachePublishedSkill(localDraft); } catch { /* best-effort */ }

      return {
        trace: stampTrace({
          trace_id: nanoid(),
          skill_id: localDraft.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: true,
          status_code: response.status,
        }),
        result: parsed as Record<string, unknown>,
      };
    } catch { /* not valid JSON — fall through */ }
  }

  if (!isHtml(html) || isSpaShell(html)) return undefined;

  const built = buildPageArtifactCapture(response.url || url, intent, html, usedStoredAuth);
  if (!built.endpoint) return undefined;

  const domain = getRegistrableDomain(targetDomain);
  const existingSkill = findExistingSkillForDomain(domain, intent);
  const publicApiEndpoints = derivePublicApiEndpointsFromUrl(response.url || url, intent, usedStoredAuth);
  const localEndpoints = await prepareLearnedEndpoints(
    existingSkill
      ? mergeEndpoints(existingSkill.endpoints, [...publicApiEndpoints, built.endpoint])
      : [...publicApiEndpoints, built.endpoint],
    intent,
    domain,
  );

  const localDraft: SkillManifest = {
    skill_id: existingSkill?.skill_id ?? nanoid(),
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active" as const,
    execution_type: "http" as const,
    created_at: existingSkill?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: domain,
    intent_signature: intent,
    domain,
    description: `API skill for ${domain}`,
    owner_type: "agent" as const,
    endpoints: localEndpoints,
    operation_graph: buildSkillOperationGraph(localEndpoints),
    intents: Array.from(new Set([...(existingSkill?.intents ?? []), intent])),
    ...(usedStoredAuth ? { auth_profile_ref: `${domain}-session` } : {}),
  };

  let learned: SkillManifest = localDraft;
  const validation = await validateManifest({ ...localDraft, skill_id: "__validate__" });
  const admission = selectMarketplacePublishEndpoints(localDraft);
  if (validation.valid && admission.endpoints.length > 0) {
    try {
      const { operation_graph: _graph, ...publishDraft } = localDraft;
      const published = await publishSkill(publishDraft);
      learned = {
        ...published,
        endpoints: localEndpoints,
        operation_graph: localDraft.operation_graph,
      };
    } catch {
      learned = localDraft;
    }
  } else if (admission.endpoints.length === 0) {
    console.warn(`[publish] direct publish skipped for ${localDraft.skill_id}: ${admission.stats.by_reason.dom_fallback_only > 0 ? "dom_fallback_only" : "no admitted endpoints"}`);
  }
  try { cachePublishedSkill(learned); } catch { /* best-effort */ }
  const seededRequest: RawRequest = {
    url,
    method: "GET",
    request_headers: headers,
    response_status: response.status,
    response_headers: Object.fromEntries(response.headers.entries()),
    response_body: html,
    timestamp: new Date().toISOString(),
  };
  persistWorkflowArtifactForCapture(
    learned,
    {
      requests: [seededRequest],
      har_lineage_id: `seeded:${learned.skill_id}:document-fetch`,
      final_url: response.url || url,
      html,
      cookies: cookies ?? [],
      js_bundles: new Map(),
    },
    authHeaders,
  );

  const trace: ExecutionTrace = stampTrace({
    trace_id: nanoid(),
    skill_id: learned.skill_id,
    endpoint_id: "browser-capture",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
      success: true,
      result: {
        learned_skill_id: learned.skill_id,
        endpoints_discovered: localEndpoints.length,
        seeded_from: "document_fetch",
      },
  });
  return {
    trace,
    result: trace.result,
    learned_skill: learned,
  };
}

export async function executeSkill(
  skill: SkillManifest,
  params: Record<string, unknown> = {},
  projection?: ProjectionOptions,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  if (skill.execution_type === "browser-capture") {
    return executeBrowserCapture(skill, params, options);
  }

  // Allow targeting a specific endpoint by ID — never silently fall back
  if (params.endpoint_id) {
    const target = skill.endpoints.find((e) => e.endpoint_id === params.endpoint_id);
    if (target) {
      const { endpoint_id: _, ...cleanParams } = params;
      return executeEndpoint(skill, target, cleanParams, projection, options);
    }
    // BUG-3 recovery: the agent's resolve returned this endpoint_id, but
    // the currently-loaded skill snapshot no longer has it. This happens
    // when publish or a concurrent capture re-merged endpoints with a
    // url_template normalization shift, OR when the skill was rebuilt
    // between the agent's resolve and execute calls. Search the local
    // skill-snapshot history for any snapshot (this skill_id first, then
    // any) that still has this endpoint_id; since stableEndpointId is a
    // deterministic hash of (method, url_template), a matching ID means
    // the same logical operation. Honor the agent's contract instead of
    // failing the call.
    const historic = findEndpointInSkillHistory(
      String(params.endpoint_id),
      skill.skill_id,
    );
    if (historic) {
      log(
        "exec",
        `endpoint ${params.endpoint_id} not in current skill ${skill.skill_id} (${skill.endpoints.length} endpoints); recovered from history snapshot of skill ${historic.via_skill.skill_id}`,
      );
      const { endpoint_id: _, ...cleanParams } = params;
      // Use the historic endpoint descriptor against the current skill
      // (so auth / session lookups use the current skill's domain etc.).
      // The endpoint's method + url_template carry the operation.
      return executeEndpoint(skill, historic.endpoint, cleanParams, projection, options);
    }
    // Agent explicitly chose this endpoint and even the snapshot history
    // doesn't have it — surface the failure with the candidates the agent
    // could pick from instead.
    log("exec", `endpoint ${params.endpoint_id} not found in skill ${skill.skill_id} or any snapshot history (${skill.endpoints.length} endpoints: ${skill.endpoints.map(e => e.endpoint_id).join(", ")})`);
    const trace: ExecutionTrace = {
      trace_id: nanoid(),
      skill_id: skill.skill_id,
      endpoint_id: String(params.endpoint_id),
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: false,
      error: `endpoint_not_found: ${params.endpoint_id} not in skill ${skill.skill_id}`,
    };
    return {
      trace,
      result: {
        error: "endpoint_not_found",
        message: `Endpoint ${params.endpoint_id} not found in skill ${skill.skill_id} (and not in snapshot history). Available: ${skill.endpoints.map(e => `${e.endpoint_id} (${e.description?.slice(0, 50)})`).join(", ")}`,
        available_endpoints: skill.endpoints.map(e => ({ endpoint_id: e.endpoint_id, description: e.description })),
      },
    };
  }

  // Use the caller's intent for ranking when available, fall back to skill's original intent
  try {
    const endpoint = selectBestEndpoint(skill.endpoints, options?.intent ?? skill.intent_signature, skill.domain, options?.contextUrl);
    return executeEndpoint(skill, endpoint, params, projection, options);
  } catch (err) {
  // handle "No endpoints available" and other selection failures gracefully
  const trace: ExecutionTrace = {
    trace_id: nanoid(),
    skill_id: skill.skill_id,
    endpoint_id: "none",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    success: false,
    error: err instanceof Error ? err.message : "endpoint_selection_failed",
  };
  return { trace, result: { error: "no_endpoints", message: err instanceof Error ? err.message : "Failed to select an endpoint", available_endpoints: skill.endpoints.map(e => ({ endpoint_id: e.endpoint_id, description: e.description })) } };
  }
}

async function executeBrowserCapture(
  skill: SkillManifest,
  params: Record<string, unknown>,
  options?: ExecutionOptions,
): Promise<ExecutionResult> {
  const fallbackUrl =
    (typeof params.context_url === "string" && params.context_url) ||
    skill.endpoints.find((endpoint) => typeof endpoint.trigger_url === "string" && endpoint.trigger_url)?.trigger_url ||
    skill.endpoints.find((endpoint) => !/\{[^}]+\}/.test(endpoint.url_template))?.url_template ||
    "";
  const url = typeof params.url === "string" ? params.url : String(params.url ?? fallbackUrl);
  const intent = String(params.intent ?? skill.intent_signature);
  if (!url) throw new Error("browser-capture skill requires params.url");

  const startedAt = new Date().toISOString();
  const traceId = nanoid();
  const targetDomain = new URL(url).hostname;

  // BUG-002/003 fix: auto-load vault cookies for the target domain
  let authHeaders = params.auth_headers as Record<string, string> | undefined;
  let cookies = params.cookies as Array<{ name: string; value: string; domain: string }> | undefined;
  let usedStoredAuth = !!(cookies && cookies.length > 0) || !!(authHeaders && Object.keys(authHeaders).length > 0);

  // Auto-resolve cookies from vault, falling back to browser extraction
  if (!cookies || cookies.length === 0) {
    const resolved = await getAuthCookies(targetDomain, { autoExtract: true });
    if (resolved && resolved.length > 0) {
      cookies = resolved;
      usedStoredAuth = true;
    }
  }
  const documentSeed = await trySeedPublicDocumentFetchSkill(
    skill,
    url,
    intent,
    targetDomain,
    authHeaders,
    cookies,
    usedStoredAuth,
  );
  if (documentSeed) return documentSeed;
  let captured;
  try {
    captured = await captureSession(url, authHeaders, cookies, intent);

    // Anti-bot auto-fallback: many vendors (Cloudflare, Fastly, Datadome,
    // PerimeterX, etc.) block --headless=new specifically while letting a
    // visible Chrome window through. If the first capture clearly hit one of
    // those walls, retry once with a visible window. One-shot per call:
    // subsequent captures benefit from cookies persisted in Kuri's profile.
    //
    // Skipped when HEADLESS=false already, opted out, or no controlling TTY.
    {
      const optedOut = process.env.UNBROWSE_NO_VISIBLE_FALLBACK === "1";
      const alreadyVisible = !kuri.resolveKuriLaunchConfig(process.env).headless;
      const isInteractive = !!(process.stdout && process.stdout.isTTY) || !!(process.stderr && process.stderr.isTTY);
      if (!optedOut && !alreadyVisible && isInteractive) {
        const headlessTitle = (() => {
          const m = (captured.html ?? "").toLowerCase().match(/<title[^>]*>([^<]{0,200})<\/title>/);
          return m ? m[1].trim() : "";
        })();
        const requestUrls = (captured.requests ?? []).map((r) => r.url ?? "");
        const blockSignals = detectBrowserBlockSignals({
          requestUrls,
          title: headlessTitle,
          htmlLength: (captured.html ?? "").length,
          rejectionCounts: {},
        });
        const wallSignal = blockSignals.find((s) =>
          s === "challenge_title" || s.startsWith("vendor:")
        );
        if (wallSignal) {
          process.stderr.write(
            `[unbrowse] Anti-bot wall detected (${wallSignal}). Retrying once with visible browser — pop a Chrome window for ~5s, future captures stay headless.\n`,
          );
          const restoreVisibleKuriEnv = forceVisibleKuriEnv();
          try {
            await kuri.stop();
            await kuri.start();
            captured = await captureSession(url, authHeaders, cookies, intent);
          } finally {
            restoreVisibleKuriEnv();
            try { await kuri.stop(); await kuri.start(); } catch { /* best-effort restart back to headless */ }
          }
        }
      }
    }
  } catch (captureErr: unknown) {
    const err = captureErr as Error & { code?: string; login_url?: string };
    if (err.code === "auth_required") {
      const trace: ExecutionTrace = stampTrace({
        trace_id: traceId,
        skill_id: skill.skill_id,
        endpoint_id: "browser-capture",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        success: false,
        error: "auth_required",
      });
      return {
        trace,
        result: {
          error: "auth_required",
          provider: "cloudflare",
          login_url: err.login_url ?? url,
          message: `Site is blocked by Cloudflare WAF. Run: unbrowse login --url "${url}" to authenticate interactively.`,
        },
      };
    }
    const message = captureErr instanceof Error ? captureErr.message : String(captureErr);
    // Plan-v12 Phase B: no_progress_bail from captureSession → try SSR
    // fast-path rescue before declaring capture_failed. Bail fires when
    // the page made ZERO network requests in 30s — libcurl-impersonate
    // (Chrome 131 JA4) is more likely to return useful HTML than waiting
    // longer on a hung Kuri tab. Mirrors the auth_required vendor-challenge
    // SSR rescue at L1095 but synthesizes a return directly since we have
    // no captured.* state to splice into.
    if (err.code === "no_progress_bail") {
      try {
        const { trySsrFastPathOnBlock } = await import("../capture/ssr-fastpath.js");
        const ssr = await trySsrFastPathOnBlock({
          url, seedCookies: cookies, timeoutMs: 15_000,
          proxy: process.env.UNBROWSE_PROXY_URL,
        });
        if (ssr?.html && ssr.html.length > 1024) {
          const ssrArtifact = buildPageArtifactCapture(url, intent, ssr.html, false);
          if (ssrArtifact.endpoint && ssrArtifact.result) {
            log("execution", `no_progress_bail_ssr_fastpath_success: ${ssr.html.length} bytes from libcurl`);
            const trace: ExecutionTrace = stampTrace({
              trace_id: traceId,
              skill_id: skill.skill_id,
              endpoint_id: "browser-capture",
              started_at: startedAt,
              completed_at: new Date().toISOString(),
              success: true,
              decision_trace: [{ step: "no_progress_bail_ssr_fastpath_success", html_bytes: ssr.html.length }],
            });
            return { trace, result: ssrArtifact.result as Record<string, unknown> };
          }
          log("execution", "no_progress_bail_ssr_fastpath_failed_extraction_quality");
        } else {
          log("execution", "no_progress_bail_ssr_fastpath_failed_no_html");
        }
      } catch (ssrErr) {
        log("execution", `no_progress_bail_ssr_fastpath_error: ${ssrErr instanceof Error ? ssrErr.message : String(ssrErr)}`);
      }
      // SSR rescue failed → fall through to normal error normalization
    }
    const normalizedError = /unable to connect/i.test(message)
      ? "connection_failed"
      : /timed out/i.test(message)
        ? "capture_timeout"
        : "capture_failed";
    const trace: ExecutionTrace = stampTrace({
      trace_id: traceId,
      skill_id: skill.skill_id,
      endpoint_id: "browser-capture",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      success: false,
      error: normalizedError,
    });
    return {
      trace,
      result: {
        error: normalizedError,
        message,
      },
    };
  }

  const finalDomain = (() => {
    try { return new URL(captured.final_url).hostname; } catch { return targetDomain; }
  })();
  const AUTH_PROVIDERS = /accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|appleid\.apple\.com|github\.com|facebook\.com/i;
  const LOGIN_PATHS = /\/(login|signin|sign-in|sso|auth|uas\/login|checkpoint|oauth)/i;

  const redirectedToAuth = finalDomain !== targetDomain && AUTH_PROVIDERS.test(finalDomain);
  const redirectedToLogin = captured.final_url !== url && (() => { try { return LOGIN_PATHS.test(new URL(String(captured.final_url)).pathname); } catch { return false; } })();

  if (redirectedToAuth || redirectedToLogin) {
    // Phase B (plan-v10): before declaring auth_required, check whether the
    // capture saw an anti-bot vendor marker — if yes, the "auth wall" was
    // likely vendor-induced (Cloudflare/DataDome/PerimeterX serving a login
    // page to non-browsers), and libcurl-impersonate may bypass it. If the
    // capture saw NO vendor markers, this is real auth and SSR fast-path
    // would just burn 15s before the same conclusion.
    const requestUrls = (captured.requests ?? []).map((r) => String(r.url ?? ""));
    const hasVendorChallenge = requestUrls.some((u) =>
      /(captcha-delivery|cdn-cgi\/challenge-platform|datadome|perimeterx|kasada|akamai-bot|akm_bmfp|kpsdk|_abck=|_pxhd)/i.test(u),
    );
    if (hasVendorChallenge) {
      try {
        const { trySsrFastPathOnBlock } = await import("../capture/ssr-fastpath.js");
        const ssr = await trySsrFastPathOnBlock({ url, seedCookies: captured.cookies, timeoutMs: 15_000, proxy: process.env.UNBROWSE_PROXY_URL });
        if (ssr?.html && ssr.html.length > 1024) {
          const ssrArtifact = buildPageArtifactCapture(url, intent, ssr.html, false);
          if (ssrArtifact.endpoint && ssrArtifact.result) {
            log("execution", `auth_required_ssr_reroute_success: ${ssr.html.length} bytes from libcurl, vendor signal detected (${requestUrls.find((u) => /captcha-delivery|cdn-cgi|datadome|perimeterx|kasada|akamai-bot|akm_bmfp|kpsdk|_abck|_pxhd/i.test(u))?.slice(0, 80)})`);
            (captured as { html?: string }).html = ssr.html;
          } else {
            log("execution", `auth_required_ssr_reroute_failed_extraction_quality: ssrArtifact lacks endpoint+result`);
          }
        } else {
          log("execution", `auth_required_ssr_reroute_failed_no_html: ssr null or <1KB`);
        }
      } catch (err) {
        log("execution", `auth_required_ssr_reroute_error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      log("execution", `auth_required_ssr_reroute_skipped_no_vendor_signal: real auth, returning auth_required`);
    }

    // If SSR didn't unlock OR no vendor signal, return auth_required as before
    if (!hasVendorChallenge || !((captured as { html?: string }).html && (captured as { html?: string }).html!.length > 1024 && /<(html|body)/i.test((captured as { html?: string }).html!))) {
      const trace: ExecutionTrace = stampTrace({
        trace_id: traceId,
        skill_id: skill.skill_id,
        endpoint_id: "browser-capture",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        success: false,
        error: "auth_required",
      });
      return {
        trace,
        result: {
          error: "auth_required",
          provider: getRegistrableDomain(finalDomain),
          login_url: captured.final_url,
          message: `Site requires authentication. Call POST /v1/auth/login with {"url": "${captured.final_url}"} to log in interactively, or pass cookies via params.cookies / headers via params.auth_headers.`,
        },
      };
    }
    // Else fall through with overridden captured.html — extractEndpoints will run on the libcurl HTML
  }
  const extractionTrace: { rows?: Array<Record<string, unknown>> } = {};
  const endpoints = extractEndpoints(captured.requests, captured.ws_messages, { pageUrl: url, finalUrl: captured.final_url, intent }, extractionTrace);

  // Compute structured capture metadata once — used on every failure-path
  // early return so the agent can judge browser-block vs product-bug from
  // one consistent shape. Called lazily so happy-path has no overhead.
  const computeCapturedMeta = () => {
    const html = captured.html ?? "";
    const titleMatch = html.toLowerCase().match(/<title[^>]*>([^<]{0,200})<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : "";
    const stripped = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    const text = stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    let intentVerdict: "pass" | "fail" | "skip" = "skip";
    let intentReason = "no_semantic_assessment";
    if (text && intent) {
      try {
        const assessment = assessIntentResult(text, intent);
        intentVerdict = assessment.verdict;
        intentReason = assessment.reason;
      } catch { /* best effort */ }
    }
    const rows = extractionTrace.rows ?? [];
    const rejectionCounts: Record<string, number> = {};
    const samplesByReason: Record<string, string[]> = {};
    const PER_REASON_SAMPLE_CAP = 5;
    for (const row of rows) {
      if (row.kept === true) continue;
      const reason = String(row.reason ?? "unknown");
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
      if (typeof row.url === "string") {
        const bucket = samplesByReason[reason] ?? (samplesByReason[reason] = []);
        if (bucket.length < PER_REASON_SAMPLE_CAP) bucket.push(row.url);
      }
    }
    const rejectedSamples: Array<{ url: string; reason: string }> = [];
    for (const [reason, urls] of Object.entries(samplesByReason)) {
      for (const u of urls) rejectedSamples.push({ url: u, reason });
    }
    const apiCallCount = captured.requests?.length ?? 0;
    const requestUrls = (captured.requests ?? []).map((r) => r.url ?? "");
    const blockSignals = detectBrowserBlockSignals({
      requestUrls,
      title,
      htmlLength: html.length,
      rejectionCounts,
    });
    const bundleSnapshot = extractBundleSnapshot({
      requestUrls,
      blockSignals,
      targetOrigin: (() => { try { return new URL(url).origin; } catch { return url; } })(),
      targetHref: url,
    });
    return {
      html_bytes: html.length,
      title,
      text_bytes: text.length,
      observed_api_calls: apiCallCount,
      intent_verdict: intentVerdict,
      intent_reason: intentReason,
      filter_rejections: rejectionCounts,
      rejected_samples: rejectedSamples,
      browser_block_signals: blockSignals,
      ...(bundleSnapshot ? { bundle_snapshot: bundleSnapshot } : {}),
    };
  };

  // Detect structured search forms from captured HTML and attach to search-like endpoints
  if (captured.html) {
    const detectedForms = detectSearchForms(captured.html);
    if (detectedForms.length > 0) {
      for (const ep of endpoints) {
        if (!ep.search_form && ep.method === "GET") {
          const matchingForm = detectedForms.find((f) => isStructuredSearchForm(f));
          if (matchingForm) {
            ep.search_form = matchingForm;
            break; // attach the best form to the first search-like GET endpoint
          }
        }
      }
    }
  }

  // JS bundle scanning: discover API routes not seen in network traffic
  if (captured.js_bundles && captured.js_bundles.size > 0) {
    const pageOrigin = new URL(url).origin;
    const bundleRoutes = scanBundlesForRoutes(captured.js_bundles, pageOrigin);

    // Build set of already-discovered URL paths for deduplication
    const networkPaths = new Set<string>();
    for (const ep of endpoints) {
      try {
        const normalized = new URL(ep.url_template).pathname
          .replace(/\{[^}]+\}/g, "*")
          .replace(/\/+$/, "");
        networkPaths.add(normalized);
      } catch { /* skip */ }
    }

    let added = 0;
    for (const route of bundleRoutes) {
      const normalized = route.path.replace(/\/+$/, "");
      if (networkPaths.has(normalized)) continue;

      // Check if a network endpoint's wildcard pattern matches this route
      let isDup = false;
      for (const np of networkPaths) {
        if (np.includes("*")) {
          const re = new RegExp("^" + np.replace(/\*/g, "[^/]+") + "$");
          if (re.test(normalized)) { isDup = true; break; }
        }
      }
      if (isDup) continue;

      // Build query template from bundle-inferred param names
      let epUrl = route.url;
      let epQuery: Record<string, unknown> | undefined;
      let queryParamNames = route.query_params ? [...route.query_params] : [];
      if (queryParamNames.length === 0) {
        try {
          const triggerUrl = new URL(url);
          const triggerParams = [...triggerUrl.searchParams.keys()].filter((k) =>
            /^(q|query|search|term|type|tag|sort|page)$/i.test(k)
          );
          if (triggerParams.length > 0 && /\/(search|lookup|find)\b/i.test(route.path)) {
            queryParamNames = triggerParams;
          }
        } catch { /* skip */ }
      }
      if (queryParamNames.length > 0) {
        epQuery = {};
        for (const p of queryParamNames) epQuery[p] = "";
        const qStr = queryParamNames.map((k) => `${encodeURIComponent(k)}={${k}}`).join("&");
        epUrl = `${route.url}?${qStr}`;
      }

      endpoints.push({
        endpoint_id: stableEndpointId("GET", epUrl),
        method: "GET",
        url_template: epUrl,
        query: epQuery,
        idempotency: "safe",
        verification_status: "pending",
        reliability_score: 0.2,
        description: `Inferred from JS bundle (${route.match_type}). Not observed in network traffic.`,
        trigger_url: url,
      });
      added++;
      networkPaths.add(normalized);
    }

    if (added > 0) {
      log("execution", `added ${added} inferred endpoints from JS bundle scanning`);
    }
  }

  let cleanEndpoints = endpoints.filter((ep) => {
    try {
      const host = new URL(ep.url_template).hostname;
      return !AUTH_PROVIDERS.test(host) && !LOGIN_PATHS.test(new URL(ep.url_template).pathname);
    } catch { return true; }
  });

  const domain = captured.domain;

  // Persist session cookies + auth headers so server-fetch works without browser.
  // extractAuthHeaders collects everything sanitizeHeaders strips from skill manifests
  // (authorization, x-csrf-token, api keys, etc.) — stored encrypted in vault.
  let auth_profile_ref: string | undefined;
  const capturedAuthHeaders = extractAuthHeaders(captured.requests);

  if ((captured.cookies && captured.cookies.length > 0) || Object.keys(capturedAuthHeaders).length > 0) {
    auth_profile_ref = `${domain}-session`;
    await storeCredential(auth_profile_ref, JSON.stringify({
      cookies: captured.cookies ?? [],
      headers: Object.keys(capturedAuthHeaders).length > 0 ? capturedAuthHeaders : undefined,
    }));
  }

  // BUG-004 fix: set auth_profile_ref when vault has stored auth for this domain
  if (!auth_profile_ref) {
    // Check both vault key patterns: auth:{domain} (login flow) and {domain}-session (CDP capture)
    for (const vaultKey of [`auth:${targetDomain}`, `${domain}-session`, `${targetDomain}-session`]) {
      const hasStoredAuth = (await getCredential(vaultKey)) != null;
      if (hasStoredAuth) { auth_profile_ref = vaultKey; break; }
    }
  }
  const authBackedCapture = usedStoredAuth || !!auth_profile_ref;
  if (authBackedCapture) {
    for (const endpoint of cleanEndpoints) {
      endpoint.semantic = {
        ...(endpoint.semantic ?? {}),
        action_kind: endpoint.semantic?.action_kind ?? "fetch",
        resource_kind: endpoint.semantic?.resource_kind ?? "resource",
        auth_required: true,
      };
    }
  }

  const pageArtifact = captured.html
    ? buildPageArtifactCapture(url, intent, captured.html, authBackedCapture)
    : {};
  let domArtifactEndpoint = pageArtifact.endpoint;
  let domArtifactResult = pageArtifact.result;
  let inferredOnlyCapture = cleanEndpoints.length > 0 && cleanEndpoints.every((endpoint) => isBundleInferredEndpoint(endpoint));
  let hasSupportEvidence = cleanEndpoints.some((endpoint) => isSupportEvidenceEndpoint(endpoint)) || !!domArtifactEndpoint;

  // SSR fast-path before declaring failure: when capture has no clean endpoints
  // AND no usable page artifact, try libcurl-impersonate (Chrome 131 JA4) via
  // Kuri sandbox. bun's Kuri tab might have failed to render or capture XHRs;
  // libcurl succeeds on many SSR sites Kuri couldn't. Helper at
  // src/capture/ssr-fastpath.ts is already used at L2778 for 5xx execute
  // fallback — this is the 2nd caller. Plan-v9 Phase A.
  if (cleanEndpoints.length === 0 && (!domArtifactEndpoint || !domArtifactResult || pageArtifact.quality_note)) {
    try {
      const { trySsrFastPathOnBlock } = await import("../capture/ssr-fastpath.js");
      const ssr = await trySsrFastPathOnBlock({ url, seedCookies: captured.cookies, timeoutMs: 15_000, proxy: process.env.UNBROWSE_PROXY_URL });
      if (ssr?.html && ssr.html.length > 1024) {
        const ssrArtifact = buildPageArtifactCapture(url, intent, ssr.html, authBackedCapture);
        if (ssrArtifact.endpoint && ssrArtifact.result) {
          domArtifactEndpoint = ssrArtifact.endpoint;
          domArtifactResult = ssrArtifact.result;
          pageArtifact.endpoint = ssrArtifact.endpoint;
          pageArtifact.result = ssrArtifact.result;
          delete pageArtifact.quality_note;
          log("execution", `ssr_fastpath_capture_fallback_success: ${ssr.html.length} bytes from libcurl, dom-extracted endpoint`);
        }
      }
    } catch (err) {
      log("execution", `ssr_fastpath_capture_fallback_error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // plan-v14 Tier 1: capture-side CF challenge solver. Sibling to SSR fastpath above.
  const captureDecisionTrace: Array<Record<string, unknown>> = [];
  if (cleanEndpoints.length === 0 && typeof captured.html === "string" && captured.html.length > 0 && captured.html.startsWith("<")) {
    try {
      const { extractCfBundleUrl, solveCfAndRetry } = await import("./cf-challenge.js");
      const cfBundle = extractCfBundleUrl(captured.html, url);
      if (cfBundle) {
        captureDecisionTrace.push({ step: "capture_cf_solver", url, bundle: cfBundle });
        log("execution", `capture_cf_solver: detected CF challenge bundle ${cfBundle}`);
        const solved = await solveCfAndRetry({
          url,
          body: captured.html,
          cookies: captured.cookies ?? [],
          kuriBase: process.env.KURI_BASE_URL,
          ...(process.env.UNBROWSE_PROXY_URL ? { proxy: process.env.UNBROWSE_PROXY_URL } : {}),
          timeoutMs: 30_000,
        });
        if (solved && solved.html.length > 0) {
          (captured as { html?: string }).html = solved.html;
          const reExtracted = extractEndpoints(captured.requests, captured.ws_messages, { pageUrl: url, finalUrl: captured.final_url, intent }, extractionTrace);
          if (reExtracted.length > 0) {
            cleanEndpoints = reExtracted.filter((ep) => {
              try {
                const host = new URL(ep.url_template).hostname;
                return !AUTH_PROVIDERS.test(host) && !LOGIN_PATHS.test(new URL(ep.url_template).pathname);
              } catch { return true; }
            });
            captureDecisionTrace.push({ step: "capture_cf_solver_retry_success", bytes: solved.html.length, endpoints: cleanEndpoints.length });
            log("execution", `capture_cf_solver_retry_success: re-extracted ${cleanEndpoints.length} endpoints from cleared HTML`);
          } else {
            captureDecisionTrace.push({ step: "capture_cf_solver_retry_no_endpoints", bytes: solved.html.length });
            log("execution", "capture_cf_solver_retry_no_endpoints: cleared HTML returned but extractEndpoints empty");
          }
        } else {
          captureDecisionTrace.push({ step: "capture_cf_solver_no_clearance" });
          log("execution", "capture_cf_solver_no_clearance: solver returned null");
        }
      }
    } catch (cfErr) {
      captureDecisionTrace.push({ step: "capture_cf_solver_error", message: cfErr instanceof Error ? cfErr.message : String(cfErr) });
      log("execution", `capture_cf_solver_error: ${cfErr instanceof Error ? cfErr.message : String(cfErr)}`);
    }
  }
  // plan-v14 Tier 1 fix: recompute the inferred/support flags AFTER the CF arm
  // may have re-extracted endpoints. Without this, L1402 gates against stale
  // (pre-solver) values computed at L1330 — could fire bundle_routes_only on
  // freshly-solved real endpoints, or skip the gate when it should fire.
  inferredOnlyCapture = cleanEndpoints.length > 0 && cleanEndpoints.every((endpoint) => isBundleInferredEndpoint(endpoint));
  hasSupportEvidence = cleanEndpoints.some((endpoint) => isSupportEvidenceEndpoint(endpoint)) || !!domArtifactEndpoint;
  if (inferredOnlyCapture && !hasSupportEvidence) {
    const trace: ExecutionTrace = stampTrace({
      trace_id: traceId,
      skill_id: skill.skill_id,
      endpoint_id: "browser-capture",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      success: false,
      error: "bundle_routes_only",
      decision_trace: captureDecisionTrace.length ? captureDecisionTrace : undefined,
    });
    return {
      trace,
      result: {
        error: "no_endpoints",
        message: `Only bundle-inferred routes were found at ${url}; no observed API responses or structured DOM data were validated.`,
      },
    };
  }

  if (cleanEndpoints.length === 0) {
    // DOM fallback: extract structured data from rendered page, learn a DOM skill
    if (domArtifactEndpoint && domArtifactResult) {
        const existingDomSkill = findExistingSkillForDomain(domain, intent);
        const domEndpoints = await prepareLearnedEndpoints(
          existingDomSkill
            ? mergeEndpoints(existingDomSkill.endpoints, [domArtifactEndpoint])
            : [domArtifactEndpoint],
          intent,
          domain,
        );
        const domDraft: SkillManifest = {
          skill_id: existingDomSkill?.skill_id ?? nanoid(),
          version: "1.0.0",
          schema_version: "1",
          lifecycle: "active" as const,
          execution_type: "http" as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          name: domain,
          intent_signature: intent,
          domain,
          description: `API skill for ${domain}`,
          owner_type: "agent" as const,
          endpoints: domEndpoints,
          operation_graph: buildSkillOperationGraph(domEndpoints),
          intents: Array.from(new Set([...(existingDomSkill?.intents ?? []), intent])),
          ...(auth_profile_ref ? { auth_profile_ref } : {}),
        };

        const domCacheKey = buildResolveCacheKey(domain, intent, url);
        const domScopedKey = scopedCacheKey(options?.client_scope ?? "global", domCacheKey);
        writeSkillSnapshot(domScopedKey, domDraft);
        const domDomainKey = getDomainReuseKey(url ?? domain);
        if (domDomainKey) {
          domainSkillCache.set(domDomainKey, {
            skillId: domDraft.skill_id,
            localSkillPath: snapshotPathForCacheKey(domScopedKey),
            ts: Date.now(),
          });
          persistDomainCache();
        }

        // Only publish to marketplace if quality passes AND admission gate admits
        // a real endpoint. Dom-fallback-only skills poison resolve with fake
        // cache hits that hide the real API behind a synthetic page artifact.
        let learned: SkillManifest | undefined = domDraft;
        try {
          const validation = await validateManifest({ ...domDraft, skill_id: "__validate__" });
          const admission = selectMarketplacePublishEndpoints(domDraft);
          if (validation.valid && admission.endpoints.length > 0) {
            learned = await publishSkill(domDraft);
          } else if (admission.endpoints.length === 0) {
            console.warn(`[publish] dom-artifact publish skipped for ${domDraft.skill_id}: dom_fallback_only (kept local-only)`);
          }
        } catch { /* publish failure is non-fatal */ }
        if (learned) {
          try { cachePublishedSkill(learned, options?.client_scope); } catch { /* local cache best-effort */ }
          persistWorkflowArtifactForCapture(learned, captured, capturedAuthHeaders);
        }

        const trace: ExecutionTrace = stampTrace({
          trace_id: traceId,
          skill_id: learned?.skill_id ?? skill.skill_id,
          endpoint_id: domArtifactEndpoint.endpoint_id,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: true,
          result: domArtifactResult.data,
          decision_trace: captureDecisionTrace.length ? captureDecisionTrace : undefined,
        });
        // Always return data to the caller — quality gate only blocks publishing
        return {
          trace,
          result: domArtifactResult,
          learned_skill: learned,
        };
      }

    if (pageArtifact.quality_note) {
      const trace: ExecutionTrace = stampTrace({
        trace_id: traceId,
        skill_id: skill.skill_id,
        endpoint_id: "browser-capture",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        success: false,
        error: pageArtifact.quality_note,
        decision_trace: captureDecisionTrace.length ? captureDecisionTrace : undefined,
      });
      return {
        trace,
        result: {
          error: "low_quality_dom_extraction",
          message: `Structured DOM extraction was rejected for ${url}: ${pageArtifact.quality_note}`,
          captured_meta: computeCapturedMeta(),
          // F2.1 — bring low-quality DOM rejection up to F2 parity with
          // actionable next_step. Caught via harness/recursive/ on
          // facebook.com/Meta/about which returned this error with no
          // path forward for the agent.
          next_step: {
            action: "open_browse_session",
            reason:
              `Page rendered but DOM extraction quality was too low to publish a skill. ` +
              `Rejection reason: ${pageArtifact.quality_note}. The page likely needs ` +
              `interaction (sign-in, click-to-expand, lazy-load scroll) before structured ` +
              `data appears, OR this surface has no machine-extractable shape.`,
            suggested_commands: [
              `unbrowse go --url "${url}"`,
              `unbrowse snap  # inspect page state`,
              `# if behind auth: sign in via Chrome (cookies auto-import on next go)`,
              `# if interactive: unbrowse click <ref> / fill / submit`,
              `unbrowse close  # publishes any newly captured endpoints`,
              `# or: route this intent to a different domain that has a real API`,
            ],
          },
        },
      };
    }

    const capturedMeta = computeCapturedMeta();
    const capturedHasNetwork = (capturedMeta?.api_calls ?? 0) > 0 || (capturedMeta?.html_bytes ?? 0) > 0;

    const trace: ExecutionTrace = stampTrace({
      trace_id: traceId,
      skill_id: skill.skill_id,
      endpoint_id: "browser-capture",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      success: false,
      error: "no_endpoints",
      decision_trace: captureDecisionTrace.length ? captureDecisionTrace : undefined,
    });
    return {
      trace,
      result: {
        error: "no_endpoints",
        message: `No API endpoints or structured DOM data found at ${url}. The site may require authentication or may not expose machine-readable data from this page.`,
        captured_meta: capturedMeta,
        // Make the failure agent-actionable: tell the caller what to do next
        // instead of leaving them with a 27s wait and a one-word error.
        // Friction discovered via harness/recursive/ on saucedemo.com (corpus row).
        next_step: capturedHasNetwork
          ? {
              action: "open_browse_session",
              reason: "Network/HTML was captured but no extractable API or DOM data; the site likely needs interaction (form fill, click, scroll) before data appears.",
              suggested_commands: [
                `unbrowse go --url "${url}"`,
                `unbrowse snap`,
                `# inspect interactive elements, then fill/click/submit`,
                `unbrowse close  # publishes any newly captured endpoints`,
              ],
            }
          : {
              action: "abandon_or_authenticate",
              reason: "Capture returned no network traffic and no HTML — the page is likely blocked, requires auth, or rendered nothing for the current cookie context.",
              suggested_commands: [
                `# 1. Try sandbox-replay — auto-pulls cookies from your real Chrome/Arc/Brave/Edge/Vivaldi/Opera/Dia session and uses Chrome 131 JA4 fingerprint`,
                `unbrowse sandbox-replay --target-origin "${(() => { try { return new URL(url).origin; } catch { return url; } })()}" --target-href "${url}" --bundle-source "(() => { const r = __nativeFetch('GET', '${url}', {'Accept':'text/html'}, null); globalThis.r = { status: r.status, body_len: (r.body||'').length, title: (r.body||'').match(/<title[^>]*>([^<]+)<\\/title>/)?.[1] }; })()" --post-eval "globalThis.r"`,
                `# 2. Or interactive browse session — login in the popped-up Chrome and capture publishes`,
                `unbrowse go --url "${url}"`,
                `# 3. Or accept that this domain has no machine-readable surface for this intent`,
              ],
            },
      },
    };
  }

  // Reuse existing skill for this domain to preserve skill_id across re-captures.
  // This prevents duplicate skills accumulating in the marketplace.
  const existingSkill = findExistingSkillForDomain(domain, intent);

  // Keep all captured endpoints locally so the resolver can use WS-backed skills,
  // but only publish HTTP endpoints until backend validation supports WS manifests.
  //
  // INVARIANT: every published skill carries a `page_fetch` endpoint as
  // bedrock floor. When XHR observation yielded only telemetry (Amazon
  // search, Bing search) or DOM extraction couldn't synthesize a useful
  // artifact, the agent can still call this endpoint to retrieve the
  // rendered page (HTML→markdown via execute's existing GET path).
  // See .bench-history/ROOT_FIX_GUIDE.md for the architecture.
  const publicApiEndpoints = derivePublicApiEndpointsFromUrl(url, intent, authBackedCapture);
  const pageFetch = buildPageFetchEndpoint(url, intent, authBackedCapture);
  const learnedEndpoints = [
    ...cleanEndpoints,
    ...publicApiEndpoints,
    ...(domArtifactEndpoint ? [domArtifactEndpoint] : []),
    // Skip injection if the corpus already has a page_fetch endpoint
    // (e.g. on re-capture of an existing skill that already had it).
    ...(cleanEndpoints.some(isPageFetchEndpoint)
        || (domArtifactEndpoint && isPageFetchEndpoint(domArtifactEndpoint))
        ? []
        : [pageFetch]),
  ];
  const localEndpoints = await prepareLearnedEndpoints(
    existingSkill
      ? mergeEndpoints(existingSkill.endpoints, learnedEndpoints)
      : learnedEndpoints,
    intent,
    domain,
  );
  const publishableEndpoints = localEndpoints.filter((ep) => ep.method !== "WS");

  const localDraft: SkillManifest = {
    skill_id: existingSkill?.skill_id ?? nanoid(),
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active" as const,
    execution_type: "http" as const,
    created_at: existingSkill?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: domain,
    intent_signature: intent,
    domain,
    description: `API skill for ${domain}`,
    owner_type: "agent" as const,
    endpoints: localEndpoints,
    intents: Array.from(new Set([...(existingSkill?.intents ?? []), intent])),
    ...(auth_profile_ref ? { auth_profile_ref } : {}),
  };
  // Generate local descriptions immediately so BM25 ranking works on first cache hit
  for (const ep of localDraft.endpoints) {
    if (!ep.description) {
      ep.description = generateLocalDescription(ep);
    }
  }

  // PHASE 2: Write local cache IMMEDIATELY (~1ms) — populates cache before auto-exec
  const bgCacheKey = buildResolveCacheKey(domain, intent, url);
  const bgScopedKey = scopedCacheKey(options?.client_scope ?? "global", bgCacheKey);
  writeSkillSnapshot(bgScopedKey, localDraft);
  const bgDomainKey = getDomainReuseKey(url ?? domain);
  if (bgDomainKey) {
    domainSkillCache.set(bgDomainKey, {
      skillId: localDraft.skill_id,
      localSkillPath: snapshotPathForCacheKey(bgScopedKey),
      ts: Date.now(),
    });
    persistDomainCache();
  }

  // PHASE 2: Queue heavy work for background (graph + validate + publish)
  queueBackgroundIndex({
    skill: { ...localDraft },
    domain,
    intent,
    contextUrl: url,
    clientScope: options?.client_scope,
    cacheKey: bgCacheKey,
  });

  // Return the local draft as learned_skill — no blocking on marketplace publish
  let learned: SkillManifest = localDraft;
  try { cachePublishedSkill(localDraft, options?.client_scope); } catch { /* best-effort */ }
  persistWorkflowArtifactForCapture(localDraft, captured, capturedAuthHeaders);

  // Attribute lifecycle phases for this capture-to-publish flow
  const completedAt = new Date().toISOString();
  const captureDurationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const lifecycleEvents: LifecycleEvent[] = [
    { phase: "capture", skill_id: learned.skill_id, timestamp: startedAt, duration_ms: captureDurationMs, source: "live-capture" },
    { phase: "publish", skill_id: learned.skill_id, timestamp: completedAt, duration_ms: 0, source: publishableEndpoints.length > 0 ? "marketplace" : "cache" },
  ];
  const lifecycleAttribution = attributeLifecycle(lifecycleEvents);
  log("execution", `lifecycle attribution: capture=${lifecycleAttribution.get("capture") ?? 0}ms, publish=${lifecycleAttribution.get("publish") ?? 0}ms`);

  const trace: ExecutionTrace = stampTrace({
    trace_id: traceId,
    skill_id: learned.skill_id,
    endpoint_id: "browser-capture",
    started_at: startedAt,
    completed_at: completedAt,
    success: true,
    result: { learned_skill_id: learned.skill_id, endpoints_discovered: cleanEndpoints.length },
    decision_trace: captureDecisionTrace.length ? captureDecisionTrace : undefined,
  });

  // Detect tracking-only capture: all endpoints lack a response_schema, meaning no real
  // JSON data was returned — the site likely gated its API behind authentication.
  // Only flag this when no auth was used (so a retry with auth has a chance of succeeding).
  const hasMeaningfulEndpoint = cleanEndpoints.some((ep) => isSupportEvidenceEndpoint(ep));
  const authRecommended = !usedStoredAuth && !hasMeaningfulEndpoint && !inferredOnlyCapture;

  return {
    trace,
    result: {
      ...(trace.result as Record<string, unknown>),
      ...(authRecommended ? {
        auth_recommended: true,
        auth_hint: `No data endpoints found — ${domain} likely requires authentication. ` +
          `Store browser cookies for this domain via the auth endpoints, then retry this capture.`,
      } : {}),
      // Always surface captured_meta so the agent can reason about WHY the
      // capture is shallow even on the success path (doc_only shape:
      // observed_api_calls, title, browser_block_signals, rejected_samples
      // tell different stories — page never fired XHR vs filtered them all
      // vs anti-bot wall vs auth redirect).
      captured_meta: computeCapturedMeta(),
    },
    learned_skill: learned,
  };
}

export async function tryHttpFetch(
  url: string,
  authHeaders: Record<string, string>,
  cookies: Array<{ name: string; value: string; domain: string }>,
): Promise<{ html: string; final_url: string } | null> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      ...authHeaders,
    };
    if (cookies && cookies.length > 0) {
      headers["Cookie"] = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (res.status !== 200) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null;
    const html = await res.text();
    if (!html || html.length < 1024) return null;
    return { html, final_url: res.url || url };
  } catch {
    return null;
  }
}

/** When extraction returns "multiple" candidates, pick the best one's data to avoid duplicates */
function flattenExtracted(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  const first = data[0];
  if (first && typeof first === "object" && "type" in first && "data" in first && "relevance_score" in first) {
    return data.reduce((best: any, cur: any) => (cur.relevance_score ?? 0) > (best.relevance_score ?? 0) ? cur : best).data;
  }
  return data;
}

async function executeDomExtractionEndpoint(
  endpoint: EndpointDescriptor,
  url: string,
  intent: string,
  authHeaders: Record<string, string>,
  cookies: Array<{ name: string; value: string; domain: string }>,
): Promise<{ data: unknown; status: number; trace_id: string }> {
  // SSR fast-path: try plain HTTP fetch before browser
  const ssrResult = await tryHttpFetch(url, authHeaders, cookies);
  if (ssrResult) {
    const ssrExtracted = extractFromDOMWithHint(ssrResult.html, intent, endpoint.dom_extraction);
    if (ssrExtracted.data) {
      const ssrQuality = validateExtractionQuality(ssrExtracted.data, ssrExtracted.confidence, intent);
      if (ssrQuality.valid) {
        const ssrSemantic = assessIntentResult(ssrExtracted.data, intent);
        if (ssrSemantic.verdict !== "fail") {
          console.log(`[ssr-fast] hit — extracted via HTTP fetch`);
          return {
            data: flattenExtracted(ssrExtracted.data),
            status: 200,
            trace_id: nanoid(),
          };
        }
      }
    }
    console.log(`[ssr-fast] miss, falling back to browser`);
  } else {
    console.log(`[ssr-fast] miss, falling back to browser`);
  }

  // Browser fallback — captures both intercepted API requests AND page HTML
  const captured = await captureSession(url, authHeaders, cookies, intent);

  // Check intercepted requests first — if the site's JS made API calls,
  // those have the actual filtered data (not the initial HTML page load)
  if (captured.requests.length > 0) {
    const { extractEndpoints: extractEps } = await import("../reverse-engineer/index.js");
    const apiEndpoints = extractEps(captured.requests, undefined, { pageUrl: url, finalUrl: captured.final_url });
    const jsonEndpoints = apiEndpoints.filter(ep => ep.response_schema && !ep.dom_extraction);
    if (jsonEndpoints.length > 0) {
      // Found real API responses — return the best one's data
      const best = jsonEndpoints[0];
      const matchingReq = captured.requests.find(r =>
        r.url.includes(best.url_template.split("?")[0].split("{")[0]) &&
        r.response_body && r.response_status >= 200 && r.response_status < 400
      );
      if (matchingReq?.response_body) {
        try {
          const data = JSON.parse(matchingReq.response_body);
          console.log(`[dom-exec] found API response from browser capture: ${matchingReq.url.substring(0, 80)}`);
          return { data, status: matchingReq.response_status, trace_id: nanoid() };
        } catch { /* not JSON, fall through to DOM extraction */ }
      }
    }
  }

  // Fall back to DOM extraction from rendered HTML
  const html = captured.html ?? "";
  const extracted = extractFromDOMWithHint(html, intent, endpoint.dom_extraction);
  if (extracted.data) {
    const quality = validateExtractionQuality(extracted.data, extracted.confidence, intent);
    if (!quality.valid) {
      return {
        data: {
          error: "low_quality_dom_extraction",
          message: `Structured DOM extraction was rejected: ${quality.quality_note ?? "low quality extraction"}`,
        },
        status: 422,
        trace_id: nanoid(),
      };
    }
    const semanticAssessment = assessIntentResult(extracted.data, intent);
    if (semanticAssessment.verdict === "fail") {
      return {
        data: {
          error: "low_quality_dom_extraction",
          message: `Structured DOM extraction was rejected: ${semanticAssessment.reason}`,
        },
        status: 422,
        trace_id: nanoid(),
      };
    }
    return {
      data: flattenExtracted(extracted.data),
      status: 200,
      trace_id: nanoid(),
    };
  }
  return {
    data: html,
    status: 200,
    trace_id: nanoid(),
  };
}


export async function executeEndpoint(
  skill: SkillManifest,
  endpoint: EndpointDescriptor,
  params: Record<string, unknown> = {},
  projection?: ProjectionOptions,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  endpoint = annotateEndpointPolicy(endpoint);

  // Session-bound params gate — bail early for endpoints that cannot be replayed.
  // Sites like TikTok validate fingerprint parameters server-side and return empty
  // results (HTTP 200 with empty lists) when captured values are stale. Attempting
  // the API call wastes time and confuses the agent with a misleading success trace.
  if (endpoint.policy?.requires_live_session) {
    const sessionParams = endpoint.policy.session_bound_params ?? [];
    const contextUrl = options?.contextUrl ?? `https://${skill.domain}`;
    const startedAt = new Date().toISOString();
    const traceId = nanoid();
    const resultData = {
      error: "browser_replay_only",
      message: `This endpoint requires a live browser session. ${sessionParams.length} session-bound fingerprint parameter(s) (${sessionParams.slice(0, 3).join(", ")}${sessionParams.length > 3 ? ", ..." : ""}) cannot be replayed from a capture — the server validates these values and returns empty results when they are stale.`,
      session_bound_params: sessionParams,
      next_step: `Use \`unbrowse go "${contextUrl}"\` to open a live browser session, then run \`unbrowse eval "return JSON.stringify(<your extraction logic>)"\` to get the data. All traffic will be passively captured and indexed for future API replay.`,
      commands: [
        `unbrowse go "${contextUrl}"`,
        `unbrowse eval "return document.title"`,
        "unbrowse close",
      ],
    };
    const trace: ExecutionTrace = stampTrace({
      trace_id: traceId,
      skill_id: skill.skill_id,
      endpoint_id: endpoint.endpoint_id,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      success: false,
      error: "browser_replay_only",
      result: resultData,
    });
    log("exec", `endpoint ${endpoint.endpoint_id} skipped — requires_live_session (${sessionParams.length} session-bound params)`);
    return { trace, result: resultData };
  }

  // Third-party terms gate — bail before any HTTP call when the endpoint's
  // domain is policy-flagged and the caller hasn't explicitly confirmed.
  // Mirror of the CLI gate; tests call executeSkill directly so the executor
  // must enforce this independently.
  if (
    endpoint.policy?.requires_third_party_terms_confirmation &&
    !options?.confirm_third_party_terms
  ) {
    const startedAt = new Date().toISOString();
    let policyDomain: string = skill.domain;
    if (endpoint.policy.domain) {
      policyDomain = endpoint.policy.domain;
    } else {
      try {
        const host = new URL(endpoint.url_template).hostname.replace(/^www\./, "");
        // Normalize api.x.com / m.x.com to the registrable domain (x.com).
        const parts = host.split(".");
        policyDomain = parts.length >= 2 ? parts.slice(-2).join(".") : host;
      } catch { /* keep skill.domain default */ }
    }
    const resultData = {
      error: "third_party_terms_confirmation_required" as const,
      message: `Endpoint ${endpoint.endpoint_id} on ${policyDomain} requires explicit third-party terms confirmation before execution.`,
      policy_domain: policyDomain,
      next_step: "Re-run with confirm_third_party_terms=true after reviewing the site's terms of service.",
    };
    const trace: ExecutionTrace = stampTrace({
      trace_id: nanoid(),
      skill_id: skill.skill_id,
      endpoint_id: endpoint.endpoint_id,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      success: false,
      error: "third_party_terms_confirmation_required",
      result: resultData,
    });
    return { trace, result: resultData };
  }

  const workflowArtifact = readWorkflowArtifact(skill.skill_id);
  const workflowRecipe = pickWorkflowRecipe(workflowArtifact, endpoint.endpoint_id);
  const reservedMetaParams = new Set(["endpoint_id", "url", "context_url", "intent"]);
  // WebSocket endpoint: connect, collect messages, return
  if (endpoint.method === "WS") {
    const startedAt = new Date().toISOString();
    const traceId = nanoid();
    try {
      const { WebSocket } = await import("ws");
      const messages: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(endpoint.url_template);
        const timeout = setTimeout(() => { ws.close(); resolve(); }, 7000);
        ws.on("message", (data: Buffer | string) => {
          messages.push(data.toString());
        });
        ws.on("error", (err: Error) => { clearTimeout(timeout); reject(err); });
        ws.on("close", () => { clearTimeout(timeout); resolve(); });
      });
      const parsed = messages.map((m) => { try { return JSON.parse(m); } catch { return m; } });
      const trace: ExecutionTrace = stampTrace({
        trace_id: traceId, skill_id: skill.skill_id, endpoint_id: endpoint.endpoint_id,
        started_at: startedAt, completed_at: new Date().toISOString(), success: true, result: parsed,
      });
      let resultData: unknown = parsed;
      if (projection?.raw) {
        // Explicit raw — skip projection
      } else if (projection) {
        resultData = applyProjection(parsed, projection);
      }
      return {
        trace, result: resultData,
      };
    } catch (err) {
      const trace: ExecutionTrace = stampTrace({
        trace_id: traceId, skill_id: skill.skill_id, endpoint_id: endpoint.endpoint_id,
        started_at: startedAt, completed_at: new Date().toISOString(), success: false,
        error: String(err),
      });
      return { trace, result: { error: String(err) } };
    }
  }

  // Payment gate — check if marketplace skill requires payment before executing
  if (!skill.skill_id.startsWith("local:") && skill.execution_type === "http" && skill.owner_type !== "agent") {
    const wallet = getLocalWalletContext();
    const gate = await checkPaymentRequirement(skill.skill_id, endpoint.endpoint_id, {
      wallet_configured: !!wallet.wallet_address,
    });
    // Show credit balance when paid via credits
    if (gate.status === "paid" && gate.method === "credits" && gate.balance_remaining_uc !== undefined) {
      const balUsd = (gate.balance_remaining_uc / 1_000_000).toFixed(4);
      console.log(`[credits] $${balUsd} remaining. ${gate.message ?? ""}`);
      if (gate.balance_remaining_uc < 200_000) { // < $0.20
        console.log(`[credits] Running low — run \`npx lobstercash setup\` to add a wallet and keep going after credits run out.`);
      }
    }

    if (gate.status === "payment_required" || gate.status === "wallet_not_configured" || gate.status === "insufficient_balance") {
      // If lobster wallet is available, let execution proceed —
      // the client-level apiRequest will handle 402 pay-and-retry automatically.
      let lobsterAvailable = false;
      try {
        const { isLobsterAvailable } = await import("../payments/lobster-pay.js");
        lobsterAvailable = isLobsterAvailable();
      } catch {}

      if (lobsterAvailable && gate.status === "payment_required") {
        console.log(`[payment] ${skill.skill_id}: lobster available — proceeding with auto-pay`);
      } else {
        const trace: ExecutionTrace = stampTrace({
          trace_id: nanoid(),
          skill_id: skill.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: false,
          status_code: 402,
          error: "payment_required",
        });
        return {
          trace,
          result: {
            error: "payment_required",
            price_usd: gate.requirement?.amount,
            payment_status: gate.status,
            message: gate.message,
            wallet_provider: wallet.wallet_provider ?? "lobster.cash",
            wallet_address: wallet.wallet_address,
            indexing_fallback_available: true,
          },
        };
      }
    }
  }

  // Mutation safety / policy gate
  if (endpoint.method !== "GET") {
    if (workflowRecipe?.mutation_guard.block_reason) {
      return {
        trace: stampTrace({
          trace_id: nanoid(),
          skill_id: skill.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: false,
          error: "workflow_blocked",
        }),
        result: {
          error: "workflow_blocked",
          message: workflowRecipe.mutation_guard.block_reason,
        },
      };
    }
    if (options?.dry_run) {
      // Merge path_params defaults for dry_run preview too
      const dryParams = { ...params };
      if (endpoint.path_params) {
        for (const [k, v] of Object.entries(endpoint.path_params)) {
          if (dryParams[k] == null) dryParams[k] = v;
        }
      }
      if (endpoint.body_params) {
        for (const [k, v] of Object.entries(endpoint.body_params)) {
          if (dryParams[k] == null) dryParams[k] = v;
        }
      }
      const url = interpolate(endpoint.url_template, dryParams);
      const body = endpoint.body ? interpolateObj(endpoint.body, dryParams) : undefined;
      return {
        trace: stampTrace({
          trace_id: nanoid(),
          skill_id: skill.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: false,
          error: "dry_run",
        }),
        result: {
          dry_run: true,
          ...(endpoint.policy ? { site_policy: endpoint.policy } : {}),
          would_execute: { method: endpoint.method, url, body },
        },
      };
    }
    // third_party_terms: log-only, never block. Unbrowse acts as the user's browser.
    if (endpointRequiresThirdPartyTermsConfirmation(endpoint) && !options?.confirm_third_party_terms) {
      const policy = getEndpointPolicy(endpoint)!;
      log("exec", `third-party terms flagged for ${policy.policy_domain} (not enforced)`);
    }
    if (endpoint.idempotency === "unsafe" && !options?.confirm_unsafe) {
      return {
        trace: stampTrace({
          trace_id: nanoid(),
          skill_id: skill.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: false,
          error: "confirmation_required",
        }),
        result: {
          error: "confirmation_required",
          message: `This endpoint (${endpoint.method} ${endpoint.url_template}) is marked as unsafe. Pass confirm_unsafe: true to proceed.`,
        },
      };
    }
  }

  const startedAt = new Date().toISOString();
  const authHeaders: Record<string, string> = {};
  const cookies: Array<{ name: string; value: string; domain: string }> = [];

  // Endpoint domain — used for cookie resolution, strategy caching, auth refresh
  const epDomain = (() => { try { return new URL(endpoint.url_template).hostname; } catch { return skill.domain; } })();
  await reloadExecutionAuthState(skill, epDomain, authHeaders, cookies);

  // If endpoint has auth_tokens bindings, always resolve fresh tokens.
  // Vault headers may be stale - the DAG knows how to get fresh ones.
  log("exec", `auth_tokens check: ${endpoint.auth_tokens?.length ?? 0} bindings on ${endpoint.endpoint_id}`);
  if (endpoint.auth_tokens?.length) {
    try {
      const resolved = await resolveAuthTokens(endpoint, cookies, authHeaders);
      log("exec", `token resolver returned ${Object.keys(resolved).length} headers: ${Object.keys(resolved).join(",") || "none"}`);
      Object.assign(authHeaders, resolved);
    } catch (e) { log("exec", `token resolver failed: ${e}`); }
  }

  log("exec", `endpoint ${endpoint.endpoint_id}: cookies=${cookies.length} authHeaders=${Object.keys(authHeaders).length} hasAuth=${cookies.length > 0 || Object.keys(authHeaders).length > 0}`);

  // BUG-006: Merge path_params defaults — user params override captured defaults
  let mergedParams = mergeContextTemplateParams(params, endpoint.url_template, options?.contextUrl);
  if (endpoint.path_params && typeof endpoint.path_params === "object") {
    for (const [k, v] of Object.entries(endpoint.path_params)) {
      if (mergedParams[k] == null) {
        mergedParams[k] = v;
      }
    }
  }
  if (endpoint.body_params && typeof endpoint.body_params === "object") {
    for (const [k, v] of Object.entries(endpoint.body_params)) {
      if (mergedParams[k] == null) {
        mergedParams[k] = v;
      }
    }
  }

  // Merge captured query params into URL — user params override endpoint defaults
  let urlTemplate = resolveExecutionUrlTemplate(endpoint, options?.contextUrl);
  if (endpoint.query && typeof endpoint.query === "object" && Object.keys(endpoint.query).length > 0) {
    try {
      const u = new URL(urlTemplate);
      const queryBindings = extractTemplateQueryBindings(endpoint.url_template);
      for (const [k, v] of Object.entries(endpoint.query)) {
        const bindingKey = queryBindings[k];
        // User params override captured query defaults
        if (bindingKey && mergedParams[bindingKey] != null) {
          u.searchParams.set(k, String(mergedParams[bindingKey]));
        } else if (mergedParams[k] != null) {
          u.searchParams.set(k, String(mergedParams[k]));
        } else if (v != null) {
          u.searchParams.set(k, String(v));
        }
      }
      // Restore template placeholders + API-safe chars that URLSearchParams over-encodes
      urlTemplate = restoreTemplatePlaceholderEncoding(u.toString())
        .replace(/%28/gi, "(").replace(/%29/gi, ")")
        .replace(/%2C/gi, ",").replace(/%3A/gi, ":");
    } catch {
      // URL parse failure — skip query merge
    }
  }
  // GraphQL ergonomics: if the endpoint takes opaque {variables}/{features}
  // JSON slots, reconstruct them from the agent's flat params + the captured
  // example shape. This lets agents pass `q="..."` (or rawQuery) and we fill
  // in querySource/count/product defaults plus features feature-flags blob.
  let __gqlDecomp = decomposeGraphqlEndpoint(endpoint);
  if (__gqlDecomp.isGraphql) {
    // D8: if THIS endpoint's example_request.variables is empty/missing but
    // the skill has a sibling endpoint with the same GraphQL operationName
    // that DOES have a populated variables template, borrow it. Otherwise
    // x.com (and similar) returns 422 GRAPHQL_VALIDATION_FAILED for missing
    // required variables (e.g. `includePromotedContent must be defined`).
    // Caught via harness/recursive/ on x.com home timeline — there were
    // duplicate HomeTimeline endpoints, one fully populated, one empty.
    if (
      __gqlDecomp.operationName &&
      (!__gqlDecomp.variablesTemplate || Object.keys(__gqlDecomp.variablesTemplate).length === 0)
    ) {
      const siblings = (skill.endpoints ?? []).filter((e) => e.endpoint_id !== endpoint.endpoint_id);
      for (const sib of siblings) {
        const sibDecomp = decomposeGraphqlEndpoint(sib);
        if (
          sibDecomp.isGraphql &&
          sibDecomp.operationName === __gqlDecomp.operationName &&
          sibDecomp.variablesTemplate &&
          Object.keys(sibDecomp.variablesTemplate).length > 0
        ) {
          log("exec", `D8 graphql-template-borrow: ${endpoint.endpoint_id} → ${sib.endpoint_id} for ${__gqlDecomp.operationName}`);
          __gqlDecomp = sibDecomp;
          if (!endpoint.body && sib.body) {
            endpoint = { ...endpoint, body: sib.body, method: sib.method ?? endpoint.method, headers_template: sib.headers_template ?? endpoint.headers_template };
            log("exec", `D8 graphql-body-borrow: ${endpoint.endpoint_id} ← ${sib.endpoint_id}.body (${Object.keys(sib.body as object).length} keys)`);
          }
          break;
        }
      }
    }
    const __gqlEnc = buildGraphqlRequestParams(__gqlDecomp, mergedParams as Record<string, unknown>);
    if (mergedParams.variables == null || mergedParams.variables === "{variables}") {
      mergedParams.variables = encodeURIComponent(__gqlEnc.variables);
    }
    if (mergedParams.features == null || mergedParams.features === "{features}") {
      mergedParams.features = encodeURIComponent(__gqlEnc.features);
    }
    // D8b: graphql POSTs (and any captured body shape) often store the literal
    // captured payload — including placeholder strings like
    // `{variables_seentweetids_0}` that interpolateObj doesn't rewrite. Force
    // the cleaned, freshly-built variables/features into body so x.com (and
    // similar) receive valid JSON. Strings or nested objects both supported:
    // we always write strings since x's /graphql endpoint accepts either.
    if (endpoint.body && typeof endpoint.body === "object" && !Array.isArray(endpoint.body)) {
      const b = endpoint.body as Record<string, unknown>;
      if ("variables" in b) b.variables = __gqlEnc.variables;
      if ("features" in b) b.features = __gqlEnc.features;
    }
  }
  let url = interpolate(urlTemplate, mergedParams);

  // A8 fix — URL entity templatification at execute time.
  // Real-world friction caught via harness/recursive/ on en.wikipedia.org:
  // a captured op had `url_template: https://en.wikipedia.org/wiki/Quantum_computing`
  // (a specific page from a previous capture). When the agent calls execute
  // with `--url https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)`,
  // we should honor the user's URL since it's the same path-shape with one
  // differing entity segment. Generalises to any "entity-in-path" capture
  // (twitter user pages, github repos, opensea collections, wiki articles).
  //
  // Tells (must satisfy ALL):
  //   - mergedParams.url (caller-supplied contextUrl) is set
  //   - It's the same hostname as the resolved URL
  //   - It has the same number of path segments
  //   - The differing segments are entity-shaped (length ≥ 3, not API tokens
  //     like /api/v1/json that are shared across endpoints)
  //   - The captured url_template has no remaining {param} slots after
  //     interpolate() (we're not stomping on a parameterised endpoint)
  // UX-2: default URL inference. When the agent calls execute without --url,
  // fall back to the captured endpoint's trigger_url (the page where the
  // request was originally observed). Lets the agent skip the redundant
  // --url flag for direct executes against a known endpoint.
  // Per CLAUDE.md Agent UX North Star: less steps.
  const __callerUrl = typeof mergedParams.url === "string" && mergedParams.url
    ? mergedParams.url
    : (endpoint.trigger_url ?? "");
  if (__callerUrl && !/\{[^}]+\}/.test(url)) {
    try {
      const cap = new URL(url);
      const ctx = new URL(__callerUrl);
      if (cap.hostname === ctx.hostname) {
        const capSegs = cap.pathname.split("/").filter(Boolean);
        const ctxSegs = ctx.pathname.split("/").filter(Boolean);
        if (capSegs.length === ctxSegs.length && capSegs.length > 0) {
          // Count differing segments. If exactly one differs and it's an
          // entity-shaped segment (not a shared API token), substitute.
          const SHARED = new Set([
            "api", "v1", "v2", "v3", "graphql", "rest", "rpc", "data", "json",
            "wiki", "user", "users", "post", "posts", "item", "items", "page",
            "pages", "search", "find", "list", "feed", "home", "hot", "top",
            "new", "best", "details", "detail", "info", "profile", "profiles",
            "collection", "collections", "product", "products", "p", "i", "s",
          ]);
          let diffCount = 0;
          let diffIdx = -1;
          const diffIndices: number[] = [];
          for (let i = 0; i < capSegs.length; i++) {
            if (capSegs[i].toLowerCase() === ctxSegs[i].toLowerCase()) continue;
            diffCount += 1;
            diffIdx = i;
            diffIndices.push(i);
          }
          // A8 generalised: any number of differing segments are OK as long as
          // every differing pair is entity-shaped on BOTH sides. Reddit
          // /r/{sub}/comments/{post_id}/{slug} differs in 3 segments — pre-fix
          // we required diffCount === 1 and only handled wikipedia/twitter.
          if (diffCount >= 1) {
            const allEntityShaped = diffIndices.every((i) => {
              const a = capSegs[i].toLowerCase();
              const b = ctxSegs[i].toLowerCase();
              const aEntity = !SHARED.has(a) && a.length >= 3 && !/^\d+$/.test(a);
              const bEntity = !SHARED.has(b) && b.length >= 3 && !/^\d+$/.test(b);
              return aEntity && bEntity;
            });
            if (allEntityShaped) {
              const newPathname = ctx.pathname; // includes leading slash
              const rewritten = `${cap.protocol}//${cap.hostname}${cap.port ? `:${cap.port}` : ""}${newPathname}${cap.search}${cap.hash}`;
              if (diffCount === 1) {
                log("exec", `A8 entity-substitute: ${capSegs[diffIdx]} → ${ctxSegs[diffIdx]} on ${cap.hostname}`);
              } else {
                log("exec", `A8 multi-entity-substitute: ${diffCount} segments on ${cap.hostname} (${diffIndices.map((i) => `${capSegs[i]}→${ctxSegs[i]}`).join(", ")})`);
              }
              url = rewritten;
            }
          }
        }
      }
    } catch { /* URL parse failure — skip alignment */ }
  }
  // SSRF protection: reject private IPs, loopback, link-local, and non-HTTP protocols.
  // Bypass when UNBROWSE_ALLOW_PRIVATE_IPS=1 (set by tests using local echo servers)
  // or when running under bun:test (process.argv contains "test" + bun runtime).
  const isBunTest = typeof process !== "undefined" &&
    process.argv?.[1]?.endsWith("bun") === false &&
    process.argv.some((a) => a === "test" || a.endsWith(".test.ts"));
  const allowPrivateIps = process.env.UNBROWSE_ALLOW_PRIVATE_IPS === "1" || isBunTest;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw new Error(`blocked unsafe protocol: ${parsed.protocol} (allowed: http, https)`);
    }
    const privateRe = /^(localhost|127\.|::1|fe80:|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|fc00::|fd00:)/i;
    if (privateRe.test(hostname) && !allowPrivateIps) {
      throw new Error(`blocked SSRF: target ${hostname} is a private/internal address`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("blocked")) {
      return {
        trace: stampTrace({
          trace_id: nanoid(),
          skill_id: skill.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: false,
          error: err.message,
        }),
        result: { error: "ssrf_blocked", message: err.message },
      };
    }
    throw err;
  }
  let body = endpoint.body ? interpolateObj(endpoint.body, mergedParams) : undefined;

  if (workflowRecipe) {
    const validationErrors = validateWorkflowReplayParams(workflowRecipe, mergedParams);
    if (validationErrors.length > 0) {
      return {
        trace: stampTrace({
          trace_id: nanoid(),
          skill_id: skill.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: false,
          error: "invalid_replay_params",
        }),
        result: {
          error: "invalid_replay_params",
          message: "Replay parameters did not satisfy the published workflow contract.",
          validation_errors: validationErrors,
          replay_contract: workflowRecipe.replay_contract,
        },
      };
    }
  }

  const isSafe = endpoint.method === "GET";
  let workflowBindings = workflowRecipe && workflowArtifact
    ? resolveWorkflowBindings(workflowRecipe, {
        cookies,
        authHeaders,
        body,
        artifact: workflowArtifact,
      })
    : null;
  if (workflowBindings?.bodyOverride !== undefined) {
    body = workflowBindings.bodyOverride;
  }

  // Append leftover params as query string on GET requests.
  // Params already consumed by path_params, endpoint.query, or {template} vars are skipped.
  if (isSafe && Object.keys(params).length > 0) {
    const consumedKeys = new Set<string>([
      ...reservedMetaParams,
      ...Object.keys(endpoint.path_params ?? {}),
      ...Object.keys(endpoint.query ?? {}),
    ]);
    for (const [rawKey, bindingKey] of Object.entries(extractTemplateQueryBindings(endpoint.url_template))) {
      consumedKeys.add(rawKey);
      consumedKeys.add(bindingKey);
    }
    // Also mark keys that appeared as {var} in the original URL template
    const templateVarRe = /\{(\w+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = templateVarRe.exec(endpoint.url_template)) !== null) {
      consumedKeys.add(m[1]);
    }
    const leftover = Object.entries(params).filter(([k]) => !consumedKeys.has(k) && params[k] != null);
    if (leftover.length > 0) {
      try {
        const u = new URL(url);
        for (const [k, v] of leftover) {
          u.searchParams.set(k, String(v));
        }
        url = u.toString();
      } catch { /* URL parse failure — skip */ }
    }
  }

  const hasAuthContext =
    cookies.length > 0 ||
    Object.keys(authHeaders).length > 0 ||
    !!skill.auth_profile_ref ||
    endpoint.semantic?.auth_required === true;



  const serverFetch = async (
    extraHeaders: Record<string, string> = {},
    bodyOverride: unknown = body,
  ): Promise<{ data: unknown; status: number; trace_id: string; response_headers: Record<string, string> }> => {
    const endpointHeaders = normalizeReplayHeaders(endpoint.headers_template);
    const sessionHeaders = normalizeReplayHeaders(authHeaders);

    // Default accept to JSON, but never overwrite the endpoint's own accept header
    // (e.g. LinkedIn uses "application/vnd.linkedin.normalized+json+2.1")
    const defaultAccept: Record<string, string> = (!endpoint.dom_extraction && !endpointHeaders["accept"] && !sessionHeaders["accept"])
      ? { "accept": "application/json" } : {};
    const headers: Record<string, string> = {
      ...defaultAccept,
      ...endpointHeaders,
      ...sessionHeaders,
      ...normalizeReplayHeaders(extraHeaders),
    };
    // NOTE: sec-ch-ua-*, sec-fetch-*, and upgrade-insecure-requests are kept —
    // Cloudflare and other bot-detection systems validate these headers and
    // reject requests missing them even when cookies are valid.

    // Inject cookies as Cookie header — same as a browser would send.
    // Strip enclosing quotes from values — Chrome's SQLite stores them quoted
    // but the Cookie header must send them unquoted (RFC 6265 §4.1.1).
    if (cookies.length > 0) {
      const cookieStr = cookies.map((c) => {
        const v = c.value.startsWith('"') && c.value.endsWith('"') ? c.value.slice(1, -1) : c.value;
        return `${c.name}=${v}`;
      }).join("; ");
      headers["cookie"] = cookieStr;

      // CSRF token auto-detection (bird pattern): many sites require CSRF tokens
      // as both a cookie AND a header. The cookie value is always fresher than
      // any stored vault header, so it ALWAYS overrides.
      const csrfCookie = cookies.find((c) =>
        /^(ct0|csrf_token|_csrf|csrftoken|XSRF-TOKEN|_xsrf)$/i.test(c.name)
      );
      if (csrfCookie) {
        const v = csrfCookie.value.startsWith('"') && csrfCookie.value.endsWith('"') ? csrfCookie.value.slice(1, -1) : csrfCookie.value;
        headers["x-csrf-token"] = v;
        headers["x-xsrf-token"] = v;
      }
    }

    if (endpoint.csrf_plan && cookies.length > 0) {
      const csrfCookie = cookies.find((c) =>
        endpoint.csrf_plan!.extractor_sequence.some((name) => name.toLowerCase() === c.name.toLowerCase()),
      );
      if (csrfCookie) {
        const v = csrfCookie.value.startsWith('"') && csrfCookie.value.endsWith('"') ? csrfCookie.value.slice(1, -1) : csrfCookie.value;
        if (endpoint.csrf_plan.source === "cookie" || endpoint.csrf_plan.source === "header") {
          headers[endpoint.csrf_plan.param_name.toLowerCase()] = v;
        } else if (endpoint.csrf_plan.source === "form" && body && typeof body === "object" && !Array.isArray(body)) {
          (body as Record<string, unknown>)[endpoint.csrf_plan.param_name] ??= v;
        }
      }
    }

    const replayUrls = [url];
    let last: { data: unknown; status: number; response_headers: Record<string, string> } = { data: null, status: 0, response_headers: {} };

    for (const replayUrl of replayUrls) {
      const replayHeaders = buildStructuredReplayHeaders(url, replayUrl, headers);
      log("exec", `server-fetch: ${endpoint.method} ${replayUrl.substring(0, 200)} csrf-token=${(replayHeaders["csrf-token"] || "none").substring(0, 20)}... hdrs=${Object.keys(replayHeaders).length} cookies=${(replayHeaders["cookie"]?.length ?? 0)}chars`);
      const res = await fetch(replayUrl, {
        method: endpoint.method,
        headers: replayHeaders,
        body: serializeReplayBody(bodyOverride, replayHeaders),
        redirect: "follow",
      });
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      const isProtobuf = isProtobufContentType(contentType) || isProtobufLikeEndpoint(replayUrl, contentType);
      let data: unknown;
      const isJson = contentType.includes("application/json");
      if (isProtobuf) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        data = decodeProtobufBytes(bytes) ?? {
          _format_mismatch: true,
          received_content_type: contentType,
          byte_length: bytes.length,
          data: `base64:${Buffer.from(bytes).toString("base64")}`,
        };
      } else {
        const text = await res.text();
        if (isJson) {
        try { data = JSON.parse(text); } catch { data = text; }
        } else if (res.ok && endpoint.dom_extraction) {
        // HTML response + DOM extraction recipe — run the extractor in-process
        // and return the structured records the recipe was captured against.
        try {
          const { extractFromDOM } = await import("../extraction/index.js");
          const extracted = extractFromDOM(text, skill.intent_signature ?? "");
          if (extracted && extracted.data != null && (Array.isArray(extracted.data) ? extracted.data.length > 0 : Object.keys(extracted.data as Record<string, unknown>).length > 0)) {
            data = extracted.data;
          } else {
            data = { _format_mismatch: true, received_content_type: contentType, data: text };
          }
        } catch (err) {
          log("exec", `dom-extraction error: ${err instanceof Error ? err.message : String(err)}`);
          data = { _format_mismatch: true, received_content_type: contentType, data: text };
        }
        } else if (res.ok && endpoint.response_schema && (contentType.includes("text/html") || contentType.includes("application/xhtml") || /^\s*</.test(text))) {
        // Expected JSON response but got HTML — try in-process DOM extraction as fallback
        // before declaring format mismatch. Many SSR pages serve the data on the rendered HTML.
        log("exec", `content-type mismatch: expected application/json, got ${contentType} from ${replayUrl.substring(0, 100)} — trying DOM extraction fallback`);
        try {
          const { extractFromDOM } = await import("../extraction/index.js");
          const extracted = extractFromDOM(text, skill.intent_signature ?? "");
          if (extracted && extracted.data != null && (Array.isArray(extracted.data) ? extracted.data.length > 0 : Object.keys(extracted.data as Record<string, unknown>).length > 0)) {
            data = extracted.data;
          } else {
            data = { _format_mismatch: true, received_content_type: contentType, data: text };
          }
        } catch (err) {
          log("exec", `dom-extraction fallback error: ${err instanceof Error ? err.message : String(err)}`);
          data = { _format_mismatch: true, received_content_type: contentType, data: text };
        }
        } else if (res.ok && endpoint.response_schema) {
        // Expected JSON response but got non-JSON content type — mark as format mismatch
        log("exec", `content-type mismatch: expected application/json, got ${contentType} from ${replayUrl.substring(0, 100)}`);
        data = { _format_mismatch: true, received_content_type: contentType, data: text };
        } else {
        try { data = JSON.parse(text); } catch { data = text; }
        }
      }
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { responseHeaders[k] = v; });
      last = { data, status: res.status, response_headers: responseHeaders };

      // Learn constraints from API validation errors
      if ((res.status === 400 || res.status === 422) && data && typeof data === "object") {
        const errors = (data as Record<string, unknown>).errors as Array<{ code?: string; message?: string; parameter?: string }> | undefined;
        if (errors?.length) {
          if (!endpoint.constraints) endpoint.constraints = [];
          const now = new Date().toISOString();
          for (const err of errors) {
            if (!err.message || !err.parameter) continue;
            const rule = err.code === "MISSING_PARAMETER" ? "required" as const
              : err.message.includes("deprecated") ? "deprecated" as const
              : err.message.includes("not allowed") ? "forbidden_in_body" as const
              : "format" as const;
            // Dedupe by param+rule
            if (!endpoint.constraints.some((c) => c.param === err.parameter && c.rule === rule)) {
              endpoint.constraints.push({ param: err.parameter!, rule, message: err.message, source: "api_error", learned_at: now });
              log("exec", `learned constraint: ${rule} ${err.parameter} - ${err.message}`);
            }
          }
        }
      }

      if (res.ok && !(typeof data === "string" && isHtml(data))) {
        return { data, status: res.status, trace_id: nanoid(), response_headers: last.response_headers };
      }
    }

    return { data: last.data, status: last.status, trace_id: nanoid(), response_headers: last.response_headers };
  };

  const browserCall = () => executeInBrowser(
    url,
    endpoint.method,
    endpoint.headers_template ?? {},
    body,
    authHeaders,
    cookies
  );

  let result: { data: unknown; status: number; trace_id: string; response_headers?: Record<string, string> };
  let workflowChosenStrategy = workflowRecipe?.steps[0]?.strategy;

  // ---------------------------------------------------------------------------
  // Phase 7.1 — Probe-first executor (Phase 8 cleanup complete).
  //
  // Every dispatch is derived from probe evidence (status + content-type +
  // body size) rather than from a pre-flight strategy switch. The legacy
  // per-host structured-replay registry and the endpoint.exec_strategy field
  // were deleted in Plan 08-03 once recipe replay (Phase 7.2) absorbed their
  // remaining use cases.
  // ---------------------------------------------------------------------------
  const decisionTrace: Array<Record<string, unknown>> = [];

  // ---------------------------------------------------------------------------
  // Phase 7.2 — Recipe replay (FAST PATH, runs before probe).
  //
  // Every endpoint admitted via extractEndpoints carries a proven_recipe — the
  // exact request that produced a known-good response when this endpoint was
  // captured. Replaying it is O(1 fetch). When response_signal matches, we're
  // done in <500ms with no probe needed. When it misses, fall through to the
  // 7.1 probe ladder for re-discovery (no behavior change vs 7.1).
  //
  // Skipped silently when:
  // - endpoint has no proven_recipe (older skills, bundle-mined endpoints)
  // - the substituted URL still has leftover {placeholders} (re-discovery is safer)
  // ---------------------------------------------------------------------------
  // result + recipeMatched declared at the start of the dispatch block
  let recipeMatched = false;

  if (endpoint.proven_recipe && shouldReplayRecipe(endpoint.proven_recipe, url)) {
    const recipeStart = Date.now();
    const recipeResult = await replayRecipe(endpoint.proven_recipe, url, cookies, authHeaders, mergedParams);
    const matchVerdict = matchResponseSignal(recipeResult, endpoint.proven_recipe.response_signal);
    decisionTrace.push({
      step: "recipe_replay",
      method: endpoint.proven_recipe.method,
      status: recipeResult.status,
      match: matchVerdict.match,
      ...(matchVerdict.match
        ? {}
        : {
            reason: matchVerdict.reason ?? "unknown",
            next_step: deriveRecipeReplayNextStep(matchVerdict.reason, {
              url,
              status: recipeResult.status,
              endpointId: endpoint.endpoint_id ?? "unknown",
            }),
          }),
      ms: Date.now() - recipeStart,
    });
    if (matchVerdict.match) {
      result = recipeResult;
      recipeMatched = true;
      workflowChosenStrategy = workflowChosenStrategy ?? "recipe-replay";
    }
  }

  // ---------------------------------------------------------------------------
  // Chain-walk fast-path. When invoked from `executeEndpointWithChain` (either
  // the recursive producer refetch frame or the leaf consumer dispatch), the
  // wrapper has already accepted responsibility for the endpoint shape, so
  // the probe step (HEAD then GET-1byte) doubles the HTTP roundtrip count
  // for no added evidence. Skip probe + go straight to serverFetch.
  //
  // Bug B fix (Day 6 Worker 1): the test counts every HTTP request to the
  // producer URL — HEAD-from-probe + GET-from-serverFetch was being read as
  // two producer hits per refetch. Internal sentinel `_chain_walk_active`
  // (attached by the wrapper, same source file) is the only contract.
  // ---------------------------------------------------------------------------
  if (
    !recipeMatched &&
    (options as ExecutionOptions & { _chain_walk_active?: boolean })?._chain_walk_active === true
  ) {
    result = await serverFetch(workflowBindings?.extraHeaders, workflowBindings?.bodyOverride);
    decisionTrace.push({ step: "server_fetch", status: result.status, chain_walk: true });
    workflowChosenStrategy = workflowChosenStrategy ?? "server";
    recipeMatched = true;
  }

  // ---------------------------------------------------------------------------
  // Phase 7.1 probe path — runs when recipe replay (above) did not match.
  // Probe evidence (status + content-type + body size) determines whether to
  // dispatch via server fetch or fall back to browser capture. The legacy
  // per-host registry was deleted in Plan 08-03.
  // ---------------------------------------------------------------------------
  if (!recipeMatched) {
    const probeCookies = cookies.map((c) => ({ name: c.name, value: c.value }));
    const probe = await probeUrl(url, {
      cookies: probeCookies,
      headers: { ...authHeaders },
    });
    decisionTrace.push({
      step: "probe",
      method: probe.method_used,
      status: probe.status,
      content_type: probe.content_type,
      byte_length: probe.byte_length,
      ms: probe.ms,
      ...(probe.error ? { error: probe.error } : {}),
    });

    const decision = decideFromProbe({
      probe,
      has_trigger_url: !!endpoint.trigger_url,
      intent_wants_dom: !!endpoint.dom_extraction,
      has_dom_extraction: !!endpoint.dom_extraction,
    });
    decisionTrace.push({
      step: "decision",
      strategy: decision.strategy,
      reason: decision.reason,
    });

    switch (decision.strategy) {
      case "server": {
        result = await serverFetch(workflowBindings?.extraHeaders, workflowBindings?.bodyOverride);
        decisionTrace.push({ step: "server_fetch", status: result.status });
        workflowChosenStrategy = workflowChosenStrategy ?? "server";
        break;
      }
      case "trigger-intercept": {
        if (!endpoint.trigger_url || !isSafe) {
          // Defensive — decideFromProbe checks has_trigger_url already.
          result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
          decisionTrace.push({ step: "browser_fallback", reason: "no trigger_url or unsafe method", status: result.status });
          workflowChosenStrategy = workflowChosenStrategy ?? "browser-fetch";
        } else {
          let triggerUrl = endpoint.trigger_url;
          if (Object.keys(mergedParams).length > 0) {
            try {
              const tu = new URL(endpoint.trigger_url);
              for (const [k, v] of Object.entries(mergedParams)) {
                if (v != null && !reservedMetaParams.has(k)) {
                  tu.searchParams.set(k, String(v));
                }
              }
              triggerUrl = tu.toString();
            } catch { /* keep original trigger_url */ }
          }
          result = await triggerAndIntercept(triggerUrl, endpoint.url_template, cookies, authHeaders);
          decisionTrace.push({ step: "trigger_intercept", trigger_url: triggerUrl, status: result.status });
          workflowChosenStrategy = "trigger-intercept";
        }
        break;
      }
      case "browser": {
        result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
        decisionTrace.push({ step: "browser", status: result.status });
        workflowChosenStrategy = workflowChosenStrategy
          ?? (workflowRecipe?.steps[0]?.strategy === "browser-action" ? "browser-action" : "browser-fetch");
        break;
      }
      case "return-error": {
        // Synthesise a result so downstream code is uniform. The agent reads
        // the actual server status and decides next move — no more 15s
        // trigger-intercept timeouts on dead URLs.
        result = {
          status: probe.status,
          data: {
            error: `http_${probe.status}`,
            message: `Probe returned status ${probe.status}; returned to caller without escalating.`,
            probe_method: probe.method_used,
            ...(probe.content_type ? { content_type: probe.content_type } : {}),
          },
          trace_id: nanoid(),
          response_headers: probe.retry_after ? { "retry-after": probe.retry_after } : {},
        };
        decisionTrace.push({ step: "return_error", status: probe.status });
        workflowChosenStrategy = workflowChosenStrategy ?? "server";
        break;
      }
      default: {
        // Should never happen — exhaustive switch. Defensive fallback.
        result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
        decisionTrace.push({ step: "browser_default", status: result.status });
        workflowChosenStrategy = workflowChosenStrategy ?? "browser-fetch";
      }
    }
  }

  if (workflowRecipe && workflowArtifact && needsWorkflowTokenRefresh(result.status)) {
    const refreshed = await refreshAuthFromBrowser(epDomain);
    if (refreshed) {
      await reloadExecutionAuthState(skill, epDomain, authHeaders, cookies);
      workflowBindings = resolveWorkflowBindings(workflowRecipe, {
        cookies,
        authHeaders,
        body,
        artifact: workflowArtifact,
      });
      result = await serverFetch(workflowBindings.extraHeaders, workflowBindings.bodyOverride);
      if (result.status >= 200 && result.status < 400) {
        workflowChosenStrategy = workflowChosenStrategy ?? "server";
      }
    }
  }
  let { status, trace_id } = result;
  let data = result.data;

  let trace: ExecutionTrace = stampTrace({
    trace_id,
    skill_id: skill.skill_id,
    endpoint_id: endpoint.endpoint_id,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    success: status >= 200 && status < 300,
    status_code: status,
  });

  // Phase 7.1: stamp probe-derived decision_trace onto the execution trace.
  // Phase 7.2 promotes this to a top-level field on the response envelope.
  (trace as ExecutionTrace & { decision_trace?: Array<Record<string, unknown>> }).decision_trace = decisionTrace;

  // Snapshot the raw upstream failure body BEFORE the empty-data stubbing
  // below replaces it. Used by classifyExecuteFailure() in the auth-recovery
  // branch to tell vendor_blocked apart from stale_credentials.
  const rawFailureBody: unknown = !trace.success ? data : undefined;

  if (!trace.success) {
    trace.error = status === 0
      ? `HTTP 0 — network failure or browser fetch was blocked (DNS, TLS, CORS, anti-bot, or kuri tab error). Try \`unbrowse go\` to open a live session, then re-run.`
      : status === 404
      ? `HTTP 404 — endpoint may be stale. Re-run via POST /v1/intent/resolve to get fresh endpoints.`
      : `HTTP ${status}`;
    // Mirror the cause into `result` so callers don't see {} with no signal.
    // (Normally, !success leaves data alone — but on status===0 / network errors,
    // data is undefined which slimTrace renders as {}.)
    // Treat null, undefined, and `{}` (empty plain object) as "no signal" —
    // mirror the cause so the agent reads it from result, not just trace.
    const isEmptyData = data == null || (
      typeof data === "object" && !Array.isArray(data) && Object.keys(data as object).length === 0
    );
    if (isEmptyData) {
      data = {
        error: status === 0 ? "network_failure" : `http_${status}`,
        message: trace.error,
        status_code: status,
      };
    }
    // Stale-endpoint eviction. 410 Gone is an unambiguous "this URL is
    // gone for good" protocol signal — evict immediately. 404 has many
    // transient causes (deploy lag, cache race, recovery in-flight,
    // params off-by-one) so count it as a strike and only evict on the
    // 2nd strike inside a 5-minute window, matching the backend's
    // 2-strike auto-deprecation. Pre-fix: single-strike 404 eviction
    // killed callable sibling endpoints during 404-recovery (bench-gate
    // probe 003 crates.io 2026-05-19, fixed end-to-end by PR #503 +
    // this strike alignment).
    if (status === 410) {
      try {
        const evicted = evictCachedEndpoint(skill.skill_id, endpoint.endpoint_id, options?.client_scope);
        if (evicted) log("exec", `evicted stale endpoint ${endpoint.endpoint_id} from local cache (HTTP 410)`);
      } catch { /* best-effort */ }
    } else if (status === 404) {
      try {
        const { shouldEvict, strikes: strikeCount } = recordEndpointStrike(
          skill.skill_id,
          endpoint.endpoint_id,
          options?.client_scope,
        );
        if (shouldEvict) {
          const evicted = evictCachedEndpoint(skill.skill_id, endpoint.endpoint_id, options?.client_scope);
          if (evicted) log("exec", `evicted stale endpoint ${endpoint.endpoint_id} from local cache (HTTP 404 strike threshold)`);
        } else {
          log("exec", `endpoint ${endpoint.endpoint_id} HTTP 404 strike ${strikeCount}/2 (not yet evicted)`);
        }
      } catch { /* best-effort */ }
    }
  } else {
    // Successful call — clear any accumulated 404 strikes so they
    // don't bleed across legitimate refreshes of a transiently-flapping
    // endpoint.
    try {
      clearEndpointStrikes(skill.skill_id, endpoint.endpoint_id, options?.client_scope);
    } catch { /* best-effort */ }
    trace.result = data;
  }

  // Stale credential detection: on 401/403, attempt auth recovery before giving up.
  // Chain: authRuntime.refreshSession (lightweight) → refreshAuthFromBrowser (re-extract)
  //        → authRuntime.loginIfNeeded (full interactive login)
  if (status === 401 || status === 403) {
    // First-line recovery: if the agent has an open browse session for this
    // domain, retry the fetch via the live tab's JS context. The real Chrome
    // tab has cookies + UA + IP + any anti-bot clearance that libcurl-class
    // server_fetch can't reproduce. This bypasses both the auth-recovery chain
    // and the vendor-specific challenge solvers when a session already exists.
    {
      const liveFetchHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(authHeaders ?? {})) {
        if (typeof v === "string") liveFetchHeaders[k.toLowerCase()] = v;
      }
      if (cookies.length > 0) {
        liveFetchHeaders["cookie"] = cookies.map((c) => {
          const v = c.value.startsWith('"') && c.value.endsWith('"') ? c.value.slice(1, -1) : c.value;
          return `${c.name}=${v}`;
        }).join("; ");
      }
      const liveResult = await tryLiveSessionFallback(
        epDomain,
        url,
        endpoint.method,
        liveFetchHeaders,
        body,
        decisionTrace,
      );
      if (liveResult && liveResult.status >= 200 && liveResult.status < 300) {
        status = liveResult.status;
        data = liveResult.data;
        trace.success = true;
        trace.status_code = status;
        trace.error = undefined;
        trace.result = data;
        return { trace, result: data, decision_trace: decisionTrace };
      }
    }
    let authRecovered = false;
    try {
      // 1. Lightweight session refresh via authRuntime
      const sessionRefreshed = await authRuntime.refreshSession(epDomain);
      if (sessionRefreshed) {
        log("auth", `session refreshed via authRuntime for ${epDomain} — retrying replay once`);
        authRecovered = true;
      }

      // 2. Re-extract cookies from browser SQLite (bird pattern)
      if (!authRecovered) {
        const browserRefreshed = await refreshAuthFromBrowser(epDomain);
        if (browserRefreshed) {
          log("auth", `credentials refreshed from browser for ${epDomain}`);
          authRecovered = true;
        }
      }

      // 3. Full login flow via authRuntime as last resort
      if (!authRecovered) {
        const loginResult = await authRuntime.loginIfNeeded(epDomain);
        if (loginResult) {
          log("auth", `loginIfNeeded succeeded for ${epDomain}`);
          authRecovered = true;
        }
      }

      if (authRecovered) {
        await reloadExecutionAuthState(skill, epDomain, authHeaders, cookies);
        const retry = await serverFetch(workflowBindings?.extraHeaders, workflowBindings?.bodyOverride);
        decisionTrace.push({ step: "auth_recovery_retry", status: retry.status });
        result = retry;
        status = retry.status;
        trace_id = retry.trace_id;
        data = retry.data;
        trace = stampTrace({
          trace_id,
          skill_id: skill.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: status >= 200 && status < 300,
          status_code: status,
        });
        (trace as ExecutionTrace & { decision_trace?: Array<Record<string, unknown>> }).decision_trace = decisionTrace;
        if (trace.success) {
          trace.result = data;
        } else {
          // Classify the retry response body too — if recovery succeeded
          // but the retry still hit DataDome/CF/PerimeterX (libcurl is still
          // libcurl after a cookie refresh), honestly mark vendor_blocked.
          const retryKind = classifyExecuteFailure({ status, body: data });
          if (retryKind.kind === "vendor_blocked") {
            trace.error = `HTTP ${status} (vendor_blocked: ${retryKind.vendor ?? "unknown"} — refreshed cookies still classified as bot)`;
            data = staleEndpointResult(
              status,
              skill,
              endpoint,
              options?.contextUrl,
              `Endpoint ${endpoint.endpoint_id} returned HTTP ${status} after credential refresh; classifier detected ${retryKind.vendor ?? "vendor"} bot mitigation. The auth refresh worked, but the libcurl signature is still being identified as non-browser. Open a live browser session for this site.`,
            );
          } else {
            trace.error = `HTTP ${status}`;
            data = staleEndpointResult(
              status,
              skill,
              endpoint,
              options?.contextUrl,
              `Credentials were refreshed, but endpoint ${endpoint.endpoint_id} still returned HTTP ${status}. Treat this marketplace route as stale and use browser capture for this task.`,
            );
          }
          trace.result = data;
        }
      } else {
        // Classify the failure body BEFORE assuming stale-credentials.
        // DataDome / CF / PerimeterX / Akamai / etc. respond with 401/403 and
        // a vendor-shaped body when classifying libcurl as a bot — recovery
        // chain has no auth to refresh because the issue is bot detection.
        const failureKind = classifyExecuteFailure({ status, body: rawFailureBody });
        // No recovery path worked
        if (skill.auth_profile_ref && failureKind.kind !== "vendor_blocked") {
          // Only delete credentials when the failure is genuinely auth.
          // Vendor-blocked sites have nothing to refresh; deleting their
          // captured cookies wastes the user's next browser session.
          await deleteCredential(skill.auth_profile_ref);
        }
        if (failureKind.kind === "vendor_blocked" && failureKind.vendor === "cloudflare") {
          // plan-v13 Tier 2A: attempt CF JS-challenge solve before declaring stale.
          // Solver fetches the CF challenge bundle, runs it in the Kuri sandbox to
          // obtain cf_clearance, then retries the original URL with merged cookies.
          // Returns null on any failure path → fall through to staleEndpointResult.
          try {
            const { solveCfAndRetry } = await import("./cf-challenge.js");
            const cfTargetUrl = endpoint.trigger_url || url;
            const cfBody = typeof rawFailureBody === "string" ? rawFailureBody : "";
            const cfSandboxBase = process.env.KURI_BASE_URL ?? "http://127.0.0.1:8080";
            decisionTrace.push({ step: "vendor_blocked_cf_solver", vendor: "cloudflare", url: cfTargetUrl });
            const cfResult = await solveCfAndRetry({
              url: cfTargetUrl,
              body: cfBody,
              cookies,
              kuriBase: cfSandboxBase,
              ...(process.env.UNBROWSE_PROXY_URL ? { proxy: process.env.UNBROWSE_PROXY_URL } : {}),
              timeoutMs: 15_000,
            });
            if (cfResult && cfResult.status >= 200 && cfResult.status < 300 && cfResult.html.length > 0) {
              trace.success = true;
              trace.status_code = cfResult.status;
              trace.error = undefined;
              data = cfResult.html;
              trace.result = data;
              decisionTrace.push({ step: "vendor_blocked_cf_solver_retry_success", status: cfResult.status, bytes: cfResult.html.length });
              return { trace, result: data, decision_trace: decisionTrace };
            }
            if (cfResult && cfResult.status >= 200 && cfResult.status < 300 && cfResult.html.length === 0) {
              decisionTrace.push({ step: "vendor_blocked_cf_solver_retry_extract_empty", status: cfResult.status });
            } else {
              decisionTrace.push({ step: "vendor_blocked_cf_solver_retry_still_blocked" });
            }
          } catch (cfErr) {
            decisionTrace.push({ step: "vendor_blocked_cf_solver_error", message: cfErr instanceof Error ? cfErr.message : String(cfErr) });
          }
          // Fall through to staleEndpointResult.
        }
        if (failureKind.kind === "vendor_blocked" && failureKind.vendor === "perimeterx") {
          // plan-v13 Tier 2B: PerimeterX bundle-replay solver. Sibling to CF arm above.
          try {
            const { solvePxAndRetry } = await import("./px-challenge.js");
            const pxTargetUrl = endpoint.trigger_url || url;
            const pxBody = typeof rawFailureBody === "string" ? rawFailureBody : "";
            const pxSandboxBase = process.env.KURI_BASE_URL ?? "http://127.0.0.1:8080";
            decisionTrace.push({ step: "vendor_blocked_px_solver", vendor: "perimeterx", url: pxTargetUrl });
            const pxResult = await solvePxAndRetry({
              url: pxTargetUrl,
              body: pxBody,
              cookies,
              kuriBase: pxSandboxBase,
              ...(process.env.UNBROWSE_PROXY_URL ? { proxy: process.env.UNBROWSE_PROXY_URL } : {}),
              timeoutMs: 30_000,
            });
            if (pxResult && pxResult.status >= 200 && pxResult.status < 300 && pxResult.html.length > 0) {
              trace.success = true;
              trace.status_code = pxResult.status;
              trace.error = undefined;
              data = pxResult.html;
              trace.result = data;
              decisionTrace.push({ step: "vendor_blocked_px_solver_retry_success", status: pxResult.status, bytes: pxResult.html.length });
              return { trace, result: data, decision_trace: decisionTrace };
            }
            if (pxResult && pxResult.status >= 200 && pxResult.status < 300 && pxResult.html.length === 0) {
              decisionTrace.push({ step: "vendor_blocked_px_solver_retry_extract_empty", status: pxResult.status });
            } else {
              decisionTrace.push({ step: "vendor_blocked_px_solver_retry_still_blocked" });
            }
          } catch (pxErr) {
            decisionTrace.push({ step: "vendor_blocked_px_solver_error", message: pxErr instanceof Error ? pxErr.message : String(pxErr) });
          }
          // Fall through to staleEndpointResult.
        }
        if (failureKind.kind === "vendor_blocked" && failureKind.vendor === "akamai_bot_manager") {
          // plan-v13 Tier 2B: Akamai bundle-replay solver. Sibling to PX arm above.
          try {
            const { solveAkamaiAndRetry } = await import("./akamai-challenge.js");
            const akTargetUrl = endpoint.trigger_url || url;
            const akBody = typeof rawFailureBody === "string" ? rawFailureBody : "";
            const akSandboxBase = process.env.KURI_BASE_URL ?? "http://127.0.0.1:8080";
            decisionTrace.push({ step: "vendor_blocked_akamai_solver", vendor: "akamai_bot_manager", url: akTargetUrl });
            const akResult = await solveAkamaiAndRetry({
              url: akTargetUrl,
              body: akBody,
              cookies,
              kuriBase: akSandboxBase,
              ...(process.env.UNBROWSE_PROXY_URL ? { proxy: process.env.UNBROWSE_PROXY_URL } : {}),
              timeoutMs: 15_000,
            });
            if (akResult && akResult.status >= 200 && akResult.status < 300 && akResult.html.length > 0) {
              trace.success = true;
              trace.status_code = akResult.status;
              trace.error = undefined;
              data = akResult.html;
              trace.result = data;
              decisionTrace.push({ step: "vendor_blocked_akamai_solver_retry_success", status: akResult.status, bytes: akResult.html.length });
              return { trace, result: data, decision_trace: decisionTrace };
            }
            if (akResult && akResult.status >= 200 && akResult.status < 300 && akResult.html.length === 0) {
              decisionTrace.push({ step: "vendor_blocked_akamai_solver_retry_extract_empty", status: akResult.status });
            } else {
              decisionTrace.push({ step: "vendor_blocked_akamai_solver_retry_still_blocked" });
            }
          } catch (akErr) {
            decisionTrace.push({ step: "vendor_blocked_akamai_solver_error", message: akErr instanceof Error ? akErr.message : String(akErr) });
          }
          // Fall through to staleEndpointResult.
        }
        if (failureKind.kind === "vendor_blocked") {
          trace.error = `${trace.error} (vendor_blocked: ${failureKind.vendor ?? "unknown"} — bot detection, not auth)`;
          data = staleEndpointResult(
            status,
            skill,
            endpoint,
            options?.contextUrl,
            `Endpoint ${endpoint.endpoint_id} returned HTTP ${status}; classifier detected ${failureKind.vendor ?? "vendor"} bot mitigation. This is not a credential issue — the libcurl replay was identified as non-browser. Open a live browser session for this site.`,
          );
        } else {
          trace.error = `${trace.error} (stale credentials — re-authenticate via /v1/auth/login)`;
          data = staleEndpointResult(
            status,
            skill,
            endpoint,
            options?.contextUrl,
            `Endpoint ${endpoint.endpoint_id} returned HTTP ${status}, and credential recovery did not produce a usable session.`,
          );
        }
        trace.result = data;
      }
    } catch {
      if (skill.auth_profile_ref) {
        await deleteCredential(skill.auth_profile_ref);
      }
      trace.error = `${trace.error} (stale credential deleted)`;
      data = staleEndpointResult(
        status,
        skill,
        endpoint,
        options?.contextUrl,
        `Endpoint ${endpoint.endpoint_id} returned HTTP ${status}; credential recovery failed and stale credentials were cleared.`,
      );
      trace.result = data;
    }
  }

  if (!trace.success && (status === 404 || status === 429 || status >= 500)) {
    // 5xx → ssr-fastpath fallback: when the captured endpoint returns a
    // transient server error (or the captured pattern is stale), try
    // libcurl-impersonate Chrome131 JA4 via Kuri sandbox at the page URL.
    // This routes through a DIFFERENT network path than serverFetch (which
    // uses Node fetch) — sites that 500 Node fetch (walmart) often return
    // 200 to libcurl-impersonate. Recursion-guarded by isPageFetchEndpoint.
    if (status >= 500 && !isPageFetchEndpoint(endpoint)) {
      const fallbackIntent = options?.intent || skill.intent_signature || "";
      const fallbackUrl = endpoint.trigger_url || url;
      decisionTrace.push({ step: "5xx_ssr_fastpath_fallback", from: endpoint.endpoint_id, original_status: status, target: fallbackUrl });
      try {
        // Ensure a Kuri instance with /v1/sandbox/replay is reachable.
        // The unbrowse server's embedded Kuri (port 6969) may lack the
        // sandbox endpoint; spawn a standalone one at 8080 if needed.
        const { ensureKuriSandboxReachable } = await import("../kuri/spawn.js");
        const sandboxBase = process.env.KURI_BASE_URL ?? "http://127.0.0.1:8080";
        const ready = await ensureKuriSandboxReachable(sandboxBase);
        if (!ready) {
          decisionTrace.push({ step: "5xx_ssr_fastpath_fallback_kuri_unavailable", target_kuri: sandboxBase });
          throw new Error(`Kuri sandbox not reachable at ${sandboxBase}`);
        }
        const { trySsrFastPathOnBlock } = await import("../capture/ssr-fastpath.js");
        const ssr = await trySsrFastPathOnBlock({ url: fallbackUrl, seedCookies: cookies, kuriBase: sandboxBase, timeoutMs: 15_000, proxy: process.env.UNBROWSE_PROXY_URL });
        if (ssr) {
          log("exec", `5xx fallback: libcurl-impersonate got ${ssr.status} ${ssr.html.length}B for ${fallbackUrl}`);
          // Run DOM extraction on the recovered HTML.
          const extracted = extractFromDOM(ssr.html, fallbackIntent);
          if (extracted.data) {
            trace.success = true;
            trace.status_code = ssr.status;
            trace.error = undefined;
            data = flattenExtracted(extracted.data);
            trace.result = data;
            decisionTrace.push({ step: "5xx_ssr_fastpath_fallback_success", status: ssr.status, bytes: ssr.html.length });
            // Skip the staleEndpointResult fall-through below.
            // Schema drift + html-postprocess sections after this `if` block
            // are guarded by `trace.success && ...` and will harmlessly run.
            return { trace, result: data };
          }
          decisionTrace.push({ step: "5xx_ssr_fastpath_fallback_extract_empty", status: ssr.status });
        } else {
          decisionTrace.push({ step: "5xx_ssr_fastpath_fallback_no_html", reason: "ssr_returned_null" });
        }
      } catch (err) {
        log("exec", `5xx ssr-fastpath fallback errored: ${err instanceof Error ? err.message : String(err)}`);
        decisionTrace.push({ step: "5xx_ssr_fastpath_fallback_error", reason: err instanceof Error ? err.message : String(err) });
      }
    }
    // B3: honor Retry-After before treating 429 as stale.
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(result?.response_headers ?? {});
      if (retryAfterMs != null) {
        const seconds = Math.ceil(retryAfterMs / 1000);
        decisionTrace.push({ step: "429_retry_after_honored", retry_after_ms: retryAfterMs });
        data = staleEndpointResult(
          status,
          skill,
          endpoint,
          options?.contextUrl,
          `Endpoint ${endpoint.endpoint_id} returned HTTP 429 (rate_limited). Server says Retry-After ${seconds}s. Wait at least that long before re-executing the same endpoint; the route is not stale, the caller is over quota.`,
        );
        trace.result = data;
      } else {
        decisionTrace.push({ step: "429_retry_after_absent" });
        data = staleEndpointResult(
          status,
          skill,
          endpoint,
          options?.contextUrl,
          `Endpoint ${endpoint.endpoint_id} returned HTTP 429 (rate_limited) with no Retry-After header. Back off exponentially (try 30s, 60s, 120s) before re-executing; the route is not stale, the caller is over quota.`,
        );
        trace.result = data;
      }
    } else {
      data = staleEndpointResult(status, skill, endpoint, options?.contextUrl);
      trace.result = data;
    }
  }

  // Schema drift detection on re-execution. When BREAKING drift is
  // observed (fields removed or types changed incompatibly), surface a
  // re_capture signal and flip success. Additive drift (new optional
  // fields, number ↔ integer JSON-refinement, null ↔ value nullable
  // variance) is recorded as informational on trace.drift but does NOT
  // fail the call — the agent's learned shape is still a valid subset.
  // The misclassification was caught by the 2026-05-17 MCP bench-gate
  // on #017 Stack Exchange (number → integer), #022 x.com HomeTimeline
  // (added forward-compat fields), and #030 PubMed (added title/url).
  // Substrate emits truth; agent judges whether to act on the info.
  if (trace.success && endpoint.response_schema && data != null) {
    const drift = detectSchemaDrift(endpoint.response_schema, data);
    if (drift.drifted) {
      const classification = classifyDrift(drift);
      trace.drift = drift;
      const recaptureSignal = buildDriftRecaptureSignal(
        drift,
        { endpoint_id: endpoint.endpoint_id, url_template: endpoint.url_template, method: endpoint.method },
        options?.contextUrl,
        options?.intent,
      );
      if (recaptureSignal && classification.is_breaking) {
        trace.steps?.push({ step: "recipe_replay_drift_recapture", reason: recaptureSignal.reason });
        trace.re_capture_signal = recaptureSignal;
        // Truth-telling coherence: a re_capture_signal for a BREAKING
        // drift is the substrate's own determination that the served
        // payload no longer matches the endpoint's learned contract.
        // "Re-capture needed" and "success: here is your data" are
        // mutually exclusive for breaking changes; flip success, name
        // the failure, foreground the signal as the actionable result.
        trace.success = false;
        trace.error = "schema_drift_recapture_required";
        data = {
          error: "schema_drift_recapture_required",
          message: `Endpoint ${endpoint.endpoint_id} response drifted from its learned schema in BREAKING ways (${recaptureSignal.reason}: removed=${classification.breaking_changes.removed_fields.length}, incompatible_type_changes=${classification.breaking_changes.incompatible_type_changes.length}); the served payload is not the contracted data. Re-learn the shape before trusting this endpoint.`,
          drift_summary: recaptureSignal.drift_summary,
          breaking_changes: classification.breaking_changes,
          re_capture_signal: recaptureSignal,
        };
        trace.result = data;
      } else if (recaptureSignal) {
        // Additive drift only — record the signal informationally so
        // the agent can choose to re-capture proactively, but do NOT
        // fail the call. The data the caller asked for is still here.
        trace.steps?.push({
          step: "drift_additive_only",
          added_fields: classification.additive_changes.added_fields.length,
          compatible_type_changes: classification.additive_changes.compatible_type_changes.length,
        });
        trace.re_capture_signal = recaptureSignal;
      }
    }
  }

  // HTML→JSON post-processing: if the endpoint returned HTML instead of JSON,
  // pipe it through DOM extraction to produce structured data.
  // Always extract — returning raw HTML to an agent is never useful.
  if (trace.success && typeof data === "string" && isHtml(data)) {
    const intent = options?.intent || skill.intent_signature;
    if (!endpoint.dom_extraction) {
      trace.success = false;
      trace.error = "unexpected_html_response";
      data = {
        error: "unexpected_html_response",
        message: `Endpoint returned HTML instead of API data for intent "${intent}"`,
      };
      trace.result = data;
    } else {
      const extracted = extractFromDOM(data, intent);
      if (extracted.data) {
        const quality = validateExtractionQuality(extracted.data, extracted.confidence, intent);
        const semanticAssessment = quality.valid ? assessIntentResult(extracted.data, intent) : { verdict: "fail" as const, reason: quality.quality_note ?? "low_quality_dom_extraction" };
        if (quality.valid && semanticAssessment.verdict !== "fail") {
          data = {
            data: extracted.data,
            _extraction: {
              method: extracted.extraction_method,
              confidence: extracted.confidence,
              source: "html-postprocess",
            },
          };
          trace.result = data;
        } else {
          trace.success = false;
          trace.error = semanticAssessment.reason ?? quality.quality_note ?? "low_quality_dom_extraction";
          data = {
            error: "low_quality_dom_extraction",
            message: `Structured DOM extraction was rejected: ${semanticAssessment.reason ?? quality.quality_note ?? "low quality extraction"}`,
          };
          trace.result = data;
        }
      }
    }
  }

  const effectiveIntent = options?.intent ?? skill.intent_signature;
  if (trace.success && effectiveIntent && data != null) {
    const semanticAssessment = assessIntentResult(data, effectiveIntent);
    if (semanticAssessment.verdict === "fail") {
      trace.success = false;
      // When the endpoint has session-bound params and the result is empty/mismatched,
      // the root cause is stale fingerprint params — not a generic intent mismatch.
      // Surface a browser_replay_only error with actionable next_step guidance.
      if (
        endpoint.policy?.requires_live_session &&
        (semanticAssessment.reason === "empty_text" || semanticAssessment.reason === "no_data" || semanticAssessment.reason === "empty_array")
      ) {
        const sessionParams = endpoint.policy.session_bound_params ?? [];
        trace.error = "browser_replay_only";
        data = {
          error: "browser_replay_only",
          message: `This endpoint requires a live browser session. ${sessionParams.length} session-bound fingerprint parameter(s) (${sessionParams.slice(0, 3).join(", ")}${sessionParams.length > 3 ? ", ..." : ""}) cannot be replayed from a capture — TikTok and similar sites validate these server-side and return empty results when they are stale.`,
          session_bound_params: sessionParams,
          next_step: `Use \`unbrowse go "${options?.contextUrl ?? skill.domain}"\` to open a live browser session, then run \`unbrowse eval "return JSON.stringify(<your extraction logic>)"\` to get the data. All traffic will be passively captured and indexed for future API replay.`,
          commands: [
            `unbrowse go "${options?.contextUrl ?? `https://${skill.domain}`}"`,
            `unbrowse eval "return document.title"`,
            "unbrowse close",
          ],
        };
      } else {
        trace.error = semanticAssessment.reason;
        data = {
          error: "intent_mismatch",
          message: `Execution result did not satisfy intent "${effectiveIntent}": ${semanticAssessment.reason}`,
          projected: semanticAssessment.projected,
        };
      }
      trace.result = data;
    }
  }

  // Backfill response_schema on first successful execution — push to marketplace so all agents benefit
  if (trace.success && !endpoint.response_schema && data != null && typeof data !== "string") {
    try {
      const inferred = inferSchema([data]);
      if (inferred.type !== "object" || inferred.properties) {
        log("exec", `learned response_schema for endpoint ${endpoint.endpoint_id} (${Object.keys(inferred.properties ?? {}).length} top-level props)`);
        endpoint.response_schema = inferred;
        trace.schema_backfilled = true;
        cachePublishedSkill(skill, options?.client_scope);
        updateEndpointSchema(skill.skill_id, endpoint.endpoint_id, inferred).catch(() => {});
      }
    } catch {}
  }

  // Record execution for reliability scoring (fire-and-forget — don't block response)
  recordExecution(skill.skill_id, endpoint.endpoint_id, trace, skill).catch(() => {});

  // Record transaction if this was a paid execution (fire-and-forget)
  if (trace.success && options?.payment_verified === true && skill.base_price_usd && skill.base_price_usd > 0) {
    const consumerConfig = (() => {
      try { return JSON.parse(require("fs").readFileSync(require("os").homedir() + "/.unbrowse/config.json", "utf-8")); }
      catch { return {}; }
    })();
    if (consumerConfig.agent_id) {
      const wallet = getLocalWalletContext();
      recordTransaction({
        transaction_id: trace.trace_id,
        consumer_id: consumerConfig.agent_id,
        creator_id: skill.indexer_id,
        skill_id: skill.skill_id,
        endpoint_id: endpoint.endpoint_id,
        price_usd: skill.base_price_usd,
        payment_proof: wallet.wallet_address ? `wallet:${wallet.wallet_address}` : undefined,
      }).catch(() => {});
    }
  }
  // Apply field projection
  let resultData = data;
  if (projection?.raw) {
    // Explicit raw request — skip projection
  } else if (projection && trace.success) {
    resultData = applyProjection(data, projection);
  } else if (trace.success) {
    resultData = projectResultForIntent(data, effectiveIntent);
  }

  if (workflowArtifact && workflowRecipe && workflowChosenStrategy) {
    const updatedWorkflow = recordWorkflowRecipeOutcome(
      workflowArtifact,
      endpoint.endpoint_id,
      workflowChosenStrategy,
      {
        success: trace.success,
        status,
        error: trace.error,
        selectedBindings: workflowBindings?.selectedBindings,
      },
    );
    const writtenPath = writeWorkflowArtifact(updatedWorkflow);
    if (process.env.UNBROWSE_DEBUG_WORKFLOW === "1") {
      log(
        "workflow",
        `execution persisted skill=${skill.skill_id} endpoint=${endpoint.endpoint_id} strategy=${workflowChosenStrategy} path=${writtenPath ?? "write-failed"}`,
      );
    }
    trace.result = trace.result;
    (trace as ExecutionTrace & { workflow_selected_bindings?: unknown; workflow_strategy?: string }).workflow_selected_bindings = workflowBindings?.selectedBindings;
    (trace as ExecutionTrace & { workflow_selected_bindings?: unknown; workflow_strategy?: string }).workflow_strategy = workflowChosenStrategy;
  }

  return {
    trace, result: resultData, decision_trace: decisionTrace,
  };
}

// ---------------------------------------------------------------------------
// executeEndpointWithChain — Layer D of the TTL-aware refetch chain.
//
// HOF wrapper over `executeEndpoint`. Walks `endpoint.semantic.requires[]`
// before issuing the leaf call. For each required binding that has a cached
// prior value in `options.session_yields`, the wrapper asks `isBindingStale`
// (Layer B) whether the cached value is still fresh under the frozen `ctx.now`.
// Stale bindings trigger a recursive call against the producer endpoint found
// via `ctx.producerIndex`; the fresh value is then written back into the
// session-yield cache for the leaf call (and any siblings still to walk).
//
// Contract:
//   - `Date.now()` is read at MOST once per top-level walk (see entry guard
//     below). Recursive calls inherit `ctx.now` unchanged.
//   - `isBindingStale` is the single authority for freshness. No inline
//     `observed_at + ttl_ms < now` lives in this function.
//   - All chain_walk_* trace steps are appended to `ctx.trace` AND merged
//     into the returned `ExecutionResult.decision_trace`.
//   - When `options.session_yields` is undefined, the wrapper has nothing
//     to evaluate and delegates straight to `executeEndpoint`.
//
// See `.claude/jesus-loop.default.architecture.md` Layer D and
// `~/.claude/projects/.../memory/project_dag_recompute_north_star.md`.
// ---------------------------------------------------------------------------
// (imports moved to top of file)

/** Build the producer index from a skill manifest exactly once per walk.
 *  Maps each provided binding key → the endpoint_id that provides it. When
 *  multiple endpoints provide the same key, the LAST one wins (deterministic
 *  for a given manifest order; bench probes that depend on ordering should
 *  not rely on this corner since it represents a malformed graph). */
function buildProducerIndex(skill: SkillManifest): Map<string, string> {
  const index = new Map<string, string>();
  const endpoints = skill.endpoints ?? [];
  for (const ep of endpoints) {
    const provides = ep.semantic?.provides ?? [];
    for (const binding of provides) {
      if (typeof binding.key === "string" && binding.key.length > 0) {
        index.set(binding.key, ep.endpoint_id);
      }
    }
  }
  return index;
}

/** Conservative extraction of a binding value from a leaf ExecutionResult.
 *  Tries top-level body field, then a `headers` map, then a `cookies` map.
 *  Returns `undefined` when no extraction pattern matches — caller treats
 *  that as `chain_walk_refetched_failure`.
 *
 *  Over-engineering here is leaven; capture-side population (Layer C) is
 *  responsible for emitting structured response bodies that surface the
 *  binding key directly. If a specific producer needs richer extraction,
 *  the right move is to fix capture, not pile heuristics here. */
function extractBindingFromResult(
  result: ExecutionResult,
  key: string,
): unknown | undefined {
  if (!key) return undefined;
  const data = result.result;
  if (data === null || data === undefined) return undefined;

  if (typeof data === "object" && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>;
    if (key in rec && rec[key] !== undefined && rec[key] !== null) {
      return rec[key];
    }
    // Common nested shapes: { headers: {...} }, { cookies: {...} }
    const headers = rec.headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      const h = headers as Record<string, unknown>;
      if (key in h && h[key] !== undefined) return h[key];
    }
    const cookies = rec.cookies;
    if (cookies && typeof cookies === "object" && !Array.isArray(cookies)) {
      const c = cookies as Record<string, unknown>;
      if (key in c && c[key] !== undefined) return c[key];
    }
  }
  return undefined;
}

/** Push a chain_walk_* step onto both the context trace and the buffer that
 *  will be merged into the returned result.decision_trace. */
function emitChainStep(
  ctx: ChainWalkContext,
  buffer: DecisionTraceStep[],
  step: DecisionTraceStep,
): void {
  ctx.trace.push(step);
  buffer.push(step);
}

/**
 * Execute an endpoint with chain-walk refetch of stale `requires[]` bindings.
 *
 * - When `options.session_yields` is undefined, behaves identically to
 *   `executeEndpoint` (no chain walk possible without a cache).
 * - When provided, every required binding key with a cached yield is judged
 *   by `isBindingStale`. Fresh bindings emit `chain_walk_fresh_reused`. Stale
 *   bindings trigger a recursive call against the producer endpoint.
 *
 * See architecture file for the canonical step-name table.
 */
export async function executeEndpointWithChain(
  skill: SkillManifest,
  endpoint: EndpointDescriptor,
  params: Record<string, unknown>,
  projection: ProjectionOptions | undefined,
  options: ExecutionOptions | undefined,
  ctx: ChainWalkContext,
): Promise<ExecutionResult> {
  // --- Frozen-clock guard. `now` is set exactly once per top-level walk. ---
  // Recursive invocations always pass a populated ctx.now down unchanged.
  if (typeof ctx.now !== "number" || !Number.isFinite(ctx.now)) {
    ctx.now = Date.now();
  }

  // --- Producer index: build once, cached on ctx for recursive frames. ---
  if (!ctx.producerIndex) {
    ctx.producerIndex = buildProducerIndex(skill);
  }

  // Local buffer of chain_walk_* steps to merge into result.decision_trace.
  const chainSteps: DecisionTraceStep[] = [];

  const yieldCache: SessionYieldCache | undefined = options?.session_yields;
  const requires = endpoint.semantic?.requires ?? [];

  // --- Walk requires[] BEFORE the leaf call. ---
  // We track keys we will mark `consumed` after the leaf call returns.
  const singleUseToConsume: string[] = [];

  // Chain-walk options sentinel (internal, same source file). The wrapper
  // attaches `_chain_walk_active: true` to the options it threads into
  // `executeEndpoint` (both the recursive producer frame via the inner
  // `executeEndpointWithChain` call and the leaf consumer call). The flag
  // tells `executeEndpoint` to:
  //   - Skip the probe ladder (HEAD + GET-1byte) — fixes Bug B's duplicate
  //     producer HTTP hit. Probe was the second hit per refetch.
  //   - Auto-confirm `idempotency: "unsafe"` mutations — when the caller
  //     hands us session_yields they have already opted into executing the
  //     consumer; refusing to dispatch would silently drop the chain.
  // Cast lives at the boundary because adding the field to `ExecutionOptions`
  // is out of this slice's editable scope.
  const chainOptions: ExecutionOptions | undefined = yieldCache
    ? ({
        ...(options ?? {}),
        confirm_unsafe: options?.confirm_unsafe ?? true,
        _chain_walk_active: true,
      } as ExecutionOptions & { _chain_walk_active: true })
    : options;

  for (const req of requires) {
    const key = req?.key;
    if (typeof key !== "string" || key.length === 0) continue;
    if (!yieldCache) continue; // No cache → nothing to evaluate, no signal.

    const cached: SessionYield | undefined = yieldCache.get(key);
    if (!cached) continue; // No prior value cached — first call for this key.

    // Build a synthetic binding from the cached yield's metadata. We pass it
    // to isBindingStale rather than reading ttl_ms/observed_at inline — the
    // predicate is the single authority for freshness.
    const syntheticBinding: OperationBinding = {
      key,
      observed_at: cached.observed_at,
      ttl_ms: cached.ttl_ms,
      single_use: cached.single_use,
    };
    const consumed = ctx.consumed.get(key) === true;
    const stale = isBindingStale(syntheticBinding, ctx.now, { consumed });

    if (!stale) {
      emitChainStep(ctx, chainSteps, {
        step: "chain_walk_fresh_reused",
        binding_key: key,
        depth: ctx.depth,
      });
      if (cached.single_use === true) {
        singleUseToConsume.push(key);
      }
      continue;
    }

    // --- Stale: look up producer. ---
    const producerEndpointId = ctx.producerIndex.get(key);
    if (!producerEndpointId) {
      emitChainStep(ctx, chainSteps, {
        step: "chain_walk_stale_skipped",
        binding_key: key,
        reason: "no_producer_in_index",
        depth: ctx.depth,
      });
      // Proceed with stale value (preserves pre-feature behavior; surfaces gap).
      if (cached.single_use === true) {
        singleUseToConsume.push(key);
      }
      continue;
    }

    if (ctx.depth >= ctx.maxDepth) {
      emitChainStep(ctx, chainSteps, {
        step: "chain_walk_depth_exceeded",
        binding_key: key,
        depth: ctx.depth,
        max_depth: ctx.maxDepth,
      });
      // Abort this branch — proceed with stale value, do not recurse.
      continue;
    }

    if (ctx.visited.has(producerEndpointId)) {
      emitChainStep(ctx, chainSteps, {
        step: "chain_walk_cycle_detected",
        binding_key: key,
        producer_endpoint_id: producerEndpointId,
        depth: ctx.depth,
      });
      continue;
    }

    const producerEndpoint = (skill.endpoints ?? []).find(
      (ep) => ep.endpoint_id === producerEndpointId,
    );
    if (!producerEndpoint) {
      emitChainStep(ctx, chainSteps, {
        step: "chain_walk_refetched_failure",
        binding_key: key,
        producer_endpoint_id: producerEndpointId,
        reason: "producer_endpoint_missing",
        depth: ctx.depth,
      });
      continue;
    }

    // --- Recurse. Mark visited BEFORE the call so any cycle this call would
    // create is caught by the recursive frame. ctx is mutated in place; the
    // child inherits the frozen clock + the same visited/consumed maps. ---
    ctx.visited.add(producerEndpointId);
    const childCtx: ChainWalkContext = {
      now: ctx.now,
      consumed: ctx.consumed,
      depth: ctx.depth + 1,
      visited: ctx.visited,
      maxDepth: ctx.maxDepth,
      trace: ctx.trace,
      producerIndex: ctx.producerIndex,
    };

    let producerResult: ExecutionResult | undefined;
    try {
      producerResult = await executeEndpointWithChain(
        skill,
        producerEndpoint,
        {},
        undefined,
        chainOptions,
        childCtx,
      );
    } catch (err) {
      emitChainStep(ctx, chainSteps, {
        step: "chain_walk_refetched_failure",
        binding_key: key,
        producer_endpoint_id: producerEndpointId,
        reason: "producer_threw",
        error: err instanceof Error ? err.message : String(err),
        depth: ctx.depth,
      });
      continue;
    }

    const producerStatus = producerResult.trace?.status_code;
    const producerOk = producerResult.trace?.success === true
      && (typeof producerStatus !== "number" || (producerStatus >= 200 && producerStatus < 300));
    if (!producerOk) {
      emitChainStep(ctx, chainSteps, {
        step: "chain_walk_refetched_failure",
        binding_key: key,
        producer_endpoint_id: producerEndpointId,
        reason: "producer_non_2xx",
        status_code: producerStatus,
        depth: ctx.depth,
      });
      continue;
    }

    // --- Bug C fix: write ALL co-yielded keys, not just the iterated one. ---
    // When a producer's `provides[]` lists multiple bindings (auth call
    // yielding both session_id AND csrf_token), a refetch satisfies every
    // co-yielded key from the SAME response. Writing back only the iterated
    // key meant the outer requires-walk would loop to the second key, find
    // it still stale, and refetch the same producer a second time. Iterate
    // every `provides[]` binding, extract the value, write fresh yield.
    const providedBindings = producerEndpoint.semantic?.provides ?? [];
    let primaryFreshValue: unknown | undefined;
    let primaryYield: SessionYield | undefined;
    for (const pb of providedBindings) {
      if (!pb || typeof pb.key !== "string" || pb.key.length === 0) continue;
      const extracted = extractBindingFromResult(producerResult, pb.key);
      if (extracted === undefined) continue;
      const refreshedYield: SessionYield = {
        value: extracted,
        observed_at: new Date(ctx.now).toISOString(),
        ttl_ms: pb.ttl_ms,
        single_use: pb.single_use,
      };
      yieldCache.set(pb.key, refreshedYield);
      // Clear any prior single-use consumption now that we have a fresh value.
      ctx.consumed.delete(pb.key);
      if (pb.key === key) {
        primaryFreshValue = extracted;
        primaryYield = refreshedYield;
      }
    }

    if (primaryFreshValue === undefined) {
      // The producer succeeded but the iterated key was not extractable —
      // still a refetch_failure for the binding the walker was asking about.
      emitChainStep(ctx, chainSteps, {
        step: "chain_walk_refetched_failure",
        binding_key: key,
        producer_endpoint_id: producerEndpointId,
        reason: "extraction_empty",
        depth: ctx.depth,
      });
      continue;
    }

    emitChainStep(ctx, chainSteps, {
      step: "chain_walk_refetched_success",
      binding_key: key,
      producer_endpoint_id: producerEndpointId,
      depth: ctx.depth,
    });

    if (primaryYield?.single_use === true) {
      singleUseToConsume.push(key);
    }
  }

  // --- Bug A fix: substitute cached yield values into params before leaf call. ---
  // Consumer endpoints often template their body / query with `{key}` placeholders
  // (e.g. body: `{ csrf_token: "{csrf_token}" }`). Without this substitution the
  // leaf call's `interpolateObj(endpoint.body, mergedParams)` leaves the literal
  // placeholder string in place because params[key] is undefined.
  //
  // Override rule: only fill in when params[key] is undefined OR matches the
  // exact `{key}` template placeholder. Caller-supplied literals are preserved.
  if (yieldCache) {
    for (const req of requires) {
      const key = req?.key;
      if (typeof key !== "string" || key.length === 0) continue;
      const cached = yieldCache.get(key);
      if (!cached) continue;
      const current = params[key];
      const isPlaceholder = typeof current === "string" && current === `{${key}}`;
      if (current === undefined || isPlaceholder) {
        params[key] = cached.value;
      }
    }
  }

  // --- Leaf call: delegate to the unmodified executeEndpoint with chainOptions. ---
  // Threading chainOptions ensures the leaf gets the same probe-skip + auto-confirm
  // treatment as recursive producer frames — symmetric within one chain walk.
  const leafResult = await executeEndpoint(skill, endpoint, params, projection, chainOptions);

  // --- Mark single-use yields consumed AFTER the leaf call returns. ---
  for (const key of singleUseToConsume) {
    ctx.consumed.set(key, true);
    emitChainStep(ctx, chainSteps, {
      step: "chain_walk_single_use_consumed",
      binding_key: key,
      depth: ctx.depth,
    });
  }

  // --- Merge chain_walk_* steps into the returned decision_trace. ---
  if (chainSteps.length > 0) {
    const existing = Array.isArray(leafResult.decision_trace)
      ? leafResult.decision_trace
      : [];
    leafResult.decision_trace = [...existing, ...chainSteps];
  }

  return leafResult;
}

/**
 * Convert query params in a URL to template variables.
 * e.g. /search?q=books&page=1 → /search?q={q}&page={page}
 * Path stays untouched — only query string is templatized.
 */
export function templatizeQueryParams(url: string): string {
  try {
    const u = sanitizeNavigationQueryParams(new URL(url));
    if (u.search.length <= 1) return url; // no query params
    const params = new URLSearchParams(u.search);
    const templated = new URLSearchParams();
    const bindings = buildQueryBindingMap(params.keys());
    const seen = new Set<string>();
    for (const [key] of params) {
      if (seen.has(key)) continue;
      seen.add(key);
      templated.set(key, `{${bindings[key] ?? key}}`);
    }
    return `${u.origin}${u.pathname}?${templated.toString().replace(/%7B/g, "{").replace(/%7D/g, "}")}`;
  } catch {
    return url;
  }
}

function interpolate(template: string, params: Record<string, unknown>): string {
  // Split URL into base and query string to properly encode query params
  const qIdx = template.indexOf("?");
  if (qIdx === -1) {
    return template.replace(/\{(\w+)\}/g, (_, k) =>
      params[k] != null ? String(params[k]) : `{${k}}`
    );
  }

  const base = template.substring(0, qIdx);
  const query = template.substring(qIdx + 1);

  // Interpolate base path without encoding
  const interpolatedBase = base.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] != null ? String(params[k]) : `{${k}}`
  );

  // Interpolate query params — light encoding that preserves () and , which some APIs require raw
  const interpolatedQuery = query.replace(/\{(\w+)\}/g, (_, k) => {
    if (params[k] == null) return `{${k}}`;
    const val = String(params[k]);
    // Only encode characters that are actually unsafe in query values
    return val.replace(/[#&=\s]/g, (ch) => encodeURIComponent(ch));
  });

  return `${interpolatedBase}?${interpolatedQuery}`;
}

function interpolateObj(
  obj: Record<string, unknown>,
  params: Record<string, unknown>
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(obj).replace(/"(\{(\w+)\})"/g, (_, _full, k) =>
      params[k] != null ? JSON.stringify(params[k]) : `"{${k}}"`
    )
  ) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Phase 7.2 — Recipe replay helpers.
// ---------------------------------------------------------------------------

/**
 * Skip recipe replay if the substituted URL still has unresolved {placeholders}
 * — replaying a malformed URL is worse than running the probe ladder for
 * re-discovery. Generic check, not a per-domain table.
 */
export function shouldReplayRecipe(_recipe: ProvenRecipe, substitutedUrl: string): boolean {
  return !/\{[a-z0-9_]+\}/i.test(substitutedUrl);
}

/**
 * Replay the proven request: merge the recipe's stable headers with current
 * authHeaders + cookies, interpolate the body with current params, and fetch.
 * Always returns a result (never throws) — status:0 on network failure.
 */
export async function replayRecipe(
  recipe: ProvenRecipe,
  url: string,
  cookies: Array<{ name: string; value: string; domain?: string }>,
  authHeaders: Record<string, string>,
  params: Record<string, unknown>,
): Promise<{ status: number; data: unknown; trace_id: string }> {
  const headers: Record<string, string> = { ...recipe.headers, ...authHeaders };
  if (cookies.length > 0) {
    headers["cookie"] = cookies
      .map((c) => {
        const v = c.value.startsWith('"') && c.value.endsWith('"') ? c.value.slice(1, -1) : c.value;
        return `${c.name}=${v}`;
      })
      .join("; ");
  }

  let body: string | undefined;
  if (recipe.body !== undefined && recipe.method !== "GET" && recipe.method !== "HEAD") {
    if (typeof recipe.body === "string") {
      body = recipe.body;
    } else if (recipe.body && typeof recipe.body === "object") {
      const interpolated = interpolateObj(recipe.body as Record<string, unknown>, params);
      body = JSON.stringify(interpolated);
    }
  }

  try {
    const res = await fetch(url, {
      method: recipe.method,
      headers,
      body,
      redirect: "follow",
    });
    const text = await res.text();
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, data, trace_id: nanoid() };
  } catch (err) {
    return {
      status: 0,
      data: { error: (err as Error).message || "network_error" },
      trace_id: nanoid(),
    };
  }
}

export interface MatchVerdict { match: boolean; reason?: string }

/**
 * Compare a replayed response against the recipe's response_signal. Strict on
 * status (drift = different status), tolerant on byte_length (50%–200% range
 * accommodates dynamic timestamps, pagination edges) and structural keys (must
 * have all recorded top-level keys; extra keys are fine).
 */
export function matchResponseSignal(
  result: { status: number; data: unknown },
  signal: ProvenRecipeResponseSignal,
): MatchVerdict {
  if (result.status !== signal.status) {
    return { match: false, reason: `status_changed: ${signal.status} → ${result.status}` };
  }
  if (
    signal.json_top_keys &&
    result.data &&
    typeof result.data === "object" &&
    !Array.isArray(result.data)
  ) {
    const actual = new Set(Object.keys(result.data as object));
    const missing = signal.json_top_keys.filter((k) => !actual.has(k));
    if (missing.length > 0) {
      return { match: false, reason: `missing_top_keys: ${missing.slice(0, 3).join(",")}` };
    }
    return { match: true };
  }
  const bodyLen = typeof result.data === "string"
    ? Buffer.byteLength(result.data)
    : Buffer.byteLength(JSON.stringify(result.data ?? null));
  if (signal.byte_length_min !== undefined && bodyLen < signal.byte_length_min) {
    return { match: false, reason: `body_shrunk: ${bodyLen}B < min ${signal.byte_length_min}B` };
  }
  if (signal.byte_length_max !== undefined && bodyLen > signal.byte_length_max) {
    return { match: false, reason: `body_grew: ${bodyLen}B > max ${signal.byte_length_max}B` };
  }
  return { match: true };
}

/**
 * BUG-004 fix: select best endpoint by schema richness, not just "first safe GET".
 * Prefers: safe endpoints with object/array response_schema > safe without > unsafe.
 */
// --- BM25 scoring for intent→endpoint relevance ---

/** Minimal stemmer: strip trailing s/es/ed/ing for matching */
function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  // "messages" → "message" (not "messag"), "classes" → "class", "pages" → "page"
  if (word.endsWith("ses") || word.endsWith("ges") || word.endsWith("ces") || word.endsWith("zes")) return word.slice(0, -1);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  // "bookmarked" → "bookmark", "saved" → "save", "liked" → "like"
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  // "loading" → "load", "trending" → "trend" (but not "thing", "ring")
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  return word;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "from",
  "get", "all", "this", "that", "is", "are", "was", "be", "it", "at", "by", "not",
  "com", "www", "https", "http", "html", "htm",
]);

/** Expand tokens with synonyms/related terms for better recall */
const SYNONYMS: Record<string, string[]> = {
  price: ["price", "prices", "pricing", "cost", "usd", "quote", "rate", "value", "market"],
  token: ["token", "tokens", "coin", "coins", "crypto", "currency", "asset"],
  search: ["search", "query", "find", "lookup", "filter", "dex"],
  chart: ["chart", "charts", "graph", "history", "ohlcv", "candle", "candles", "kline"],
  trade: ["trade", "trades", "swap", "swaps", "order", "orders", "transaction", "transactions"],
  volume: ["volume", "vol", "liquidity", "tvl"],
  pair: ["pair", "pairs", "pool", "pools"],
  trending: ["trending", "top", "hot", "gainers", "losers", "movers"],
  user: ["user", "users", "account", "accounts", "profile", "profiles", "member"],
  list: ["list", "lists", "all", "index", "browse", "catalog"],
  feed: ["feed", "feeds", "timeline", "stream", "home", "cards", "feedCards"],
  post: ["post", "posts", "article", "articles", "update", "updates", "content", "entry"],
  comment: ["comment", "comments", "reply", "replies", "discussion", "thread"],
  message: ["message", "messages", "messaging", "inbox", "conversation", "conversations", "chat"],
  notification: ["notification", "notifications", "alert", "alerts", "bell"],
  connection: ["connection", "connections", "follower", "followers", "following", "network", "contact", "contacts", "invitation", "invitations"],
  profile: ["profile", "profiles", "identity", "about", "bio", "member"],
  recommend: ["recommend", "recommendation", "recommendations", "suggested", "suggestion", "suggestions", "forYou"],
  bookmark: ["bookmark", "bookmarks", "bookmarked", "saved", "save", "favorite", "favourites"],
  news: ["news", "headline", "headlines", "story", "stories", "storylines"],
  dashboard: ["dashboard", "overview", "summary", "home", "main"],
};

function normalizeTokenText(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2");
}

function tokenize(text: string): string[] {
  return normalizeTokenText(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Expand intent tokens with synonyms + stemmed variants for better matching */
function expandQuery(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const stemmed = stem(t);
    expanded.add(stemmed);
    // Look up synonyms by: raw token, stemmed token, or any SYNONYMS key that stems to the same value
    // (e.g. "messages" → stem "messag" matches SYNONYMS["message"] → stem "messag")
    let syns = SYNONYMS[t] ?? SYNONYMS[stemmed];
    if (!syns) {
      for (const key of Object.keys(SYNONYMS)) {
        if (stem(key) === stemmed) { syns = SYNONYMS[key]; break; }
      }
    }
    if (syns) for (const s of syns) { expanded.add(s); expanded.add(stem(s)); }
  }
  return [...expanded];
}

/** Build a "document" from an endpoint: URL path segments + query params + schema property names */
function endpointToTokens(ep: EndpointDescriptor): string[] {
  const tokens: string[] = [];
  try {
    const u = new URL(ep.url_template);
    // Path segments — split on delimiters AND camelCase to extract meaningful words
    // e.g. "BookmarkFoldersSlice" → ["Bookmark", "Folders", "Slice"]
    const rawSegments = u.pathname.split(/[/\-_.{}]/).filter((s) => s.length > 1 && !/^v\d+$/.test(s));
    for (const seg of rawSegments) {
      tokens.push(seg);
      // Also split camelCase: "BookmarkFoldersSlice" → ["Bookmark", "Folders", "Slice"]
      const camelParts = seg.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter((s) => s.length > 1);
      if (camelParts.length > 1) tokens.push(...camelParts);
    }
    // Hostname subdomains (e.g. "api" from api.dexscreener.com — strong signal)
    const hostParts = u.hostname.split(".");
    tokens.push(...hostParts.filter((s) => s.length > 2 && s !== "www" && s !== "com" && s !== "org" && s !== "net" && s !== "io"));
    // Query param names and values
    for (const [key, val] of u.searchParams.entries()) {
      tokens.push(key);
      if (val.length > 1 && val.length < 50) {
        tokens.push(...val.split(/[/\-_.]/).filter((s) => s.length > 1));
      } else if (val.length >= 50) {
        // Long values (e.g. graphql queryId): split on camelCase and delimiters to extract meaningful words
        const parts = val.split(/[/\-_.()]/).flatMap((s) => s.split(/(?<=[a-z])(?=[A-Z])/)).filter((s) => s.length > 1);
        tokens.push(...parts.slice(0, 10)); // cap to avoid noise from hashes
      }
    }
  } catch { /* skip */ }
  // Schema property names (strong signal — these describe the response data)
  if (ep.response_schema?.properties) {
    tokens.push(...Object.keys(ep.response_schema.properties));
    // Also add nested property names (1 level deep)
    for (const val of Object.values(ep.response_schema.properties) as Array<{ properties?: Record<string, unknown> }>) {
      if (val?.properties) tokens.push(...Object.keys(val.properties));
    }
  }
  // Trigger URL path segments — reveals which page triggered this API call
  // e.g., trigger_url="/i/bookmarks" adds "bookmarks" token for BM25 matching
  if (ep.trigger_url) {
    try {
      const tu = new URL(ep.trigger_url);
      tokens.push(...tu.pathname.split(/[/\-_.{}]/).filter((s) => s.length > 1 && !/^(i|app|en|v\d+)$/.test(s)));
    } catch { /* skip */ }
  }
  // LLM-generated description — strongest semantic signal for intent matching.
  // Tokenized words are added 3x to boost their BM25 weight over noisy URL tokens.
  if (ep.description) {
    const descTokens = ep.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
    for (let i = 0; i < 3; i++) tokens.push(...descTokens);
  }
  return tokens.map((t) => stem(t.toLowerCase()));
}


export interface RankedEndpoint {
  endpoint: EndpointDescriptor;
  score: number;
}

export function intentResourceKinds(intent?: string): string[] {
  const lower = (intent ?? "").toLowerCase();
  if (/\b(person|people|profile|profiles|user|users|member|members)\b/.test(lower)) return ["person", "people", "profile", "user", "member"];
  if (/\b(company|organization|org)\b/.test(lower)) return ["company", "organization", "org", "business"];
  if (/\b(post|posts|tweet|tweets|status|statuses|feed|timeline|stream|home)\b/.test(lower)) return ["post", "tweet", "status", "message", "feed", "timeline", "update"];
  if (/\b(topic|topics|trend|trending|hashtag|hashtags)\b/.test(lower)) return ["topic", "trend", "hashtag"];
  if (/\b(repo|repository|repositories)\b/.test(lower)) return ["repo", "repository", "project"];
  return [];
}

export function intentActionKinds(intent?: string): string[] {
  const lower = (intent ?? "").toLowerCase();
  if (/\b(feed|timeline|stream|home)\b/.test(lower)) return ["list", "feed", "timeline"];
  if (/\b(search|find|lookup)\b/.test(lower)) return ["search", "list"];
  if (/\b(get|fetch|view)\b/.test(lower)) return ["detail", "get", "fetch"];
  if (/\b(list|browse|discover|trending|top|latest)\b/.test(lower)) return ["list", "search"];
  return [];
}

function isEntityDetailIntent(intent?: string): boolean {
  const lower = (intent ?? "").toLowerCase();
  return /\b(get|fetch|view)\b/.test(lower) && /\b(company|organization|org|business|person|people|profile|profiles|user|users|member|members)\b/.test(lower);
}

/**
 * Detect browser-block signals from capture evidence. Pure function — no
 * closure state — so the full rule set can be unit-tested and evolved
 * without touching the execute() flow. Signals are raw evidence the
 * agent/harness judges with; this function never returns a verdict.
 */
export function detectBrowserBlockSignals(input: {
  requestUrls: string[];
  title: string;
  htmlLength: number;
  rejectionCounts: Record<string, number>;
}): string[] {
  const { requestUrls, title, htmlLength, rejectionCounts } = input;
  const signals: string[] = [];
  const titleLower = title.toLowerCase();
  if (/just a moment|attention required|access denied|pardon our interruption|captcha|verifying you are human|human verification|are you a robot|bot check|cloudflare|press and hold|request could not be satisfied|403 forbidden|\b404\b|\b502\b|\b503\b|\b504\b|bad gateway|service unavailable|gateway timeout|site blocked|unusual traffic|security check|not[ _.]?found|page (does )?not exist|page doesn't exist|this page can't be|server error|client challenge|checking your browser/i.test(titleLower)) {
    signals.push("challenge_title");
  }
  const vendorHits = new Set<string>();
  for (const u of requestUrls) {
    // PerimeterX: vendor CDN hosts + first-party proxied patterns. PX is
    // usually served through the site's own domain via a UUID/UUID path
    // that ends in ips.js (bot-detection script) or /tl (telemetry). The
    // KP_UIDz= query param is a PX session identifier.
    if (
      /perimeterx|px-cloud|px-cdn|pxhd\.net/i.test(u) ||
      /KP_UIDz=/.test(u) ||
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(ips\.js|tl|xhr|init)/i.test(u)
    ) {
      vendorHits.add("perimeterx");
    }
    // captcha-delivery.com is DataDome's hosted captcha CDN — observed in
    // rejected_samples for g2.com and leboncoin.fr but not matched by the
    // body-marker patterns above. Adding here promotes those rows from
    // soft_block → vendor_blocked in the bench classifier.
    if (/datadome|js\.datadome|dd\.datadome|_dd\.s|ddjskey|captcha-delivery\.com/i.test(u)) vendorHits.add("datadome");
    if (/akamaihd|ak-challenge|_Incapsula|incapsula|reese84/i.test(u)) vendorHits.add("imperva_incapsula");
    // Akamai Bot Manager — used by walmart, delta, target, many retail
    // Detected via: _abck cookie usage, akam.net, bot-defender, /_bm/ paths,
    // and Akamai sensor_data collection endpoint.
    if (/akam\.net|bot-defender|\/_bm\/|sensor[-_]data|bm\.nuid|_abck/i.test(u)) vendorHits.add("akamai_bot_manager");
    // cdn-cgi/challenge-platform is Cloudflare's managed challenge JS path
    // (Turnstile + JS-detect). Observed in rejected_samples for g2.com.
    // The other tokens cover challenge cookies and Turnstile widget hosts;
    // this adds the script-load path the page itself fetches.
    if (/cf-challenge|__cf_chl_|turnstile|challenges\.cloudflare|cdn-cgi\/challenge-platform/i.test(u)) vendorHits.add("cloudflare");
    if (/\/_fs-ch-[A-Za-z0-9]+\//.test(u)) vendorHits.add("fastly_bot_management");
    if (/hcaptcha|recaptcha|arkoselabs|funcaptcha/i.test(u)) vendorHits.add("captcha_vendor");
    if (/shape\.security|f5\.com\/shape|ShapeSecurity/i.test(u)) vendorHits.add("shape_security");
    if (/kasada|client\.kasada|ips\.kasada/i.test(u)) vendorHits.add("kasada");
  }
  for (const v of vendorHits) signals.push(`vendor:${v}`);
  const apiCallCount = requestUrls.length;
  const noisyRejections =
    (rejectionCounts.not_api_like ?? 0) +
    (rejectionCounts.score_non_positive ?? 0);
  if (apiCallCount > 0 && apiCallCount <= 20 && noisyRejections >= Math.max(1, Math.floor(apiCallCount * 0.6))) {
    signals.push("sparse_capture_mostly_noise");
  }
  if (htmlLength < 500 && apiCallCount === 0) {
    signals.push("empty_capture");
  }
  if (htmlLength < 500 && apiCallCount >= 30) {
    signals.push("no_html_many_apis");
  }
  // Between empty_capture (0 apis) and no_html_many_apis (>=30), there's
  // a middle case: tiny HTML + 1-29 apis. Observed on allmovie.com:
  // html=141, apis=1. The browser barely loaded and only saw one request
  // (probably the main document). Treat same as other low-capture blocks.
  if (htmlLength < 500 && apiCallCount > 0 && apiCallCount < 30) {
    signals.push("low_capture");
  }
  return signals;
}

/**
 * Classify why an EXECUTE replay failed when status ∈ {401, 403}. Companion
 * to detectBrowserBlockSignals (which runs at capture time on the live page);
 * this runs at execute time on the upstream replay response body so we can
 * tell apart "your cookies expired" (stale_credentials, the existing path)
 * from "DataDome/CF/PerimeterX classified your libcurl as a bot"
 * (vendor_blocked, previously misreported as stale_credentials).
 *
 * Default = stale_credentials when nothing matches — preserves prior
 * behavior on no-signal so this is a strict additive distinction.
 */
export function classifyExecuteFailure(input: {
  status: number;
  body: unknown;
  headers?: Record<string, string | string[] | undefined>;
}): { kind: "vendor_blocked" | "stale_credentials" | "transient"; vendor?: string; evidence?: string } {
  const { status, body, headers } = input;
  // Normalize body to a searchable string. JSON envelopes (already parsed)
  // get stringified; HTML/text bodies pass through; null/undefined → "".
  let bodyStr = "";
  if (typeof body === "string") bodyStr = body;
  else if (body != null) {
    try { bodyStr = JSON.stringify(body); } catch { bodyStr = String(body); }
  }
  const sample = bodyStr.length > 16384 ? bodyStr.slice(0, 16384) : bodyStr;
  const lower = sample.toLowerCase();
  const headerLines: string[] = [];
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      const val = Array.isArray(v) ? v.join("; ") : v;
      headerLines.push(`${k.toLowerCase()}: ${val.toLowerCase()}`);
    }
  }
  const headerStr = headerLines.join("\n");

  // Vendor markers — body OR headers can carry them. Order matters: more
  // specific vendors first so we don't tag a DataDome page as "captcha_vendor".
  // Patterns lifted from detectBrowserBlockSignals to keep one source of truth.
  if (
    /datadome|js\.datadome|dd\.datadome|_dd\.s|ddjskey|captcha-delivery|"action_message":"please[^"]+enable|x-dd-b|'rt':'c'/i.test(sample) ||
    /\bdatadome=|x-datadome|x-dd-b/.test(headerStr)
  ) return { kind: "vendor_blocked", vendor: "datadome", evidence: "body_or_header_marker" };
  if (
    /perimeterx|px-cloud|px-cdn|pxhd\.net|_pxhd|_pxvid|"appId":"px"/i.test(sample) ||
    /\bpx_=|_pxhd=/.test(headerStr)
  ) return { kind: "vendor_blocked", vendor: "perimeterx", evidence: "body_or_header_marker" };
  if (
    /akam\.net|bot-defender|\/_bm\/|sensor[-_]data|bm\.nuid|_abck/i.test(sample) ||
    /\b_abck=|akam-/.test(headerStr)
  ) return { kind: "vendor_blocked", vendor: "akamai_bot_manager", evidence: "body_or_header_marker" };
  if (
    /cf-challenge|__cf_chl_|cf_clearance|turnstile|cdn-cgi\/challenge|challenges\.cloudflare/i.test(sample) ||
    /\bcf-mitigated|server: cloudflare/.test(headerStr) && status === 403
  ) return { kind: "vendor_blocked", vendor: "cloudflare", evidence: "body_or_header_marker" };
  if (/_incapsula|incapsula|reese84|imperva/i.test(sample)) {
    return { kind: "vendor_blocked", vendor: "imperva_incapsula", evidence: "body_marker" };
  }
  if (/\/_fs-ch-[a-z0-9]+\//i.test(sample)) {
    return { kind: "vendor_blocked", vendor: "fastly_bot_management", evidence: "body_marker" };
  }
  if (/kasada|client\.kasada|ips\.kasada|x-kpsdk-/i.test(sample) || /\bx-kpsdk-/i.test(headerStr)) {
    return { kind: "vendor_blocked", vendor: "kasada", evidence: "body_or_header_marker" };
  }
  if (/shape\.security|f5\.com\/shape|shapesecurity/i.test(sample)) {
    return { kind: "vendor_blocked", vendor: "shape_security", evidence: "body_marker" };
  }
  if (/hcaptcha|h-captcha|recaptcha|arkoselabs|funcaptcha|g-recaptcha-response|data-sitekey/i.test(sample)) {
    return { kind: "vendor_blocked", vendor: "captcha_vendor", evidence: "body_marker" };
  }

  // Title-of-an-HTML-error-page check — catches cases where the body is a
  // generic challenge page without a vendor-specific marker.
  const titleMatch = sample.match(/<title[^>]*>([^<]{0,200})<\/title>/i);
  if (titleMatch) {
    const t = titleMatch[1].toLowerCase();
    if (/just a moment|attention required|access denied|pardon our interruption|verifying you are human|are you a robot|bot check|press and hold|unusual traffic|security check|client challenge|checking your browser|captcha|accès bloqué|acceso denegado|zugriff verweigert|アクセス拒否|访问被拒绝|доступ запрещ|blocked|access blocked|forbidden/i.test(t)) {
      return { kind: "vendor_blocked", vendor: "generic_challenge", evidence: `title:${t.slice(0, 80)}` };
    }
  }

  // Reserved for future 5xx work — not used this iteration.
  if (status >= 500) return { kind: "transient", evidence: `http_${status}` };

  // Default: preserve prior behavior — caller's stale_credentials path.
  return { kind: "stale_credentials" };
}

/**
 * Extract a bundle replay snapshot from captured network traffic. Companion
 * to detectBrowserBlockSignals — when that returns a vendor signal, this
 * pulls out the URLs that triggered it so the deep-reveng sandbox runtime
 * (Kuri /v1/sandbox/replay) can replay the bundle and harvest cookies.
 *
 * Bundle URLs are the JS files the vendor serves to the browser to compute
 * the auth cookie. We capture them all and let the agent / strategy decide
 * which to feed into the sandbox first (usually the largest one — that's
 * the actual challenge bundle, not telemetry/init beacons).
 *
 * Returns null if no vendor block was detected.
 */
export function extractBundleSnapshot(input: {
  requestUrls: string[];
  blockSignals: string[];
  targetOrigin: string;
  targetHref: string;
  cookieNames?: string[];
}): {
  vendor: string;
  bundle_urls: string[];
  cookie_issuing_urls: string[];
  target_origin: string;
  target_href: string;
  captured_at: number;
} | null {
  const { requestUrls, blockSignals, targetOrigin, targetHref, cookieNames } = input;
  let vendor = blockSignals.find((s) => s.startsWith("vendor:"))?.slice("vendor:".length);
  if (!vendor) return null;

  // Disambiguate misclassified perimeterx labels.
  //
  // The upstream URL-shape classifier (detectBrowserBlockSignals) tags any
  // /<uuid>/<uuid>/(ips.js|tl|xhr|init) request stream as "perimeterx" because
  // PX commonly serves first-party bundles at that shape. But Akamai Bot
  // Manager and Kasada also use two-UUID-pair paths for their first-party
  // bundles. Wiring the PerimeterX challenge solver against an Akamai/Kasada
  // body would fail. Disambiguate using query-param markers on the captured
  // bundle URLs and (when available) cookie-name evidence — pure structural
  // signals, no per-host branches.
  if (vendor === "perimeterx") {
    const hasAkamaiQuery = requestUrls.some((u) => /[?&]akm_bmfp/i.test(u));
    const hasKasadaQuery = requestUrls.some((u) => /[?&]x-kpsdk/i.test(u));
    const cookieSet = (cookieNames ?? []).map((c) => c.toLowerCase());
    const hasPxCookie = cookieSet.some((c) => c === "_pxhd" || c === "_px3" || c === "_pxvid");
    if (hasAkamaiQuery && !hasPxCookie) {
      vendor = "akamai_bot_manager";
    } else if (hasKasadaQuery && !hasPxCookie) {
      vendor = "kasada";
    } else if (!hasPxCookie) {
      // No disambiguation signal AND no PX cookie evidence → check whether
      // anything in the captured URLs proves PX (vendor host or KP_UIDz).
      // The two-UUID-pair shape alone is shared by PX/Akamai/Kasada and
      // cannot be trusted as the sole signal. Bail rather than fire the
      // wrong solver.
      const hasPxUrlEvidence = requestUrls.some((u) =>
        /perimeterx|px-cloud|px-cdn|pxhd\.net|KP_UIDz=/i.test(u),
      );
      if (!hasPxUrlEvidence) return null;
    }
  }

  // Per-vendor URL pattern matchers — keep in lockstep with detectBrowserBlockSignals.
  const matchers: Record<string, RegExp[]> = {
    perimeterx: [
      /perimeterx|px-cloud|px-cdn|pxhd\.net/i,
      /KP_UIDz=/,
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(ips\.js|tl|xhr|init)/i,
    ],
    datadome: [/datadome|js\.datadome|dd\.datadome|_dd\.s|ddjskey/i],
    imperva_incapsula: [/akamaihd|ak-challenge|_Incapsula|incapsula|reese84/i],
    akamai_bot_manager: [
      /akam\.net|bot-defender|\/_bm\/|sensor[-_]data|bm\.nuid|_abck/i,
      /[?&]akm_bmfp/i,
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(ips\.js|tl|xhr|init)/i,
    ],
    cloudflare: [/cf-challenge|__cf_chl_|turnstile|challenges\.cloudflare/i],
    fastly_bot_management: [/\/_fs-ch-[A-Za-z0-9]+\//],
    captcha_vendor: [/hcaptcha|recaptcha|arkoselabs|funcaptcha/i],
    shape_security: [/shape\.security|f5\.com\/shape|ShapeSecurity/i],
    kasada: [
      /kasada|client\.kasada|ips\.kasada/i,
      /[?&]x-kpsdk/i,
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(ips\.js|tl|xhr|init)/i,
    ],
  };
  const patterns = matchers[vendor] ?? [];
  const matched = requestUrls.filter((u) => patterns.some((p) => p.test(u)));

  // Bundle URLs: .js files (the actual challenge logic).
  // Cookie-issuing: the rest (telemetry / init / token-POST endpoints — these
  // are the ones the bundle calls back to during execution to get its salt).
  const bundleUrls: string[] = [];
  const cookieIssuingUrls: string[] = [];
  for (const u of matched) {
    if (/\.js(\?|$|#)/i.test(u) || /ips\.js/i.test(u)) bundleUrls.push(u);
    else cookieIssuingUrls.push(u);
  }

  if (bundleUrls.length === 0 && cookieIssuingUrls.length === 0) return null;

  return {
    vendor,
    bundle_urls: bundleUrls,
    cookie_issuing_urls: cookieIssuingUrls,
    target_origin: targetOrigin,
    target_href: targetHref,
    captured_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Rank endpoints by relevance to intent using BM25 + structural bonuses.
 * Exported so routes.ts can surface the ranked list to the agent.
 */

/**
 * GraphQL endpoints (especially X.com / LinkedIn / TikTok) capture as URL
 * templates with opaque {variables} and {features} JSON slots. Agents shouldn't
 * have to hand-craft those JSON blobs — they should pass flat params like q,
 * count, cursor and the executor reconstructs the GraphQL request shape from
 * the captured example.
 *
 * decomposeGraphqlEndpoint detects GraphQL endpoints, parses the captured
 * example_request.variables JSON into per-leaf agent params, and returns the
 * shape the resolver and executor need.
 */
export interface GraphqlDecomposition {
  isGraphql: boolean;
  operationName?: string;
  variablesTemplate?: Record<string, unknown>;
  featuresTemplate?: string;
  /** Flat agent-friendly params derived from variables.top_level_keys */
  agentParams: Array<{
    key: string;
    semantic_type: string;
    required: boolean;
    example: unknown;
    /** Path inside variables JSON, e.g. "rawQuery" or "userId" */
    variables_path: string;
  }>;
}

export function decomposeGraphqlEndpoint(endpoint: EndpointDescriptor): GraphqlDecomposition {
  const url = endpoint.url_template ?? "";
  const looksGraphql =
    /\/graphql\//i.test(url) ||
    /\bvariables=\{variables\}/.test(url) ||
    (Array.isArray(endpoint.semantic?.requires) &&
      endpoint.semantic!.requires.some((r) => r.key === "variables") &&
      endpoint.semantic!.requires.some((r) => r.key === "features"));
  if (!looksGraphql) return { isGraphql: false, agentParams: [] };

  // Operation name = last URL segment (before query string)
  let operationName: string | undefined;
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    if (segs.length) operationName = segs[segs.length - 1];
  } catch { /* ignore */ }

  const exampleReq = (endpoint.semantic?.example_request ?? endpoint.body ?? {}) as Record<string, unknown>;
  let variablesTemplate: Record<string, unknown> | undefined;
  const rawVariables = exampleReq.variables;
  if (rawVariables && typeof rawVariables === "object") {
    variablesTemplate = rawVariables as Record<string, unknown>;
  } else if (typeof rawVariables === "string") {
    try { variablesTemplate = JSON.parse(rawVariables); } catch { /* ignore */ }
  }
  let featuresTemplate: string | undefined;
  const rawFeatures = exampleReq.features;
  if (typeof rawFeatures === "string") featuresTemplate = rawFeatures;
  else if (rawFeatures && typeof rawFeatures === "object") featuresTemplate = JSON.stringify(rawFeatures);

  // Build agentParams from variables top-level keys.
  const agentParams: GraphqlDecomposition["agentParams"] = [];
  if (variablesTemplate) {
    for (const [key, value] of Object.entries(variablesTemplate)) {
      // Skip placeholder-only keys ({variables_seentweetids_0} etc.)
      if (typeof value === "string" && /^\{[a-z0-9_]+_\d+\}$/i.test(value)) continue;
      // Skip arrays of placeholders (the captured payload's seenTweetIds shape)
      if (Array.isArray(value) && value.every((v) => typeof v === "string" && /^\{[a-z0-9_]+_\d+\}$/i.test(v))) continue;
      // Surface scalar leaves only — skip nested objects and arrays of objects
      if (value && typeof value === "object" && !Array.isArray(value)) continue;
      agentParams.push({
        key,
        semantic_type: typeof value === "string" ? "string" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "input",
        required: false,
        example: value,
        variables_path: key,
      });
    }
  }

  return {
    isGraphql: true,
    operationName,
    variablesTemplate,
    featuresTemplate,
    agentParams,
  };
}

/**
 * Build the URL-encoded {variables, features} pair for a GraphQL endpoint
 * given agent-supplied flat params. Falls back to captured example values
 * for any field the agent didn't provide. Used by executeEndpoint when it
 * detects a GraphQL endpoint.
 */
export function buildGraphqlRequestParams(
  decomp: GraphqlDecomposition,
  agentParams: Record<string, unknown>,
): { variables: string; features: string } {
  const vars: Record<string, unknown> = decomp.variablesTemplate ? JSON.parse(JSON.stringify(decomp.variablesTemplate)) : {};
  // Drop placeholder pseudo-values from the example so they don't leak into the request
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "string" && /^\{[a-z0-9_]+_\d+\}$/i.test(v)) delete vars[k];
    if (Array.isArray(v) && v.every((x) => typeof x === "string" && /^\{[a-z0-9_]+_\d+\}$/i.test(x))) delete vars[k];
  }
  // Fill from agent params by direct key match. Agents read agentParams[].key
  // (the actual GraphQL variables key with its example value) and pass that
  // verbatim. No alias registry — if the agent wants `q` to map to `rawQuery`,
  // they can read decomp.agentParams to see the real key, or an LLM judge can
  // reshape the params on the way in.
  for (const [k, v] of Object.entries(agentParams)) {
    if (vars[k] !== undefined || decomp.agentParams.some((p) => p.variables_path === k)) {
      vars[k] = v;
    }
  }
  return {
    variables: JSON.stringify(vars),
    features: decomp.featuresTemplate ?? "{}",
  };
}

export function rankEndpoints(endpoints: EndpointDescriptor[], intent?: string, skillDomain?: string, contextUrl?: string, params?: Record<string, unknown>): RankedEndpoint[] {
  // Noise filter patterns moved to src/ranking/filters/noise-patterns.ts (P1 W3 cleanup)
  const filtered = endpoints.filter((ep) => {
    if (ep.method === "HEAD" || ep.method === "OPTIONS") return false;
    if (ep.verification_status === "disabled") return false;
    if (STATIC_ASSET_PATTERNS.test(ep.url_template)) return false;
    if (UI_ASSET_PATHS.test(ep.url_template)) return false;
    try {
      const host = new URL(ep.url_template).hostname;
      if (NOISE_HOSTS.test(host)) return false;
    } catch { /* skip */ }
    if (NOISE_PATHS.test(ep.url_template)) return false;
    if (I18N_CONFIG_PATHS.test(ep.url_template)) return false;
    if (AUTH_CONFIG_PATHS.test(ep.url_template)) return false;
    if (SESSION_PLUMBING.test(ep.url_template)) return false;
    return true;
  });

  const nonDisabled = endpoints.filter((ep) => ep.verification_status !== "disabled");
  const candidates = filtered.length > 0 ? filtered : nonDisabled;
  if (candidates.length === 0) return [];
  const intentLower = (intent ?? "").toLowerCase();

  function endpointHaystack(ep: EndpointDescriptor): string {
    return `${ep.url_template} ${ep.description ?? ""} ${JSON.stringify(ep.response_schema ?? {})} ${JSON.stringify(resolveEndpointSemantic(ep) ?? {})}`.toLowerCase();
  }

  function isPlausibleForIntent(ep: EndpointDescriptor): boolean {
    if (!intentLower) return true;
    const haystack = endpointHaystack(ep);

    if (/\b(stock|stocks|ticker|tickers|quote|quotes)\b/.test(intentLower)) {
      const hasPositive = /(symbol|ticker|regularmarketprice|currentprice|marketcap|currency|change_percent|changepercent|quote)/i.test(haystack);
      const hasNegative = /(news|article|articles|video|story|stories|thumbnail|image|author)/i.test(haystack);
      return hasPositive && !hasNegative;
    }

    if (/\b(product|products|item|items)\b/.test(intentLower)) {
      const hasPositive = /(product|products|itemstacks|items\[\]|price|rating|review|reviewcount|numberofreviews|brand|sku|usitemid|catalogproducttype)/i.test(haystack);
      const hasNegative = /(captcha|robot|human|bootstrapdata|traceparent|nonce|psych|isomorphicsessionid|persistedqueriesconfig|errorloggingconfig|renderviewid|headerobj|initialtempodata|wcpbeacon)/i.test(haystack);
      return hasPositive && !hasNegative;
    }

    // "channel/server/guild/workspace" plausibility only applies to chat/team platforms
    // (Discord, Slack, Teams). YouTube channels and video "channels" must not be filtered
    // here — their endpoints use /youtubei/, /v1/, etc. without guild/member_count signals.
    if (/\b(channel|channels|server|servers|guild|guilds|workspace|workspaces)\b/.test(intentLower)) {
      const isChatPlatformContext = /(discord|slack|teams|guilds?|workspaces?)/.test(
        (skillDomain ?? "").toLowerCase() + (contextUrl ?? "").toLowerCase(),
      );
      if (isChatPlatformContext) {
        const hasEntitySignal = /(\/guilds\b|\/channels\b|\bguilds?\b|\bchannels?\b|\bservers?\b|\bworkspaces?\b)/i.test(haystack);
        const hasFieldSignal = /\b(ids?|names?|icon|member_count|topic|description)\b/i.test(haystack);
        const hasPositive = hasEntitySignal && hasFieldSignal;
        const hasNegative = /(affinit|preview|quests|survey|referrals?|promotions?|science|detectable|applications\/public|\/games\b|entitlements?|billing|subscriptions?|collectibles?|gifts?|experiments?|connections?|status|incidents?|scheduled-maintenances?)/i.test(haystack);
        return hasPositive && !hasNegative;
      }
    }

    return true;
  }

  const plausibilityScopedIntent = /\b(stock|stocks|ticker|tickers|quote|quotes|product|products|item|items|channel|channels|server|servers|guild|guilds|workspace|workspaces)\b/.test(intentLower);
  const plausibleCandidates = candidates.filter((ep) => isPlausibleForIntent(ep));
  if (plausibilityScopedIntent && plausibleCandidates.length === 0) return [];
  const rankedCandidates = plausibleCandidates.length > 0 ? plausibleCandidates : candidates;
  const structuredApiTriggers = new Set(
    rankedCandidates
      .filter((ep) => {
        const url = ep.url_template.toLowerCase();
        const looksLikeApiEndpoint = looksLikeApiUrl(url);
        return !!ep.trigger_url && !ep.dom_extraction && (looksLikeApiEndpoint || !!ep.response_schema || ep.method === "WS");
      })
      .map((ep) => ep.trigger_url)
      .filter((value): value is string => !!value),
  );

  // Generic structural signal: any sibling candidate is a real API endpoint?
  // Used to demote captured-page-artifacts when a structured alternative exists,
  // independent of trigger_url linkage (marketplace skills + test fixtures often lack it).
  const hasStructuredApiInCorpus = rankedCandidates.some((ep) => {
    const url = ep.url_template.toLowerCase();
    const looksLikeApi = looksLikeApiUrl(url);
    return looksLikeApi && !ep.dom_extraction && !/captured (?:search form |page )?artifact/i.test(ep.description ?? "");
  });
  const endpointHasSearchBinding = (ep: EndpointDescriptor): boolean => {
    const haystack = JSON.stringify({
      url_template: ep.url_template,
      query: ep.query ?? {},
      body_params: ep.body_params ?? {},
      body: ep.body ?? {},
      semantic_requires: resolveEndpointSemantic(ep)?.requires ?? [],
    }).toLowerCase();
    return /(?:^|[^a-z])(q|query|search|term|keyword|keywords|text|s)(?:[^a-z]|$)/i.test(haystack);
  };
  const hasStructuredSearchApiInCorpus = rankedCandidates.some((ep) => {
    const url = ep.url_template.toLowerCase();
    const looksLikeApi = looksLikeApiUrl(url);
    return looksLikeApi
      && !ep.dom_extraction
      && !!ep.response_schema
      && endpointHasSearchBinding(ep)
      && !/captured (?:search form |page )?artifact/i.test(ep.description ?? "");
  });

  // Tokenize intent with synonym expansion for better recall
  const rawTokens = intent ? tokenize(intent) : [];
  const queryTokens = rawTokens.length > 0 ? expandQuery(rawTokens) : [];
  const docs = rankedCandidates.map((ep) => endpointToTokens(ep));
  const avgDl = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;

  // Build corpus-level document frequencies for real IDF
  const docFreqs = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set(doc);
    for (const t of seen) docFreqs.set(t, (docFreqs.get(t) ?? 0) + 1);
  }
  const docCount = docs.length;

  // Meta/support/promo/config path patterns — not primary data
  const META_PATHS = /\/(annotation|insight|sentiment|vote|portfolio|summary_button|summary_card|tagmetric|quick_add|notifications?|preferences|settings|onboarding|public\/active|remoteConfig|banner\/metadata|embedded-wallets|glow\/get-rendered)/i;

  // Data format indicators
  const DATA_INDICATORS = /\.(json|xml|csv)(\?|$)|\/api\//i;

  // Currency/time patterns — strong price/financial signal
  const CURRENCY_TIME_PATTERNS = /\/(usd|eur|gbp|btc|eth|sol|cny|jpy|krw|24_hours|7_days|30_days|1_year|max|hourly|daily|weekly|price|prices|market|markets|ticker|tickers|quote|quotes|ohlcv?|candles?|klines?)\b/i;

  // API subdomain pattern — "api.example.com" or "io.example.com" strongly suggests data endpoint
  const API_SUBDOMAIN = /^(api|io|data|feed|stream|ws)\./i;
  const LIST_INTENT = /\b(search|list|find|trending|top|latest|discover|browse)\b/i;
  const STATUS_INTENT = /\b(status|incident|outage|maintenance|uptime|degraded)\b/i;
  const COMMS_INTENT = /\b(guilds?|channels?|messages?|dms?|servers?|threads?|chat)\b/i;
  const COMMS_PATH = /\/(guilds?|channels?|messages?|threads?|conversations?|affinities)\b/i;
  const DISCORD_META_PATHS = /\/(referrals?|promotions?|science|entitlements?|billing|subscriptions?|collectibles?|gifts?|experiments?)\b/i;
  const SESSION_BOUND_QUERY = /[?&](?:[^=]*?(crumb|csrf|xsrf|token|session|auth|signature|nonce))=\{/i;
  const COMPANY_INTENT = /\b(company|companies|organization|organisations|business|org)\b/i;
  const PROFILE_INTENT = /\b(person|people|profile|profiles|user|users|member|members)\b/i;
  const PRODUCT_DETAIL_INTENT = /\b(product|products|item|items|listing|listings)\b/i.test(intent ?? "");
  const ENTITY_DETAIL_INTENT = isEntityDetailIntent(intent);

  const scored = rankedCandidates.map((ep, i) => {
    let score = 0;
    let pathname = "";
    let hostname = "";
    let contextPath = "";
    let contextHost = "";
    let contextLeaf = "";
    let contextQueryKeys = new Set<string>();
    const semantic = resolveEndpointSemantic(ep);
    const descriptionMeta = getEndpointDescriptionMetadata({
      description: ep.description,
      semantic,
    });
    try {
      const u = new URL(ep.url_template);
      pathname = u.pathname;
      hostname = u.hostname;
    } catch { /* skip */ }
    try {
      if (contextUrl) {
        const cu = new URL(contextUrl);
        contextPath = cu.pathname;
        contextHost = cu.hostname;
        const contextSegs = cu.pathname.split("/").filter(Boolean);
        contextLeaf = contextSegs.length > 0 ? decodeURIComponent(contextSegs[contextSegs.length - 1] ?? "").toLowerCase() : "";
        contextQueryKeys = new Set([...cu.searchParams.keys()]);
      }
    } catch { /* skip */ }

    // === BM25 relevance to intent (primary signal, weighted heavily) ===
    if (queryTokens.length > 0) {
      // Floor BM25 at 0 — single-doc corpora have negative IDF that would
      // otherwise penalize legitimate matches. Use the score only as a positive
      // signal; structural penalties below handle the demotion side.
      score += Math.max(0, bm25Score(queryTokens, docs[i], avgDl, docCount, docFreqs)) * BM25_DELTA_WEIGHT;
    }

    // === Description match bonus — separate from BM25 to avoid IDF dilution ===
    // When an endpoint has a description, compute direct token overlap with RAW intent
    // (not synonym-expanded, to avoid dilution). Each matching core intent token gives a
    // massive bonus that overrides structural noise from schema richness.
    if (descriptionMeta.source === "agent" && descriptionMeta.display && rawTokens.length > 0) {
      // Split camelCase BEFORE lowercase so GraphQL op names like
      // CollectionItemsCountQuery become [collection, items, count, query]
      // instead of a single token that never matches "collection".
      // Observed on opensea.io: endpoint 'CollectionItemsCountQuery' was
      // scored -9.4 for intent 'opensea collection' because the camelCase
      // was never split into searchable tokens.
      const descTokens = new Set(
        descriptionMeta.display
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 1 && !STOPWORDS.has(w))
          .map((w) => stem(w))
      );
      // Use raw intent tokens (not expanded) — "feed" and "post" are the core signal
      const rawStems = new Set(rawTokens.map((t) => stem(t)));
      let matches = 0;
      for (const t of rawStems) {
        if (descTokens.has(t)) matches++;
      }
      // Each matching core token = +100 points. "feed" matching gives +100,
      // "feed" + "post" matching gives +200, etc.
      score += matches * AGENT_DESC_DELTA_WEIGHT;
    }

    // === URL path to intent match — catches SSR-extracted and RPC-style endpoints ===
    if (rawTokens.length > 0 && pathname) {
      const pathLower = pathname.toLowerCase();
      const pathSegs = pathLower.split("/").filter(Boolean);
      for (const token of rawTokens) {
        const stemmed = stem(token);
        if (pathSegs.some((seg) => seg === stemmed || seg === token || seg.includes(token))) {
          score += 150;
          break; // one match is enough to signal relevance
        }
      }
    }

    // === Structural bonuses ===
    if (ep.dom_extraction) score += 25;
    if (descriptionMeta.needs_review && ep.dom_extraction) score -= 140;
    if (ep.idempotency === "safe" || ep.method === "GET") score += 5;
    if (isBundleInferredEndpoint(ep) && !ep.response_schema) score -= 180;
    score += semanticIntentAdjustment(ep, intent);

    // Rich schema = likely structured data endpoint
    if (ep.response_schema) {
      score += 5;
      if (ep.response_schema.type === "array") score += 10;
      else if (ep.response_schema.type === "object" && ep.response_schema.properties) {
        const propCount = Object.keys(ep.response_schema.properties).length;
        score += Math.min(propCount * 2, 20);
      }
    }
    // Reliability ranking (boosted 2026-05-18 as commit 3 of the
    // Darwinian-marketplace clean-up). Pre-fix this added at most +10
    // for a perfect 1.0 score — often drowned by 150-point BM25 deltas.
    // Boost the high band so a well-earned endpoint actually wins the
    // shortlist over a freshly-captured neutral endpoint.
    //
    //   < 0.2  → -60 (auto-deprecation gate, push to bottom)
    //   < 0.5  → -15
    //   ≈ 0.5  (neutral prior, never observed) → small COLD-START +8 so
    //         new endpoints get tried rather than starving forever
    //   ≥ 0.5  → +reliability * 40 (was ×10; max +40 for 1.0)
    if (typeof ep.reliability_score === "number") {
      if (ep.reliability_score < 0.2) score -= 60;
      else if (ep.reliability_score < 0.5) score -= 15;
      else if (Math.abs(ep.reliability_score - 0.5) < 0.001) score += 8; // cold-start
      else score += ep.reliability_score * 40;
    }
    if (ep.verification_status === "verified") score += 15;
    else if (ep.verification_status === "failed") score -= 40;
    else if (ep.verification_status === "pending") score -= 10;
    if (ep.method === "WS" && ep.response_schema) score += 3;

    // === Domain affinity ===
    if (skillDomain) {
      try {
        if (hostname === skillDomain || hostname.endsWith(`.${skillDomain}`)) {
          score += 15;
          // Extra bonus for API subdomains on the skill domain
          if (API_SUBDOMAIN.test(hostname)) score += 15;
        } else {
          // Off-domain = almost never right
          score -= 30;
        }
      } catch { /* skip */ }
    }

    // API subdomain bonus even without skill domain context
    if (API_SUBDOMAIN.test(hostname)) score += 10;
    // Strong bonus for API subdomain + has structured response schema = confirmed data endpoint
    if (API_SUBDOMAIN.test(hostname) && ep.response_schema) score += 40;

    // Strongly penalize dedicated status/statuspage endpoints unless the user explicitly
    // asked for status/incidents/maintenance. These often hijack root-domain skills.
    if (!STATUS_INTENT.test(intent ?? "")) {
      if (/^(status|statuspage)\./i.test(hostname) || /\/(scheduled-maintenances|incidents|components|status|uptime|summary)\b/i.test(pathname)) {
        score -= 80;
      }
    }

    // === Data-relevance signals ===
    if (DATA_INDICATORS.test(ep.url_template)) score += 5;
    // REST-style resource URL bonus — /api/v*/search, /search, /products, /items, etc.
    if (/\/api\/v?\d*\/(search|products?|items?|results?|catalog|listings?|goods|feed)\b/i.test(pathname)) score += 25;
    // Intent keyword present in URL path — strong signal the endpoint serves the requested resource
    if (rawTokens.length > 0 && !intent?.match(/\b(search|find|get|list|fetch)\b/i)?.input) {
      // Already handled by URL-to-intent match above; add bonus for explicit resource nouns
    }
    if (CURRENCY_TIME_PATTERNS.test(pathname)) score += CURRENCY_TIME_DELTA_WEIGHT;
    if (intent && COMMS_INTENT.test(intent) && COMMS_PATH.test(pathname)) score += COMMS_PATH_DELTA_WEIGHT;
    if (intent && COMMS_INTENT.test(intent) && DISCORD_META_PATHS.test(pathname)) score -= 220;
    if (/\b(stock|stocks|ticker|tickers|quote|quotes)\b/i.test(intent ?? "")) {
      const quoteHaystack = `${ep.url_template} ${ep.description ?? ""} ${JSON.stringify(ep.response_schema ?? {})} ${JSON.stringify(semantic)}`.toLowerCase();
      if (/\/chart\b/i.test(pathname) && /(regularmarketprice|currentprice|previousclose|chartpreviousclose|price)/i.test(quoteHaystack)) {
        score += CHART_PRICING_DELTA_WEIGHT;
      }
      if (SESSION_BOUND_QUERY.test(ep.url_template)) {
        // Crumb/csrf-bound URLs are unusable without live session — bury hard.
        score -= 350;
      }
    }

    // Deep paths with meaningful segments = likely data endpoints
    const pathDepth = pathname.split("/").filter((s) => s.length > 0).length;
    if (pathDepth >= 3) score += 5;

    // === Context URL match — endpoint was captured from the page the user is asking about ===
    if (contextUrl && ep.trigger_url) {
      try {
        const contextPath = new URL(contextUrl).pathname;
        const triggerPath = new URL(ep.trigger_url).pathname;
        if (triggerPath === contextPath) score += 20;
      } catch { /* skip */ }
    }

    // Direct endpoint/context path match. Stronger than trigger_url because marketplace
    // skills may have stale or missing trigger_url, but url_template still reflects intent.
    if (contextPath) {
      if (pathname === contextPath) score += 45;
      else if (pathname.startsWith(contextPath) || contextPath.startsWith(pathname)) score += 20;

      const contextSegs = contextPath.split("/").filter(Boolean);
      const endpointSegs = pathname.split("/").filter(Boolean);
      if (contextSegs.length > 0 && endpointSegs.length > 0 && contextSegs[0] === endpointSegs[0]) {
        score += 12;
      }

      // Cross-entity segment mismatch: endpoint was captured for a different entity than
      // the one in the context URL (e.g. r/programming captured but user wants r/singularity).
      // Concrete literal path segments that contradict the context URL's corresponding
      // segment are a hard wrong-entity signal. Placeholder segments ({subreddit}) are skipped
      // Cross-entity penalty only fires when the endpoint and the context URL share a host
      // AND the endpoint is not a generic API root (/graphql, /api, /rest, /rpc). For
      // cross-subdomain GraphQL (e.g. gql.opensea.io vs opensea.io), positional path
      // comparison is meaningless — different services have different path conventions.
      const sameHost = contextHost !== "" && hostname === contextHost;
      const isGenericApiRoot = /^\/?(graphql|api|rest|rpc|gql)\/?$/i.test(pathname);
      if (sameHost && !isGenericApiRoot && !looksLikeApiUrl(ep.url_template)) {
        const compareLen = Math.min(contextSegs.length, endpointSegs.length);
        let concreteMismatches = 0;
        for (let si = 0; si < compareLen; si++) {
          const epSeg = endpointSegs[si];
          if (/^\{[^}]+\}$/.test(epSeg)) continue; // placeholder — no commitment
          const epDecoded = decodeURIComponent(epSeg).toLowerCase();
          const ctxDecoded = decodeURIComponent(contextSegs[si]).toLowerCase();
          if (epDecoded !== ctxDecoded) concreteMismatches++;
        }
        if (concreteMismatches > 0) score -= concreteMismatches * 180;
      }

      if (contextQueryKeys.size > 0) {
        let matchedKeys = 0;
        for (const key of contextQueryKeys) {
          if (ep.url_template.includes(`${key}=`) || ep.url_template.includes(`{${key}}`)) matchedKeys++;
        }
        score += matchedKeys * 12;
        if (matchedKeys === 0 && /\/search\b/.test(contextPath)) score -= 20;
      }
    }

    const looksLikeApiEndpoint = looksLikeApiUrl(ep.url_template);
    const looksLikeDocumentRoute = !!contextPath && pathname === contextPath && !looksLikeApiEndpoint;
    const isCapturedPageArtifact = /captured (?:search form |page )?artifact/i.test(ep.description ?? "");
    const hasStructuredApiSibling = !!ep.trigger_url && structuredApiTriggers.has(ep.trigger_url);
    const triggerPath = (() => {
      try {
        return ep.trigger_url ? new URL(ep.trigger_url).pathname : "";
      } catch {
        return "";
      }
    })();
    const exactContextDocument =
      PRODUCT_DETAIL_INTENT &&
      !!contextPath &&
      (pathname === contextPath || triggerPath === contextPath);
    const mismatchedContextDocument =
      !!contextPath &&
      (isCapturedPageArtifact || looksLikeDocumentRoute) &&
      pathname !== contextPath &&
      triggerPath !== contextPath;

    if (ENTITY_DETAIL_INTENT && looksLikeDocumentRoute && !exactContextDocument) {
      score -= 55;
    }
    if (ENTITY_DETAIL_INTENT && isCapturedPageArtifact && !exactContextDocument) {
      score -= 200;
    }
    if (ENTITY_DETAIL_INTENT && mismatchedContextDocument) {
      score -= 420;
    }
    if (intent && COMMS_INTENT.test(intent) && looksLikeDocumentRoute) {
      score -= 180;
    }
    if (intent && COMMS_INTENT.test(intent) && isCapturedPageArtifact) {
      score -= 1000;
    }

    // Generic global rule (no per-intent gating): when an endpoint is a captured
    // page artifact AND any sibling in the corpus is a real API endpoint for the
    // same domain/intent class, bury the page artifact below the API. Replaces
    // the trigger_url-based check that Phase 8.3 left brittle on test fixtures.
    //
    // EXCEPTION: for content-read intents (LIST_INTENT — search/list/find/...),
    // when the page-artifact has high-confidence DOM extraction AND an array-
    // shaped response, the page itself IS the data. The user wants product
    // listings; the XHR siblings are usually telemetry/config (e.g. Amazon's
    // patcConfig A/B-test rules) that ranked above search-results because
    // they happen to match /api/-shaped URL patterns. Promote the page-
    // artifact ABOVE structured-but-noisy XHR for these intents. Verified
    // via bench-two-phase (run 20260508T075000Z): amazon + bing + others
    // captured a doc_only synthetic + a telemetry XHR; ranker picked the
    // telemetry; agent-judged response was wrong-shape for "get amazon search".
    const looksLikeContentRead = !!intent && LIST_INTENT.test(intent);
    const pageArtifactIsDataRich =
      isCapturedPageArtifact
      && !!ep.dom_extraction
      && (ep.dom_extraction.confidence ?? 0) >= 0.8
      && !!ep.response_schema
      && ((ep.response_schema as Record<string, unknown>).type === "array"
          || (ep.response_schema as Record<string, unknown>).type === "object");
    if (isCapturedPageArtifact && !ep.dom_extraction && hasStructuredApiInCorpus) {
      score = clampToFloor(score, PAGE_ARTIFACT_DEMOTION, HARD_NEGATIVE_FLOOR);
    } else if (looksLikeContentRead && pageArtifactIsDataRich) {
      // Counter-promotion for content-read intents on data-rich page artifacts.
      // Beats the structural API demotion magnitude so the page wins.
      score += 250;
    }

    // LIST_INTENT scalar-schema demotion (lane-01 / AC2):
    // For content-read list intents, an endpoint whose response schema declares
    // ONLY scalar-typed top-level properties (count, total, number, string, bool)
    // cannot satisfy a listing intent. The user asked for items, not a count.
    // Canonical example: /search/count -> { count: number } ranking above
    // /search/repositories -> { items: array }. Generic shape signal, not a
    // per-domain registry.
    if (looksLikeContentRead && ep.response_schema && !ep.dom_extraction) {
      const schema = ep.response_schema as Record<string, unknown>;
      const props = (schema.properties && typeof schema.properties === "object")
        ? (schema.properties as Record<string, unknown>)
        : null;
      const SCALAR_TYPES = new Set(["number", "integer", "string", "boolean"]);
      if (props) {
        const propEntries = Object.values(props);
        const allScalar = propEntries.length > 0 && propEntries.every((p) => {
          if (!p || typeof p !== "object") return false;
          const t = (p as Record<string, unknown>).type;
          return typeof t === "string" && SCALAR_TYPES.has(t);
        });
        if (allScalar) {
          score -= 250;
        }
      }
    }

    // page_fetch invariant floor (see .bench-history/ROOT_FIX_GUIDE.md):
    // for content-read intents, the always-published page_fetch endpoint
    // beats telemetry XHRs but loses to a real /api/ endpoint matching
    // intent tokens. Single rule, no conditional ladders.
    if (isPageFetchEndpoint(ep) && intent && LIST_INTENT.test(intent)) {
      score = hasStructuredSearchApiInCorpus ? Math.min(score, 60) : Math.max(score, 100);
    } else if (isPageFetchEndpoint(ep) && intent && hasStructuredApiInCorpus && /\b(get|fetch|read|view|show|tags?|versions?|releases?|packages?|images?|questions?|answers?|works?|books?|profiles?|details?|info|metadata|abstract|article|articles|posts?|stats?|scores?|games?|quotes?|prices?|tickers?)\b/i.test(intent)) {
      score = Math.min(score, 60);
    }

    // Even with dom_extraction, a captured page artifact loses to an API sibling
    // that was captured from the SAME trigger_url page load. The API is the
    // ground-truth network call; the page artifact is the fallback HTML scrape.
    if (
      isCapturedPageArtifact &&
      !!ep.trigger_url &&
      rankedCandidates.some(
        (other) =>
          other !== ep &&
          other.trigger_url === ep.trigger_url &&
          looksLikeApiUrl(other.url_template) &&
          !other.dom_extraction &&
          !/captured (?:search form |page )?artifact/i.test(other.description ?? "")
      )
    ) {
      score = clampToFloor(score, PAGE_ARTIFACT_DEMOTION, HARD_NEGATIVE_FLOOR);
    }

    if (intent && COMPANY_INTENT.test(intent)) {
      const companyHaystack = `${ep.url_template} ${ep.description ?? ""} ${JSON.stringify(ep.response_schema ?? {})}`.toLowerCase();
      if (/(organization|company|companies|org)/i.test(companyHaystack) && looksLikeApiEndpoint) score += 110;
      if (/(mailbox|messaging|messagecenter|notifications?|inbox|launchpad|identity|sharebox)/i.test(companyHaystack)) score -= 140;
      if (/(organizationdashcompanies|universalname|companyprofile|organizationprofile|aboutthisprofile|organizationresult|companyresult)/i.test(companyHaystack)) score += 95;
      if (looksLikeDocumentRoute) score -= 35;
    }

    if (intent && PROFILE_INTENT.test(intent)) {
      const profileHaystack = `${ep.url_template} ${ep.description ?? ""} ${JSON.stringify(ep.response_schema ?? {})}`.toLowerCase();
      if (/(sidebar|recommend|recommendations|suggested|spotlight|timeline|tweets|following|followers)/i.test(profileHaystack)) score -= 90;
      if (/(sharebox|closedsharebox|mailbox|messaging|conversation|alerts?|notification|presence|badging|feedtype|main_feed)/i.test(profileHaystack)) score -= 180;
      if (/(userbyscreenname|profile|profiles|memberprofile|identityprofile|person)/i.test(profileHaystack) && looksLikeApiEndpoint) score += 80;
      if (/(search\/results\/people|searchcluster|searchresult|public_identifier|headline|mini_profile|memberresult)/i.test(profileHaystack)) score += 95;
    }

    if (intent && /\b(feed|timeline|stream|home)\b/i.test(intent) && /\b(post|posts|status|statuses|update|updates)\b/i.test(intent)) {
      const feedHaystack = `${ep.url_template} ${ep.description ?? ""} ${JSON.stringify(semantic)}`.toLowerCase();
      if (/(voyagerfeeddashmainfeed|voyagerfeeddashfeedupdates|mainfeed|feedupdates|main_feed)/i.test(feedHaystack)) score += 170;
      if (/(identitydashprofiles|voyageridentity|storylines|newsdashstorylines|globalnav|launchpad|mailbox|notification|presence)/i.test(feedHaystack)) score -= 150;
    }
    if (intent && /\b(search|list|find|feed|timeline|stream|home|latest|trending|discover|browse)\b/i.test(intent) && /\b(post|posts|tweet|tweets|status|statuses|update|updates)\b/i.test(intent)) {
      const contentHaystack = `${ep.url_template} ${ep.description ?? ""} ${JSON.stringify(semantic)}`.toLowerCase();
      if (looksLikeApiEndpoint && /(search|timeline|feed|stream|result|results|entries|posts|tweets|statuses|updates)/i.test(contentHaystack)) score += 180;
      if (/(sidebar|recommend|recommendations|usersbyrestids|user details|profile|profiles|followers|following|people|spotlight)/i.test(contentHaystack)) score -= 140;
      if (isCapturedPageArtifact && hasStructuredApiSibling) score -= 320;
      else if (looksLikeDocumentRoute && hasStructuredApiSibling) score -= 200;
    }
    if (intent && /\b(post|posts|article|articles)\b/i.test(intent)) {
      const articleHaystack = `${ep.url_template} ${ep.description ?? ""} ${JSON.stringify(ep.response_schema ?? {})}`.toLowerCase();
      if (looksLikeApiEndpoint && !ep.dom_extraction && /(articles?|posts?).*(title|url|published|description)|title.*(articles?|posts?)/i.test(articleHaystack)) {
        score += 180;
      }
      if (isCapturedPageArtifact && hasStructuredApiInCorpus) {
        score -= 320;
      }
      if (isCapturedPageArtifact && /(profile|profiles|avatar|follow|user details|spotlight)/i.test(articleHaystack)) {
        score -= 180;
      }
    }
    if (intent && /\b(question|answers?|work|book|scoreboard|scores?|games?|quote|stats?)\b/i.test(intent)) {
      const detailHaystack = `${ep.url_template} ${ep.description ?? ""} ${JSON.stringify(ep.response_schema ?? {})}`.toLowerCase();
      if (looksLikeApiEndpoint && !ep.dom_extraction && /(questions?|answers?|works?|books?|events?|competitions?|scores?|quote|price|stats?)/i.test(detailHaystack)) {
        score += 900;
      }
      if (isCapturedPageArtifact && hasStructuredApiInCorpus) {
        score -= 900;
      }
    }

    const requestHint = JSON.stringify(semantic.example_request ?? {}).toLowerCase();
    const endpointHint = `${ep.url_template} ${ep.description ?? ""}`.toLowerCase();
    const hasConcreteEntityRoute =
      ENTITY_DETAIL_INTENT &&
      !!contextLeaf &&
      !/^(search|explore|trending|tabs|home|for-you|foryou|latest|live|people|posts|videos)$/.test(contextLeaf);
    if (hasConcreteEntityRoute) {
      if (requestHint.includes(contextLeaf)) score += 120;
      else if (endpointHint.includes(contextLeaf)) score += 40;
      if (/(screen_name|screenname|username|userby|slug|vanity|universalname|public_identifier|identifier)/i.test(endpointHint + " " + requestHint)) score += 55;
      if (/(restids|usersbyrestids|recommendations|timeline|tweets|following|followers)/i.test(endpointHint + " " + requestHint)) score -= 70;
    }

    // Penalize fixed entity/detail pages when the user asked for a list/search flow.
    const isStaticEntityPath = /^\/[^/{?]+\/[^/{?]+$/.test(pathname);
    if (intent && LIST_INTENT.test(intent) && isStaticEntityPath) {
      score -= 35;
    }

    // Reward endpoints whose path explicitly names the list/search surface the user is on.
    if (intent && LIST_INTENT.test(intent) && /\/(search|trending|discover|explore)\b/i.test(pathname)) {
      score += 30;
    }

    // === Penalties ===
    if (META_PATHS.test(pathname)) score -= 15;
    if (DISCORD_META_PATHS.test(pathname)) score -= 35;
    if (SESSION_PLUMBING.test(pathname) || SESSION_PLUMBING.test(ep.url_template)) score -= 30;
    if (isBundleInferredEndpoint(ep) && !ep.response_schema) score -= 40;

    // === Generic ranker signals (no per-domain registries) ===
    // Heuristics are OUT, primitives + LLM judging are IN. The ranker keeps only
    // signals that derive from evidence on the endpoint itself (host, path,
    // schema, method) — never a hand-coded `if domain === "x.com"` switch.
    // Domain-specific disambiguation comes from `unbrowse rank --judge` (LLM).

    // (1) Demote developer-docs hosts when the intent looks transactional.
    //     Universal: docs.* / developers.* almost never serve runnable data.
    if (intent && /\b(quote|swap|trade|buy|sell|search|find|get|fetch|list)\b/i.test(intent)) {
      if (/^(developers?|docs?|documentation|api[-_]?docs?|reference|reference-docs?)\./i.test(hostname)) {
        score -= 200;
      }
      if (/^\/(docs?|documentation|reference|guide|guides|api-reference)(\/|$)/i.test(pathname)) {
        score -= 120;
      }
    }

    // (2) Method tiebreak when same operation appears as both GET and POST.
    //     Agnostic of platform — read intent, prefer GET for reads, POST for writes.
    if (looksLikeApiEndpoint) {
      const writeIntent = !!intent && /\b(post|create|send|publish|reply|delete|update|edit)\b/i.test(intent);
      if (ep.method === "GET" && !writeIntent) score += 0.5;
      else if (ep.method === "POST" && writeIntent) score += 0.5;
    }

    // Penalize surviving infra-like paths that couldn't be hard-filtered
    // (whitepaper/summaries, server-timestamp, fingerprint, static config pages)
    if (/\/(whitepaper|_stm|phantom|pfb|fingerprint|timesync|server[-_]?time)\b/i.test(ep.url_template)) score -= 500;
    // Penalize static document/article pages (no template params, no response_schema, not API-style)
    // These look like navigation pages that happen to match keywords in their path segment
    const hasTemplateParams = /\{[^}]+\}/.test(ep.url_template);
    if (!hasTemplateParams && !ep.response_schema && !ep.dom_extraction && !looksLikeApiEndpoint) score -= 60;
    // Penalize privacy/consent endpoints that slip through AUTH_CONFIG_PATHS
    if (/privacy|consent/i.test(pathname) && !ep.response_schema) score -= 50;

    // Penalize root/short paths (homepage, config, init)
    if (pathname.length <= 2) score -= 10;

    // Penalize POST endpoints that aren't explicitly API calls (likely tracking/events)
    if (ep.method === "POST" && !DATA_INDICATORS.test(ep.url_template) && !ep.response_schema) {
      score -= 15;
    }

    if (intent && COMMS_INTENT.test(intent) && isCapturedPageArtifact) {
      score = clampToFloor(score, 0, WEAK_NEGATIVE_FLOOR);
    }
    if (descriptionMeta.needs_review && isCapturedPageArtifact) {
      score -= 120;
    }

    // === Semantic param alignment (A1 fix) ===
    // When the agent provides params and the endpoint has template slots ({param}),
    // check if the param value semantically belongs to this endpoint.
    // This prevents wrong-template matches (e.g., r/singularity matching r/programming).
    if (params && Object.keys(params).length > 0) {
      const urlParams = extractUrlParams(ep.url_template);
      const schemaParams = extractSchemaParams(ep.response_schema);
      const allTemplateParams = [...new Set([...urlParams, ...schemaParams])];

      for (const [paramName, paramVal] of Object.entries(params)) {
        if (paramVal == null || paramVal === "") continue;
        const valStr = String(paramVal);

        if (allTemplateParams.includes(paramName)) {
          // The param name matches a template slot — give baseline bonus
          score += 15;

          // Strong signal: the param VALUE appears in the URL template, description, or response_schema
          // This confirms it's THE right slot, not just a same-shaped slot from a different capture
          const haystack = [ep.url_template, ep.description ?? "", JSON.stringify(ep.response_schema ?? "")].join(" ").toLowerCase();
          if (haystack.includes(valStr.toLowerCase())) {
            score += 80;
          }

          // Cross-check: when the param NAME (not value) is also a property in the
          // response_schema, the endpoint demonstrably returns data keyed by this
          // param. Strong signal that this is the right endpoint.
          if (urlParams.includes(paramName) && ep.response_schema && typeof ep.response_schema === "object") {
            const schemaParamSet = new Set(extractSchemaParams(ep.response_schema).map((p) => p.toLowerCase()));
            if (schemaParamSet.has(paramName.toLowerCase())) {
              score += 100; // schema cross-check bonus (param echoed in response shape)
            }
          }
        } else {
          // Param doesn't match any template slot — possible extra context, small bonus
          score += 3;
        }
      }

      // Bonus: same-template endpoints where MORE params are fillable rank higher
      // (more user intent alignment = more likely correct endpoint)
      if (allTemplateParams.length > 0) {
        const filled = Object.entries(params).filter(([k, v]) =>
          v != null && v !== "" && allTemplateParams.includes(k)
        ).length;
        const fillRatio = filled / Math.max(allTemplateParams.length, 1);
        score += Math.round(fillRatio * 20);
      }
    }

    // === A1 fix: leaked-literal path-segment penalty ===
    // If a captured endpoint has a non-templated path segment that doesn't
    // appear in the user's intent OR the contextUrl, it almost certainly
    // came from a different capture session and shouldn't apply here.
    // Real-world friction caught via harness/recursive/ on reddit.com:
    // querying r/singularity surfaced a captured r/programming endpoint
    // with rich data (because it was previously executed) — wrong
    // subreddit. Universal rule: literal segments must be sourced from
    // intent, contextUrl, or be a domain-shared component.
    {
      let pathSegs: string[] = [];
      try {
        // Decode URL-encoded template slots like %7Bsymbol%7D back to {symbol}
        pathSegs = new URL(ep.url_template).pathname
          .split("/")
          .filter(Boolean)
          .map((seg) => {
            try { return decodeURIComponent(seg); } catch { return seg; }
          });
      } catch { /* noop */ }
      const intentLower = (intent ?? "").toLowerCase();
      let ctxLower = "";
      try { ctxLower = (contextUrl ? new URL(contextUrl).pathname : "").toLowerCase(); } catch { /* noop */ }
      // Generic noise tokens that legitimately appear in many APIs and shouldn't trigger the penalty
      const SHARED_PATH_TOKENS = new Set([
        "api", "v1", "v2", "v3", "graphql", "rest", "rpc", "data", "json", "xml",
        "search", "list", "get", "post", "fetch", "query", "users", "user",
        "items", "item", "posts", "post", "articles", "article", "feed", "home", "hot", "top", "new", "best", "rising",
        "page", "pages", "feeds", "details", "detail", "info", "profile", "profiles",
        "me", "self", "public", "private", "draft", "drafts", "comments", "comment",
        "web", "mobile", "desktop", "main", "index", "edge", "next", "static",
      ]);
      let leakedLiterals = 0;
      for (const seg of pathSegs) {
        const segLower = seg.toLowerCase();
        // Skip templated `{param}` slots
        if (/^\{[^}]+\}$/.test(seg)) continue;
        // Skip extensions / very short / numeric-only / opaque IDs
        if (segLower.length < 3) continue;
        if (/^\d+$/.test(segLower)) continue;
        if (/^[0-9a-f]{16,}$/i.test(segLower)) continue;
        if (segLower.startsWith(".")) continue;
        // Skip generic API shared tokens
        if (SHARED_PATH_TOKENS.has(segLower)) continue;
        // Stripped of trailing extensions like .json
        const segStem = segLower.replace(/\.[a-z0-9]+$/i, "");
        if (segStem.length < 3) continue;
        // Sourced from intent or context — fine
        if (intentLower.includes(segStem)) continue;
        if (ctxLower.includes(segStem)) continue;
        // Not in intent or contextUrl: leaked literal
        leakedLiterals += 1;
      }
      if (leakedLiterals > 0) {
        // Heavy penalty per leaked literal so a wrong-subreddit / wrong-user /
        // wrong-product endpoint can't outrank a legit one even if it has
        // richer captured schema.
        // A1.1: when ≥3 distinct leaked literals exist, apply quadratic so a
        // truly off-target capture (ebay /nap/napkinapi/v1/ticketing/redeem
        // for an "ebay search listings" intent) gets buried regardless of
        // its base bonuses.
        // A1.3: when the endpoint is a real API (path or host), the "leaked"
        // segments are API structure (v8/finance/chart), not user-data leaks.
        // Use 1/4 weight so a legit yahoo /v8/finance/chart isn't wiped out.
        const isApiEndpoint =
          ep.verification_status === "verified" &&
          (looksLikeApiUrl(ep.url_template) ||
            /^(api|gql|graphql|rest|registry|services?|backend|query\d*|edge|cdn|static)\./i.test(hostname));
        const apiSoftening = isApiEndpoint ? 0.25 : 1;
        const penaltyMultiplier = leakedLiterals >= 3 ? leakedLiterals * 2 : 1;
        score -= leakedLiterals * 200 * penaltyMultiplier * apiSoftening;
      }
    }

    // A10/A12 — cross-subdomain + cross-brand skill leak. When contextUrl is
    // provided AND the endpoint hostname differs, demote. A10 (same brand,
    // different subdomain — e.g. music.youtube.com endpoint for
    // www.youtube.com query): -300. A12 (different registrable domain
    // entirely — e.g. notion.com skill returned for notion.so query): -800.
    // Allow common shared-API subdomains (api.*, gql.*, etc.) since those
    // legitimately serve any www. page.
    if (contextUrl) {
      try {
        const ctxHost = new URL(contextUrl).hostname.toLowerCase();
        const epHost = new URL(ep.url_template).hostname.toLowerCase();
        if (ctxHost !== epHost) {
          const ctxBare = ctxHost.replace(/^www\./, "");
          const epBare = epHost.replace(/^www\./, "");
          if (ctxBare !== epBare) {
            const epIsSharedApi =
              /^(api|gql|graphql|rest|registry|services?|backend|query\d*|edge|cdn|static)\./i.test(epHost) ||
              looksLikeApiUrl(ep.url_template);
            const ctxRegistrable = ctxBare.split(".").slice(-2).join(".");
            const epRegistrable = epBare.split(".").slice(-2).join(".");
            if (ctxRegistrable !== epRegistrable) {
              // A12 — different registrable domain (e.g., notion.so query vs
              // notion.com / api.foreign.com endpoint). Bury regardless of
              // shared-API status; api.* on a foreign brand is still foreign.
              score -= 800;
            } else if (!epIsSharedApi) {
              // A10 — same brand, different subdomain, NOT a shared-API host.
              // music.youtube.com endpoint for www.youtube.com query.
              score -= 300;
            }
          }
        }
      } catch { /* skip */ }

      // A1.2 — contextUrl path-segment overlap bonus. When a captured
      // endpoint URL contains a path segment that's also in the user's
      // contextUrl pathname, that's a strong signal it's the right
      // endpoint for THIS query. Real-world friction: stripe.com/pricing
      // query returned stripe.com/en-sg/notifications as #1 because the
      // notifications endpoint had richer captured schema. Now: pricing
      // segment in contextUrl + pricing segment in endpoint URL → +200,
      // pushing the right one to top.
      try {
        const ctxPath = new URL(contextUrl).pathname;
        const ctxSegs = new Set(
          ctxPath.split("/").filter(Boolean)
            .map((s) => s.toLowerCase().replace(/\.[a-z0-9]+$/i, ""))
            .filter((s) => s.length >= 3),
        );
        const epPath2 = new URL(ep.url_template).pathname.toLowerCase();
        const epSegs = epPath2.split("/").filter(Boolean).map((s) => s.replace(/\.[a-z0-9]+$/i, ""));
        const overlapSegs = epSegs.filter((s) => ctxSegs.has(s) && s.length >= 3);
        if (overlapSegs.length > 0) {
          score += 200 * overlapSegs.length;
        }
      } catch { /* skip */ }
    }


    // A13 — read-intent demotes write-flavored endpoints. When the user's
    // intent contains search/list/find/browse/get-flavored verbs but the
    // endpoint URL or method indicates a write/mutation (cart/add/checkout/
    // buy/order/create/update/delete/POST mutation), the endpoint is wrong
    // for the intent regardless of how rich its captured schema is.
    // Real-world friction: amazon "usb-c cable" search returned
    // /cart/add-to-cart/patc-template as #1 because the cart endpoint had
    // richer schema than the search results page.
    if (intent) {
      const intentLower2 = intent.toLowerCase();
      const isReadIntent =
        /\b(search|find|list|browse|get|fetch|read|view|show|display|trending|popular|latest|results|results)\b/i.test(intentLower2) &&
        !/\b(create|add|buy|order|checkout|book|reserve|send|post|publish|delete|update|edit|modify|remove)\b/i.test(intentLower2);
      if (isReadIntent) {
        const epPathLower = (() => {
          try { return new URL(ep.url_template).pathname.toLowerCase(); }
          catch { return ep.url_template.toLowerCase(); }
        })();
        const epActionKind = (ep.semantic?.action_kind ?? "").toLowerCase();
        // URL-path tokens that signal write/mutation — strong demotion
        const WRITE_PATH = /\/(cart|checkout|order|orders|buy|purchase|payment|payments|book|booking|reserve|signup|register|subscribe|delete|remove|update|edit|modify|add[-_]to[-_]?cart|add[-_]to[-_]?wishlist|favorite|like|unlike|follow|unfollow|vote|report|flag|abuse)\b/i;
        if (WRITE_PATH.test(epPathLower)) {
          score -= 400;
        }
        // action_kind from semantic: create/update/delete/send → demote
        if (/^(create|update|delete|send|post|publish|reply|mutate)/i.test(epActionKind)) {
          score -= 250;
        }
        // POST without graphql / RPC hint on a read intent — penalize
        if (ep.method === "POST" && !/(graphql|rpc|search|query|fetch|list|get)/i.test(epPathLower)) {
          score -= 100;
        }
      }
    }

    if (
      isPageFetchEndpoint(ep) &&
      intent &&
      ((LIST_INTENT.test(intent) && hasStructuredSearchApiInCorpus) ||
        (hasStructuredApiInCorpus && /\b(get|fetch|read|view|show|tags?|versions?|releases?|packages?|images?|questions?|answers?|works?|books?|profiles?|details?|info|metadata|abstract|article|articles|posts?|stats?|scores?|games?|quotes?|prices?|tickers?)\b/i.test(intent)))
    ) {
      score = Math.min(score, 60);
    }

    // Loop 4 (B-023 follow-up): demote auth_walled endpoints below sibling
    // data XHRs when the intent is NOT auth-shaped. The auth_walled signal
    // is set at admission (extractEndpoints/detectAuthWalled) based on
    // response body shape — no per-domain registry. Magnitude (350) is
    // larger than the typical URL-exact-match boost (~229 observed on
    // x.com /home vs HomeTimeline -15) so the demoted SSR page sorts
    // below any sibling negative-scored XHR. When the intent itself
    // includes auth keywords (sign in / log in / signin / login / signup),
    // the demotion is suppressed — the user explicitly asked for the
    // auth page.
    if (ep.auth_walled && intent) {
      const intentIsAuthShaped = /\b(sign[\s\-_]?in|log[\s\-_]?in|sign[\s\-_]?up|signin|login|signup|auth(?:enticate)?)\b/i.test(intent);
      if (!intentIsAuthShaped) score -= 350;
    }

    return { endpoint: ep, score };
  });

  scored.sort((a, b) => b.score - a.score);
  if (plausibilityScopedIntent && scored[0] && scored[0].score < 0) return [];
  return scored;
}

function selectBestEndpoint(endpoints: EndpointDescriptor[], intent?: string, skillDomain?: string, contextUrl?: string): EndpointDescriptor {
  if (endpoints.length === 0) throw new Error("No endpoints available");
  if (endpoints.length === 1) return endpoints[0];

  const ranked = rankEndpoints(endpoints, intent, skillDomain, contextUrl);
  if (ranked.length === 0) throw new Error("All endpoints are disabled");
  return ranked[0].endpoint;
}

/** Detect if a string response is HTML rather than JSON/plaintext */
function isHtml(text: string): boolean {
  const trimmed = text.trimStart().slice(0, 200).toLowerCase();
  return trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    (trimmed.includes("<head") && trimmed.includes("<body"));
}

/**
 * Detect if HTML is an empty SPA shell that needs JS to render.
 * SPA shells have a near-empty body (just a <div id="root"> or similar)
 * with all content loaded by JavaScript bundles.
 * SSR pages have substantial text content in the body already.
 */
function isSpaShell(html: string): boolean {
  // Quick heuristic: extract body content and check if it has meaningful text
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) return true; // no body at all — treat as SPA shell
  const body = bodyMatch[1];

  // Strip script/style tags and HTML tags to get raw text
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // SPA shells have very little text — just "Loading..." or empty divs
  return text.length < 200;
}

/** Extract parameter names from a URL template: `/posts/{id}` → `["id"]`. */
function extractUrlParams(template: string): string[] {
  const matches = template.match(/\{([^}]+)\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

/** Extract parameter names from a response schema's shape info. */
function extractSchemaParams(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const obj = schema as Record<string, unknown>;
  const params: string[] = [];
  // response_schema can have `properties`, `required`, `items` nested structures
  const properties = obj.properties;
  if (properties && typeof properties === "object") {
    for (const key of Object.keys(properties as Record<string, unknown>)) {
      params.push(key);
    }
  }
  // Also check `required` array
  const required = obj.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string") params.push(key);
    }
  }
  return params;
}
