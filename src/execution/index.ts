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
import { getStoredAuth, getAuthCookies, refreshAuthFromBrowser } from "../auth/index.js";
import { authRuntime } from "../auth/runtime.js";
import { applyProjection, inferSchema } from "../transform/index.js";
import { detectSchemaDrift } from "../transform/drift.js";
import { recordExecution, recordTransaction, cachePublishedSkill, findExistingSkillForDomain, getLocalWalletContext, updateEndpointSchema } from "../client/index.js";
import { validateManifest } from "../client/index.js";
import { withRetry, isRetryableStatus } from "./retry.js";
import { probeUrl, decideFromProbe } from "./probe.js";
import type { EndpointDescriptor, ExecutionOptions, ExecutionTrace, ProjectionOptions, ProvenRecipe, ProvenRecipeResponseSignal, SkillManifest } from "../types/index.js";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";

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
import {
  writeSkillSnapshot,
  domainSkillCache,
  persistDomainCache,
  getDomainReuseKey,
  scopedCacheKey,
  buildResolveCacheKey,
  snapshotPathForCacheKey,
  generateLocalDescription,
} from "../orchestrator/index.js";
import { checkPaymentRequirement } from "../payments/index.js";
import { isAllowedByRobots } from "./robots.js";
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
/** Stamp every trace with the code version hash for telemetry tracking */
function stampTrace(trace: ExecutionTrace): ExecutionTrace {
  trace.trace_version = TRACE_VERSION;
  return trace;
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

/** Detect concatenated values like "AAPLApple" or "Inc978,583" */
function isConcatenatedValue(s: string): boolean {
  // Uppercase ticker jammed onto capitalized word: AAPLApple, NVDANvidia
  if (/[A-Z]{2,}[A-Z][a-z]/.test(s)) return true;
  // Word ending in letter immediately followed by digits: Inc978, Corp123
  if (/[a-zA-Z]\d{3,}/.test(s)) return true;
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
  return contextUrl;
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
  };
  endpoint.semantic = {
    ...inferEndpointSemantic(endpoint, {
      sampleResponse: extracted.data,
      sampleRequest: buildSampleRequestFromUrl(url),
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


async function trySeedPublicDocumentFetchSkill(
  skill: SkillManifest,
  url: string,
  intent: string,
  targetDomain: string,
  authHeaders: Record<string, string> | undefined,
  cookies: Array<{ name: string; value: string; domain: string }> | undefined,
  usedStoredAuth: boolean,
): Promise<ExecutionResult | undefined> {
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
  const localEndpoints = await prepareLearnedEndpoints(
    existingSkill
      ? mergeEndpoints(existingSkill.endpoints, [built.endpoint])
      : [built.endpoint],
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
      endpoints_discovered: 1,
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
    // Agent explicitly chose this endpoint — don't silently swap to a different one
    log("exec", `endpoint ${params.endpoint_id} not found in skill ${skill.skill_id} (${skill.endpoints.length} endpoints: ${skill.endpoints.map(e => e.endpoint_id).join(", ")})`);
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
        message: `Endpoint ${params.endpoint_id} not found in skill ${skill.skill_id}. Available: ${skill.endpoints.map(e => `${e.endpoint_id} (${e.description?.slice(0, 50)})`).join(", ")}`,
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
      const alreadyVisible = (process.env.HEADLESS ?? process.env.KURI_HEADLESS ?? "").trim().toLowerCase() === "false";
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
          const prevHeadless = process.env.HEADLESS;
          process.env.HEADLESS = "false";
          try {
            await kuri.stop();
            await kuri.start();
            captured = await captureSession(url, authHeaders, cookies, intent);
          } finally {
            if (prevHeadless === undefined) delete process.env.HEADLESS;
            else process.env.HEADLESS = prevHeadless;
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
    const blockSignals = detectBrowserBlockSignals({
      requestUrls: (captured.requests ?? []).map((r) => r.url ?? ""),
      title,
      htmlLength: html.length,
      rejectionCounts,
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

  const cleanEndpoints = endpoints.filter((ep) => {
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
  const domArtifactEndpoint = pageArtifact.endpoint;
  const domArtifactResult = pageArtifact.result;
  const inferredOnlyCapture = cleanEndpoints.length > 0 && cleanEndpoints.every((endpoint) => isBundleInferredEndpoint(endpoint));
  const hasSupportEvidence = cleanEndpoints.some((endpoint) => isSupportEvidenceEndpoint(endpoint)) || !!domArtifactEndpoint;

  if (inferredOnlyCapture && !hasSupportEvidence) {
    const trace: ExecutionTrace = stampTrace({
      trace_id: traceId,
      skill_id: skill.skill_id,
      endpoint_id: "browser-capture",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      success: false,
      error: "bundle_routes_only",
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
                `# 1. authenticate in Chrome first (cookies are auto-imported)`,
                `unbrowse go --url "${url}"  # if a Chrome session has cookies`,
                `# 2. or accept that this domain has no machine-readable surface and route the intent elsewhere`,
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
  const learnedEndpoints = domArtifactEndpoint
    ? [...cleanEndpoints, domArtifactEndpoint]
    : cleanEndpoints;
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

async function tryHttpFetch(
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

  // robots.txt: log-only, never block. Unbrowse acts as the user's browser with their cookies.
  if (!hasAuthContext) {
    const allowed = await isAllowedByRobots(url);
    if (!allowed) log("exec", `robots.txt would block ${url} (not enforced)`);
  }

  const serverFetch = async (
    extraHeaders: Record<string, string> = {},
    bodyOverride: unknown = body,
  ): Promise<{ data: unknown; status: number; trace_id: string }> => {
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
    let last: { data: unknown; status: number } = { data: null, status: 0 };

    for (const replayUrl of replayUrls) {
      const replayHeaders = buildStructuredReplayHeaders(url, replayUrl, headers);
      log("exec", `server-fetch: ${endpoint.method} ${replayUrl.substring(0, 200)} csrf-token=${(replayHeaders["csrf-token"] || "none").substring(0, 20)}... hdrs=${Object.keys(replayHeaders).length} cookies=${(replayHeaders["cookie"]?.length ?? 0)}chars`);
      const res = await fetch(replayUrl, {
        method: endpoint.method,
        headers: replayHeaders,
        body: serializeReplayBody(bodyOverride, replayHeaders),
        redirect: "follow",
      });
      let data: unknown;
      const text = await res.text();
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      const isJson = contentType.includes("application/json");
      if (isJson) {
        try { data = JSON.parse(text); } catch { data = text; }
      } else if (res.ok && endpoint.dom_extraction) {
        // HTML response + DOM extraction recipe — run the extractor in-process
        // and return the structured records the recipe was captured against.
        try {
          const { extractFromDOM } = await import("../extraction/index.js");
          const extracted = extractFromDOM(text, skill.intent_signature ?? "");
          if (extracted && extracted.data != null && (Array.isArray(extracted.data) ? extracted.data.length > 0 : true)) {
            data = extracted.data;
          } else {
            data = { _format_mismatch: true, received_content_type: contentType, data: text };
          }
        } catch (err) {
          log("exec", `dom-extraction error: ${err instanceof Error ? err.message : String(err)}`);
          data = { _format_mismatch: true, received_content_type: contentType, data: text };
        }
      } else if (res.ok && endpoint.response_schema) {
        // Expected JSON response but got non-JSON content type — mark as format mismatch
        log("exec", `content-type mismatch: expected application/json, got ${contentType} from ${replayUrl.substring(0, 100)}`);
        data = { _format_mismatch: true, received_content_type: contentType, data: text };
      } else {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      last = { data, status: res.status };

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
        return { data, status: res.status, trace_id: nanoid() };
      }
    }

    return { data: last.data, status: last.status, trace_id: nanoid() };
  };

  const browserCall = () => executeInBrowser(
    url,
    endpoint.method,
    endpoint.headers_template ?? {},
    body,
    authHeaders,
    cookies
  );

  let result: { data: unknown; status: number; trace_id: string };
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
      ...(matchVerdict.match ? {} : { reason: matchVerdict.reason ?? "unknown" }),
      ms: Date.now() - recipeStart,
    });
    if (matchVerdict.match) {
      result = recipeResult;
      recipeMatched = true;
      workflowChosenStrategy = workflowChosenStrategy ?? "recipe-replay";
    }
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
  const { status, trace_id } = result;
  let data = result.data;

  const trace: ExecutionTrace = stampTrace({
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
  } else {
    trace.result = data;
  }

  // Stale credential detection: on 401/403, attempt auth recovery before giving up.
  // Chain: authRuntime.refreshSession (lightweight) → refreshAuthFromBrowser (re-extract)
  //        → authRuntime.loginIfNeeded (full interactive login)
  if (status === 401 || status === 403) {
    let authRecovered = false;
    try {
      // 1. Lightweight session refresh via authRuntime
      const sessionRefreshed = await authRuntime.refreshSession(epDomain);
      if (sessionRefreshed) {
        log("auth", `session refreshed via authRuntime for ${epDomain} — retry should succeed`);
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
        trace.error = `${trace.error} (credentials refreshed — retry should succeed)`;
      } else {
        // No recovery path worked — delete stale credentials
        if (skill.auth_profile_ref) {
          await deleteCredential(skill.auth_profile_ref);
        }
        trace.error = `${trace.error} (stale credentials — re-authenticate via /v1/auth/login)`;
      }
    } catch {
      if (skill.auth_profile_ref) {
        await deleteCredential(skill.auth_profile_ref);
      }
      trace.error = `${trace.error} (stale credential deleted)`;
    }
  }

  // Schema drift detection on re-execution
  if (trace.success && endpoint.response_schema && data != null) {
    const drift = detectSchemaDrift(endpoint.response_schema, data);
    if (drift.drifted) {
      trace.drift = drift;
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
  const bodyLen = typeof result.data === "string"
    ? Buffer.byteLength(result.data)
    : Buffer.byteLength(JSON.stringify(result.data ?? null));
  if (signal.byte_length_min !== undefined && bodyLen < signal.byte_length_min) {
    return { match: false, reason: `body_shrunk: ${bodyLen}B < min ${signal.byte_length_min}B` };
  }
  if (signal.byte_length_max !== undefined && bodyLen > signal.byte_length_max) {
    return { match: false, reason: `body_grew: ${bodyLen}B > max ${signal.byte_length_max}B` };
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

const BM25_K1 = 1.2;
const BM25_B = 0.75;
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

function bm25Score(query: string[], doc: string[], avgDl: number, docCount: number, docFreqs: Map<string, number>): number {
  const dl = doc.length;
  const tf = new Map<string, number>();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of query) {
    const freq = tf.get(term) ?? 0;
    if (freq === 0) continue;
    // Real IDF: log((N - df + 0.5) / (df + 0.5) + 1) — terms appearing in fewer docs score higher
    const df = docFreqs.get(term) ?? 0;
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    const num = freq * (BM25_K1 + 1);
    const denom = freq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDl));
    score += idf * (num / denom);
  }
  return score;
}

export interface RankedEndpoint {
  endpoint: EndpointDescriptor;
  score: number;
}

function intentResourceKinds(intent?: string): string[] {
  const lower = (intent ?? "").toLowerCase();
  if (/\b(person|people|profile|profiles|user|users|member|members)\b/.test(lower)) return ["person", "people", "profile", "user", "member"];
  if (/\b(company|organization|org)\b/.test(lower)) return ["company", "organization", "org", "business"];
  if (/\b(post|posts|tweet|tweets|status|statuses|feed|timeline|stream|home)\b/.test(lower)) return ["post", "tweet", "status", "message", "feed", "timeline", "update"];
  if (/\b(topic|topics|trend|trending|hashtag|hashtags)\b/.test(lower)) return ["topic", "trend", "hashtag"];
  if (/\b(repo|repository|repositories)\b/.test(lower)) return ["repo", "repository", "project"];
  return [];
}

function intentActionKinds(intent?: string): string[] {
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

function semanticIntentAdjustment(endpoint: EndpointDescriptor, intent?: string): number {
  const semantic = resolveEndpointSemantic(endpoint);
  if (!semantic || !intent) return 0;
  const resourceKinds = intentResourceKinds(intent);
  const actionKinds = intentActionKinds(intent);
  let delta = 0;

  const resource = (semantic.resource_kind ?? "").toLowerCase();
  const action = (semantic.action_kind ?? "").toLowerCase();
  const negatives = new Set((semantic.negative_tags ?? []).map((tag) => tag.toLowerCase()));
  const haystack = [
    endpoint.url_template,
    endpoint.description ?? "",
    semantic.description_out ?? "",
    semantic.response_summary ?? "",
  ].join(" ").toLowerCase();
  const uiScaffold = /(sharebox|closedsharebox|mailbox|messaging|conversation|notification|notifications|alerts?|presence|badging|launchpad|previewbanner|main_feed|feedtype)/i.test(haystack);

  if (resourceKinds.length > 0) {
    if (resourceKinds.some((kind) => resource.includes(kind) || kind.includes(resource))) delta += 80;
    else if (resource) delta -= 90;
  }

  if (actionKinds.length > 0) {
    if (actionKinds.some((kind) => action.includes(kind) || kind.includes(action))) delta += 25;
    else if (action) delta -= 25;
  }

  if (negatives.has("config") || negatives.has("telemetry") || negatives.has("experiment") || negatives.has("auth")) {
    delta -= 60;
  }
  if (negatives.has("adjacent") || negatives.has("ads")) {
    delta -= 90;
  }
  if (uiScaffold && (resourceKinds.length > 0 || actionKinds.length > 0)) {
    delta -= 220;
  }

  return delta;
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
    if (/datadome|js\.datadome|dd\.datadome|_dd\.s|ddjskey/i.test(u)) vendorHits.add("datadome");
    if (/akamaihd|ak-challenge|_Incapsula|incapsula|reese84/i.test(u)) vendorHits.add("imperva_incapsula");
    // Akamai Bot Manager — used by walmart, delta, target, many retail
    // Detected via: _abck cookie usage, akam.net, bot-defender, /_bm/ paths,
    // and Akamai sensor_data collection endpoint.
    if (/akam\.net|bot-defender|\/_bm\/|sensor[-_]data|bm\.nuid|_abck/i.test(u)) vendorHits.add("akamai_bot_manager");
    if (/cf-challenge|__cf_chl_|turnstile|challenges\.cloudflare/i.test(u)) vendorHits.add("cloudflare");
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
  // --- Hard-filter: hosts that NEVER contain useful data ---
  const NOISE_HOSTS = /(id5-sync\.com|btloader\.com|presage\.io|onetrust\.com|adsrvr\.org|googlesyndication\.com|adtrafficquality\.google|amazon-adsystem\.com|crazyegg\.com|challenges\.cloudflare\.com|google-analytics\.com|doubleclick\.net|gstatic\.com|accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|protechts\.net|demdex\.net|datadoghq\.com|fullstory\.com|launchdarkly\.com|intercom\.io|sentry\.io|segment\.io|amplitude\.com|mixpanel\.com|hotjar\.com|clarity\.ms|googletagmanager\.com|walletconnect\.com|cloudflareinsights\.com|fonts\.googleapis\.com|recaptcha|waa-pa\.|signaler-pa\.|ogads-pa\.|reddit\.com\/pixels?|pixel-config\.|dns-finder\.com|cookieconsentpub|firebase\.googleapis\.com|firebaseinstallations\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|apis\.google\.com|connect\.facebook\.net|bat\.bing\.com|static\.cloudflareinsights\.com|cdn\.mxpnl\.com|js\.hs-analytics\.net|snap\.licdn\.com|clc\.stackoverflow\.com|px\.ads|t\.co\/i|analytics\.|telemetry\.|stats\.)/i;

  // Noise URL path patterns — tracking, telemetry, logging
  const NOISE_PATHS = /\/(track|pixel|telemetry|beacon|csp-report|litms|demdex|analytics|protechts|collect|tr\/|gen_204|generate_204|log$|logging|heartbeat|metrics|consent|sodar|tag$|event$|events$|impression|pageview|click|__|adx\/|\/cm\/ttc|\/pfb$|_stm$|videoads\/|prerolls|phantom\/)/i;

  // i18n / locales / static config — translation files and navigation scaffolding, never data
  const I18N_CONFIG_PATHS = /\/(i18n\/|locales\/|locale\/|translations?\/|l10n\/|lang\/[a-z]{2,5}\/|navigation\.json$|privacy[-_]compliance|privacy[-_]consent|consent[-_])/i;

  // Auth/session/config — on-domain but not data
  const AUTH_CONFIG_PATHS = /\/(csrf_meta|logged_in_user|analytics_user_data|onboarding|geolocation|auth|login|logout|register|signup|session|webConfig|config\.json|manifest\.json|robots\.txt|sitemap|favicon|opensearch|service-worker|sw\.js)\b/i;

  // Session plumbing — infrastructure endpoints no user would ever want as data.
  // Only true noise: account config, badge counts, feature flags, telemetry, DM settings.
  // NOT filtered: HomeTimeline, Bookmarks, Notifications, UserByScreenName, etc. — real data.
  const SESSION_PLUMBING = /(account\/settings|account\/multi|badge_count|DataSaverMode|permissionsState|email_phone_info|live_pipeline|user_flow|strato\/column|ces\/p2|IntercomStarter|getAltText|fleetline|FeatureHelper|VerifiedAvatar|ScheduledPromotion|DirectCall|DmSettings|PinnedTimeline)/i;

  // Static assets
  const STATIC_ASSET_PATTERNS = /\.(woff2?|ttf|eot|css|js|mjs|png|jpg|jpeg|gif|svg|ico|webp|avif|mp4|mp3|wav|riv|lottie|wasm)(\?|%3F|$)/i;

  // Animation/UI asset paths
  const UI_ASSET_PATHS = /\/(rive|lottie|animations?|sprites?|assets\/static)\//i;
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
        const looksLikeApiEndpoint = /\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(url);
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
    const looksLikeApi = /\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(url);
    return looksLikeApi && !ep.dom_extraction && !/captured (?:search form |page )?artifact/i.test(ep.description ?? "");
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
      score += Math.max(0, bm25Score(queryTokens, docs[i], avgDl, docCount, docFreqs)) * 20;
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
      score += matches * 100;
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
    score += (ep.reliability_score ?? 0) * 5;
    if (ep.verification_status === "verified") score += 15;
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
    if (CURRENCY_TIME_PATTERNS.test(pathname)) score += 15;
    if (intent && COMMS_INTENT.test(intent) && COMMS_PATH.test(pathname)) score += 45;
    if (intent && COMMS_INTENT.test(intent) && DISCORD_META_PATHS.test(pathname)) score -= 220;
    if (/\b(stock|stocks|ticker|tickers|quote|quotes)\b/i.test(intent ?? "")) {
      const quoteHaystack = `${ep.url_template} ${ep.description ?? ""} ${JSON.stringify(ep.response_schema ?? {})} ${JSON.stringify(semantic)}`.toLowerCase();
      if (/\/chart\b/i.test(pathname) && /(regularmarketprice|currentprice|previousclose|chartpreviousclose|price)/i.test(quoteHaystack)) {
        score += 120;
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

      if (contextQueryKeys.size > 0) {
        let matchedKeys = 0;
        for (const key of contextQueryKeys) {
          if (ep.url_template.includes(`${key}=`) || ep.url_template.includes(`{${key}}`)) matchedKeys++;
        }
        score += matchedKeys * 12;
        if (matchedKeys === 0 && /\/search\b/.test(contextPath)) score -= 20;
      }
    }

    const looksLikeApiEndpoint = /\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(ep.url_template);
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
    if (isCapturedPageArtifact && !ep.dom_extraction && hasStructuredApiInCorpus) {
      score = Math.min(score - 800, -2000);
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
          /\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(other.url_template) &&
          !other.dom_extraction &&
          !/captured (?:search form |page )?artifact/i.test(other.description ?? "")
      )
    ) {
      score = Math.min(score - 800, -2000);
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
      score = Math.min(score, -400);
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
        "items", "item", "posts", "post", "feed", "home", "hot", "top", "new", "best", "rising",
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
          (/\/api\/|graphql|\/rest\/|\/rpc\//i.test(ep.url_template) ||
            /^(api|gql|graphql|rest|services?|backend|query\d*|edge|cdn|static)\./i.test(hostname));
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
              /^(api|gql|graphql|rest|services?|backend|query\d*|edge|cdn|static)\./i.test(epHost) ||
              /\/api\/|graphql|\/rest\/|\/rpc\//i.test(ep.url_template);
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
