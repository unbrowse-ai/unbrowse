import { executeInBrowser, triggerAndIntercept } from "../capture/index.js";
import { captureSession } from "../capture/index.js";
import { extractEndpoints, extractAuthHeaders, type ExtractionContext } from "../reverse-engineer/index.js";
import { scanBundlesForRoutes } from "../reverse-engineer/bundle-scanner.js";
import { publishSkill, mergeEndpoints } from "../marketplace/index.js";
import { updateEndpointScore } from "../marketplace/index.js";
import { getCredential, storeCredential, deleteCredential } from "../vault/index.js";
import { getStoredAuth, getAuthCookies, refreshAuthFromBrowser } from "../auth/index.js";
import { resolvePreExecutionAuth } from "../auth/dependency-runtime.js";
import { authRuntime } from "../auth/runtime.js";
import { applyProjection, inferSchema } from "../transform/index.js";
import { detectSchemaDrift } from "../transform/drift.js";
import { recordExecution, recordTransaction, cachePublishedSkill, findExistingSkillForDomain, getLocalWalletContext, updateEndpointSchema } from "../client/index.js";
import { validateManifest } from "../client/index.js";
import { withRetry, isRetryableStatus } from "./retry.js";
import type { EndpointDescriptor, ExecutionOptions, ExecutionTrace, ProjectionOptions, SkillManifest } from "../types/index.js";
import { nanoid } from "nanoid";
import { getRegistrableDomain } from "../domain.js";
import { extractFromDOM, extractFromDOMWithHint } from "../extraction/index.js";
import { buildSkillOperationGraph, inferEndpointSemantic, resolveEndpointSemantic } from "../graph/index.js";
import { augmentEndpointsWithAgent } from "../graph/agent-augment.js";
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
/** Stamp every trace with the code version hash for telemetry tracking */
function stampTrace(trace: ExecutionTrace): ExecutionTrace {
  trace.trace_version = TRACE_VERSION;
  return trace;
}

const DEFAULT_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

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
  intent: string,
  domain: string,
): Promise<EndpointDescriptor[]> {
  const normalized = endpoints.map(normalizeEndpointForManifest);
  return augmentEndpointsWithAgent(normalized, { intent, domain });
}

function intentWantsStructuredRecords(intent?: string): boolean {
  return /\b(search|list|find|get|fetch|timeline|feed|trending)\b/i.test(intent ?? "");
}

export function isBundleInferredEndpoint(endpoint: Pick<EndpointDescriptor, "description">): boolean {
  return /inferred from js bundle/i.test(endpoint.description ?? "");
}

function isSupportEvidenceEndpoint(endpoint: EndpointDescriptor): boolean {
  if (isCanonicalReplayEndpoint(endpoint)) return true;
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

function deriveStructuredDataReplay(url: string, mode: "concrete" | "template"): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    const templateParam = (primary: string): string => `{${primary}}`;

    if (host === "mastodon.social") {
      if (pathname === "/search" || pathname === "/search/") {
        if (mode === "concrete" && !parsed.searchParams.get("q")) return url;
        const replay = new URL("https://mastodon.social/api/v2/search");
        replay.searchParams.set("q", mode === "template" ? templateParam("q") : (parsed.searchParams.get("q") ?? ""));
        replay.searchParams.set("resolve", "false");
        replay.searchParams.set("type", "statuses");
        replay.searchParams.set("limit", "20");
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }
      if (pathname === "/public") {
        const replay = new URL("https://mastodon.social/api/v1/timelines/public");
        replay.searchParams.set("limit", "20");
        return replay.toString();
      }
    }

    if (host === "gitlab.com") {
      if (pathname === "/explore/projects") {
        if (mode === "concrete" && !parsed.searchParams.get("name") && !parsed.searchParams.get("search")) return url;
        const replay = new URL("https://gitlab.com/api/v4/projects");
        const search = parsed.searchParams.get("search");
        const name = parsed.searchParams.get("name");
        replay.searchParams.set(
          "search",
          mode === "template"
            ? (search && search.length > 0 ? "{search}" : name && name.length > 0 ? "{name}" : "{q}")
            : (name ?? search ?? ""),
        );
        replay.searchParams.set("simple", "true");
        replay.searchParams.set("per_page", "20");
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }

      const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      const reserved = new Set([
        "-",
        "api",
        "admin",
        "dashboard",
        "explore",
        "groups",
        "help",
        "oauth",
        "profile",
        "projects",
        "search",
        "session",
        "users",
      ]);
      if (segments.length === 2 && !reserved.has(segments[0])) {
        return `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${segments[0]}/${segments[1]}`)}`;
      }
    }

    if (host === "github.com") {
      if (pathname === "/search") {
        if (mode === "concrete" && !parsed.searchParams.get("q")) return url;
        const replay = new URL("https://api.github.com/search/repositories");
        replay.searchParams.set(
          "q",
          mode === "template" ? "{q}" : (parsed.searchParams.get("q") ?? ""),
        );
        replay.searchParams.set("per_page", "20");
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }
    }

    if (host === "hn.algolia.com") {
      if (pathname === "/" || pathname === "") {
        if (mode === "concrete" && !parsed.searchParams.get("q") && !parsed.searchParams.get("query")) return url;
        const replay = new URL("https://hn.algolia.com/api/v1/search");
        replay.searchParams.set(
          "query",
          mode === "template" ? "{q}" : (parsed.searchParams.get("q") ?? parsed.searchParams.get("query") ?? ""),
        );
        replay.searchParams.set("tags", "story");
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }
    }

    if (host === "huggingface.co") {
      if (pathname === "/models" || pathname === "/models/") {
        if (mode === "concrete" && !parsed.searchParams.get("search") && !parsed.searchParams.get("q")) return url;
        const replay = new URL("https://huggingface.co/api/models");
        replay.searchParams.set(
          "search",
          mode === "template"
            ? (parsed.searchParams.get("search") ? "{search}" : parsed.searchParams.get("q") ? "{q}" : "{search}")
            : (parsed.searchParams.get("search") ?? parsed.searchParams.get("q") ?? ""),
        );
        replay.searchParams.set("limit", "20");
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }
    }

    if (host === "developer.mozilla.org") {
      const locale = pathname.split("/").filter(Boolean)[0] || "en-US";
      if (pathname.endsWith("/search") || pathname === "/search") {
        if (mode === "concrete" && !parsed.searchParams.get("q")) return url;
        const replay = new URL("https://developer.mozilla.org/api/v1/search");
        replay.searchParams.set(
          "q",
          mode === "template" ? "{q}" : (parsed.searchParams.get("q") ?? ""),
        );
        replay.searchParams.set(
          "page",
          mode === "template"
            ? (parsed.searchParams.get("page") ? "{page}" : "1")
            : (parsed.searchParams.get("page") ?? "1"),
        );
        replay.searchParams.set("page_size", parsed.searchParams.get("page_size") ?? "20");
        replay.searchParams.set(
          "locale",
          mode === "template"
            ? (parsed.searchParams.get("locale") ? "{locale}" : locale)
            : (parsed.searchParams.get("locale") ?? locale),
        );
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }
    }

    if (host === "dev.to") {
      const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      if (segments[0] === "t" && segments[1]) {
        const replay = new URL("https://dev.to/api/articles");
        replay.searchParams.set("tag", mode === "template" ? "{tag}" : segments[1]);
        replay.searchParams.set("per_page", "20");
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }
    }

    if (host === "npmjs.com") {
      if (pathname === "/search" || pathname === "/search/") {
        if (mode === "concrete" && !parsed.searchParams.get("q")) return url;
        const replay = new URL("https://registry.npmjs.org/-/v1/search");
        replay.searchParams.set("text", mode === "template" ? templateParam("q") : (parsed.searchParams.get("q") ?? ""));
        replay.searchParams.set("size", "20");
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }

      const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      if (segments[0] === "package" && segments.length >= 2) {
        const versionIndex = segments.indexOf("v");
        const packageName = segments.slice(1, versionIndex === -1 ? undefined : versionIndex).join("/");
        if (packageName) return `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
      }
    }

    if (host === "pypi.org") {
      const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      if (segments[0] === "project" && segments[1]) {
        return `https://pypi.org/pypi/${encodeURIComponent(segments[1])}/json`;
      }
    }

    if (host === "pub.dev") {
      const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      if (segments[0] === "packages" && segments[1]) {
        return `https://pub.dev/api/packages/${encodeURIComponent(segments[1])}`;
      }
    }

    if (host === "hub.docker.com") {
      if (pathname === "/search" || pathname === "/search/") {
        if (mode === "concrete" && !parsed.searchParams.get("q") && !parsed.searchParams.get("query")) return url;
        const replay = new URL("https://hub.docker.com/v2/search/repositories/");
        replay.searchParams.set(
          "query",
          mode === "template"
            ? (parsed.searchParams.get("query") ? "{query}" : "{q}")
            : (parsed.searchParams.get("q") ?? parsed.searchParams.get("query") ?? ""),
        );
        replay.searchParams.set("page_size", "20");
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }

      const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      if (segments[0] === "r" && segments.length >= 4 && segments[3] === "tags") {
        return `https://hub.docker.com/v2/repositories/${encodeURIComponent(segments[1])}/${encodeURIComponent(segments[2])}/tags/?page_size=25`;
      }
    }

    if (host === "rubygems.org") {
      const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      if (segments[0] === "gems" && segments[1]) {
        return `https://rubygems.org/api/v1/gems/${encodeURIComponent(segments[1])}.json`;
      }
    }

    if (host === "stackoverflow.com" || host === "serverfault.com" || host === "superuser.com") {
      const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      if (segments[0] === "questions" && segments[1] === "tagged" && segments[2]) {
        const replay = new URL("https://api.stackexchange.com/2.3/questions");
        replay.searchParams.set("site", host === "stackoverflow.com" ? "stackoverflow" : host.replace(/\.com$/, ""));
        replay.searchParams.set("tagged", mode === "template" ? "{tag}" : segments[2]);
        replay.searchParams.set("order", "desc");
        replay.searchParams.set("sort", "activity");
        replay.searchParams.set("pagesize", "20");
        replay.searchParams.set("filter", "default");
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }
    }

    if (host === "jmail.world") {
      if (pathname === "/search" || pathname === "/search/") {
        if (mode === "concrete" && !parsed.searchParams.get("q")) return url;
        const replay = new URL("https://jmail.world/api/emails/search");
        replay.searchParams.set("q", mode === "template" ? "{q}" : (parsed.searchParams.get("q") ?? ""));
        replay.searchParams.set("limit", mode === "template" ? "{limit}" : (parsed.searchParams.get("limit") ?? "50"));
        replay.searchParams.set("page", mode === "template" ? "{page}" : (parsed.searchParams.get("page") ?? "1"));
        replay.searchParams.set("source", mode === "template" ? "{source}" : (parsed.searchParams.get("source") ?? "all"));
        return restoreTemplatePlaceholderEncoding(replay.toString());
      }
    }

    if (host !== "reddit.com" && host !== "old.reddit.com" && host !== "np.reddit.com") return url;
    if (/\.json$/i.test(parsed.pathname) || /\/api\/|\/svc\/|graphql/i.test(parsed.pathname)) return url;
    if (parsed.pathname === "/search" || parsed.pathname === "/search/") {
      if (mode === "concrete" && !parsed.searchParams.get("q")) return url;
      parsed.pathname = "/search.json";
      if (mode === "template" && !parsed.searchParams.get("q")) parsed.searchParams.set("q", "{q}");
      return parsed.toString();
    }
    if (parsed.pathname.startsWith("/r/") || parsed.pathname.startsWith("/comments/")) {
      parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/.json`;
      return parsed.toString();
    }
    return url;
  } catch {
    return url;
  }
}

export function deriveStructuredDataReplayUrl(url: string): string {
  return deriveStructuredDataReplay(url, "concrete");
}

export function deriveStructuredDataReplayTemplate(url: string): string {
  return deriveStructuredDataReplay(url, "template");
}

export function deriveStructuredDataReplayCandidates(url: string): string[] {
  const primary = deriveStructuredDataReplayUrl(url);
  const out = new Set<string>([primary]);
  try {
    const parsed = new URL(primary);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "reddit.com" || host === "np.reddit.com") {
      parsed.hostname = "old.reddit.com";
      out.add(parsed.toString());
    }
  } catch {
    // ignore
  }
  return [...out];
}

export function deriveStructuredDataReplayCandidatesFromInputs(
  url: string,
  params: Record<string, unknown> = {},
): string[] {
  const seeded = new Set<string>();
  const replayTemplate = deriveStructuredDataReplayTemplate(url);
  if (replayTemplate !== url) {
    const seededReplay = interpolate(
      replayTemplate,
      mergeContextTemplateParams(params, replayTemplate, url),
    );
    if (!/\{[^}]+\}/.test(seededReplay)) seeded.add(seededReplay);
  }
  for (const replayUrl of deriveStructuredDataReplayCandidates(url)) seeded.add(replayUrl);
  return [...seeded];
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
    const host = replayTarget.hostname.replace(/^www\./, "");
    const needsApiReplayHeaders =
      replayTarget.hostname !== originalTarget.hostname ||
      /\/api\/|graphql|\/rest\/|\/rpc\/|\/v\d+\//i.test(replayTarget.pathname);
    if (needsApiReplayHeaders) {
      headers["user-agent"] ??= DEFAULT_BROWSER_UA;
      headers["accept-language"] ??= "en-US,en;q=0.9";
      headers["referer"] ??= originalTarget.toString();
      headers["accept"] ??= "application/json,text/plain,*/*";
    }
    if (host === "reddit.com" || host === "old.reddit.com" || host === "np.reddit.com") {
      headers["user-agent"] ??= DEFAULT_BROWSER_UA;
      headers["accept-language"] ??= "en-US,en;q=0.9";
      headers["referer"] ??= originalTarget.toString();
      headers["accept"] = "application/json,text/plain,*/*";
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

  const response_schema = inferSchema([extracted.data]);
  const endpoint: EndpointDescriptor = {
    endpoint_id: nanoid(),
    method: "GET",
    url_template: templatizeQueryParams(url),
    idempotency: "safe" as const,
    verification_status: "verified" as const,
    reliability_score: extracted.confidence,
    description: validSearchForm
      ? `Captured search form artifact for ${intent}`
      : `Captured page artifact for ${intent}`,
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

export function buildCanonicalDocumentEndpoint(
  url: string,
  intent: string,
  authRequired = false,
): EndpointDescriptor | undefined {
  const replayUrl = deriveStructuredDataReplayUrl(url);
  const replayTemplate = deriveStructuredDataReplayTemplate(url);
  if (replayUrl === url && replayTemplate === url) return undefined;
  const endpoint: EndpointDescriptor = {
    endpoint_id: nanoid(),
    method: "GET",
    url_template: replayTemplate !== url ? replayTemplate : replayUrl,
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    description: `Structured replay for ${intent}`,
    trigger_url: url,
  };
  endpoint.semantic = {
    ...inferEndpointSemantic(endpoint, {
      sampleRequest: buildSampleRequestFromUrl(url),
      observedAt: new Date().toISOString(),
      sampleRequestUrl: url,
    }),
    ...(authRequired ? { auth_required: true } : {}),
  };
  return endpoint;
}

export function isCanonicalReplayEndpoint(endpoint: Pick<EndpointDescriptor, "method" | "url_template" | "trigger_url">): boolean {
  if (endpoint.method !== "GET" || !endpoint.trigger_url) return false;
  try {
    const concrete = deriveStructuredDataReplayUrl(endpoint.trigger_url);
    const template = deriveStructuredDataReplayTemplate(endpoint.trigger_url);
    return endpoint.url_template === concrete || endpoint.url_template === template;
  } catch {
    return false;
  }
}

async function trySeedStructuredDocumentSkill(
  skill: SkillManifest,
  url: string,
  intent: string,
  params: Record<string, unknown>,
  targetDomain: string,
  authHeaders: Record<string, string> | undefined,
  cookies: Array<{ name: string; value: string; domain: string }> | undefined,
  usedStoredAuth: boolean,
): Promise<ExecutionResult | undefined> {
  const canonicalDocumentEndpoint = buildCanonicalDocumentEndpoint(url, intent, usedStoredAuth);
  if (!canonicalDocumentEndpoint) return undefined;

  const replayUrls = deriveStructuredDataReplayCandidatesFromInputs(url, params);
  let headers: Record<string, string> = {
    accept: "application/json,text/plain,*/*",
    ...(canonicalDocumentEndpoint.headers_template ?? {}),
    ...(authHeaders ?? {}),
  };
  if (cookies && cookies.length > 0) {
    headers.cookie = cookies.map((c) => {
      const v = c.value.startsWith('"') && c.value.endsWith('"') ? c.value.slice(1, -1) : c.value;
      return `${c.name}=${v}`;
    }).join("; ");
  }

  let data: unknown;
  let passed = false;
  for (const replayUrl of replayUrls) {
    const res = await fetch(replayUrl, {
      method: "GET",
      headers: buildStructuredReplayHeaders(url, replayUrl, headers),
      redirect: "follow",
    });
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }

    const assessment = assessIntentResult(data, intent);
    if (assessment.verdict === "pass") {
      passed = true;
      break;
    }
  }
  if (!passed) return undefined;

  const semanticSample = compactSchemaSample(data);
  canonicalDocumentEndpoint.response_schema = inferSchema([semanticSample]);
  canonicalDocumentEndpoint.semantic = {
    ...inferEndpointSemantic(canonicalDocumentEndpoint, {
      sampleResponse: semanticSample,
      sampleRequest: {
        ...buildSampleRequestFromUrl(url),
        ...params,
      },
      observedAt: new Date().toISOString(),
      sampleRequestUrl: url,
    }),
    ...(usedStoredAuth ? { auth_required: true } : {}),
  };

  const domain = getRegistrableDomain(targetDomain);
  const existingSkill = findExistingSkillForDomain(domain, intent);
  const localEndpoints = await prepareLearnedEndpoints(
    existingSkill
      ? mergeEndpoints(existingSkill.endpoints, [canonicalDocumentEndpoint])
      : [canonicalDocumentEndpoint],
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
  };

  let learned: SkillManifest = localDraft;
  const validation = await validateManifest({ ...localDraft, skill_id: "__validate__" });
  if (validation.valid) {
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
  }
  try { cachePublishedSkill(learned); } catch { /* best-effort */ }

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
      seeded_from: "canonical_document",
    },
  });
  return {
    trace,
    result: trace.result,
    learned_skill: learned,
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
  if (validation.valid) {
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
  }
  try { cachePublishedSkill(learned); } catch { /* best-effort */ }

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
  const endpoint = selectBestEndpoint(skill.endpoints, options?.intent ?? skill.intent_signature, skill.domain, options?.contextUrl);
  return executeEndpoint(skill, endpoint, params, projection, options);
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
  const seeded = await trySeedStructuredDocumentSkill(
    skill,
    url,
    intent,
    params,
    targetDomain,
    authHeaders,
    cookies,
    usedStoredAuth,
  );
  if (seeded) return seeded;
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
    throw captureErr;
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

  const endpoints = extractEndpoints(captured.requests, captured.ws_messages, { pageUrl: url, finalUrl: captured.final_url, intent });

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
        endpoint_id: nanoid(),
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
    const vaultKey = `auth:${targetDomain}`;
    const hasStoredAuth = (await getCredential(vaultKey)) != null;
    if (hasStoredAuth) auth_profile_ref = vaultKey;
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

  const canonicalDocumentEndpoint = buildCanonicalDocumentEndpoint(url, intent, authBackedCapture);
  if (
    canonicalDocumentEndpoint &&
    !cleanEndpoints.some((endpoint) => endpoint.method === canonicalDocumentEndpoint.method && endpoint.url_template === canonicalDocumentEndpoint.url_template)
  ) {
    cleanEndpoints.push(canonicalDocumentEndpoint);
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

        // Only publish to marketplace if quality passes
        let learned: SkillManifest | undefined = domDraft;
        try {
          const validation = await validateManifest({ ...domDraft, skill_id: "__validate__" });
          if (validation.valid) {
            learned = await publishSkill(domDraft);
          }
        } catch { /* publish failure is non-fatal */ }
        if (learned) {
          try { cachePublishedSkill(learned, options?.client_scope); } catch { /* local cache best-effort */ }
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
        },
      };
    }

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
        },
      };
  }

  // Reuse existing skill for this domain to preserve skill_id and learned exec_strategy.
  // This prevents duplicate skills accumulating in the marketplace on re-captures.
  const existingSkill = findExistingSkillForDomain(domain, intent);
  if (existingSkill) {
    // Carry forward learned exec_strategy from old endpoints to matching new ones
    for (const ep of cleanEndpoints) {
      if (ep.exec_strategy) continue;
      // Match by URL template (endpoint_id changes on re-capture)
      const oldMatch = existingSkill.endpoints.find(
        (old) => old.url_template === ep.url_template && old.method === ep.method
      );
      if (oldMatch?.exec_strategy) {
        ep.exec_strategy = oldMatch.exec_strategy;
      }
    }
  }

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
    if (gate.status === "payment_required" || gate.status === "wallet_not_configured" || gate.status === "insufficient_balance") {
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

  // Mutation safety gate
  if (endpoint.method !== "GET" && endpoint.idempotency === "unsafe") {
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
          would_execute: { method: endpoint.method, url, body },
        },
      };
    }
    if (!options?.confirm_unsafe) {
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

  if (skill.auth_profile_ref) {
    const stored = await getCredential(skill.auth_profile_ref);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as {
          headers?: Record<string, string>;
          cookies?: typeof cookies;
        };
        Object.assign(authHeaders, parsed.headers ?? {});
        cookies.push(...(parsed.cookies ?? []));
      } catch {
        // malformed stored cred — skip
      }
    }
  }

  // Endpoint domain — used for cookie resolution, strategy caching, auth refresh
  const epDomain = (() => { try { return new URL(endpoint.url_template).hostname; } catch { return skill.domain; } })();

  // Bird-style: auto-resolve cookies from vault → browser fallback
  if (cookies.length === 0) {
    try {
      const resolved = await getAuthCookies(epDomain, {
        autoExtract: !!skill.auth_profile_ref || endpoint.semantic?.auth_required === true,
      });
      if (resolved && resolved.length > 0) {
        cookies.push(...resolved);
      }
    } catch {
      // URL parse failure — skip cookie resolution
    }
  }

  // Also check the domain-session vault for stored auth headers (authorization, api keys, etc.)
  // These are captured during browser-capture and stored alongside cookies.
  if (Object.keys(authHeaders).length === 0) {
    try {
      const sessionKey = `${getRegistrableDomain(epDomain)}-session`;
      const sessionData = await getCredential(sessionKey);
      if (sessionData) {
        const parsed = JSON.parse(sessionData) as { headers?: Record<string, string>; cookies?: typeof cookies };
        if (parsed.headers) Object.assign(authHeaders, parsed.headers);
        if (parsed.cookies && cookies.length === 0) cookies.push(...parsed.cookies);
      }
    } catch { /* skip */ }
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
      urlTemplate = restoreTemplatePlaceholderEncoding(u.toString());
    } catch {
      // URL parse failure — skip query merge
    }
  }
  let url = interpolate(urlTemplate, mergedParams);
  const body = endpoint.body ? interpolateObj(endpoint.body, mergedParams) : undefined;

  const isSafe = endpoint.method === "GET";

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
    if (isCanonicalReplayEndpoint(endpoint)) {
      try {
        for (const key of new URL(endpoint.trigger_url!).searchParams.keys()) consumedKeys.add(key);
      } catch {
        /* ignore */
      }
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


  // robots.txt compliance gate — block disallowed paths before any network call.
  if (!options?.skip_robots_check) {
    const allowed = await isAllowedByRobots(url);
    if (!allowed) {
      const traceId = nanoid();
      log("exec", `robots.txt blocked ${url}`);
      return {
        trace: stampTrace({
          trace_id: traceId,
          skill_id: skill.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: false,
          error: "robots_txt_disallowed",
        }),
        result: {
          error: "robots_txt_disallowed",
          message: `robots.txt disallows access to ${url} for the Unbrowse user-agent.`,
        },
      };
    }
  }
  const structuredReplayUrl = isSafe ? deriveStructuredDataReplayUrl(url) : url;
  const hasStructuredReplay = structuredReplayUrl !== url;

  const serverFetch = async (): Promise<{ data: unknown; status: number; trace_id: string }> => {
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
    };
    // Strip browser-only headers that cause issues server-side
    delete headers["sec-ch-ua"];
    delete headers["sec-ch-ua-mobile"];
    delete headers["sec-ch-ua-platform"];
    delete headers["upgrade-insecure-requests"];

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

    const replayUrls = hasStructuredReplay ? deriveStructuredDataReplayCandidates(structuredReplayUrl) : [structuredReplayUrl];
    let last: { data: unknown; status: number } = { data: null, status: 0 };

    for (const replayUrl of replayUrls) {
      const replayHeaders = buildStructuredReplayHeaders(url, replayUrl, headers);
      log("exec", `server-fetch: ${endpoint.method} ${replayUrl.substring(0, 80)} csrf=${replayHeaders["x-csrf-token"]?.substring(0, 10)}... cookies=${(replayHeaders["cookie"]?.length ?? 0)}chars`);
      const res = await fetch(replayUrl, {
        method: endpoint.method,
        headers: replayHeaders,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "follow",
      });
      let data: unknown;
      const text = await res.text();
      try { data = JSON.parse(text); } catch { data = text; }
      last = { data, status: res.status };
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
  const hasAuth = cookies.length > 0 || Object.keys(authHeaders).length > 0;

  if (endpoint.dom_extraction && isSafe) {
    if (hasStructuredReplay) {
      result = await serverFetch();
      if (shouldFallbackToBrowserReplay(result.data, endpoint, options?.intent ?? skill.intent_signature, options?.contextUrl)) {
        result = await executeDomExtractionEndpoint(
          endpoint,
          url,
          options?.intent ?? skill.intent_signature,
          authHeaders,
          cookies,
        );
      }
    } else {
      result = await executeDomExtractionEndpoint(
        endpoint,
        url,
        options?.intent ?? skill.intent_signature,
        authHeaders,
        cookies,
      );
    }
  } else if (hasAuth) {
    // Authed execution: learned strategy → skip doomed tiers
    //   1. Server fetch (fast — works for Twitter, simple APIs)
    //   2. Trigger-and-intercept (navigate to page, let site's JS make the call)
    //   3. Browser in-page fetch (last resort)
    let strategy: "server" | "trigger-intercept" | "browser" | undefined;

    // Endpoint-level learned strategy (strong signal — proven for this specific endpoint).
    // Domain-level prediction is only used as a tiebreaker, never to skip server-fetch entirely,
    // because different endpoints on the same domain may have different requirements.
    const endpointStrategy = endpoint.exec_strategy;

    if (hasStructuredReplay) {
      result = await serverFetch();
      if (result.status >= 200 && result.status < 400 && !shouldFallbackToBrowserReplay(result.data, endpoint, options?.intent ?? skill.intent_signature, options?.contextUrl)) {
        strategy = "server";
      } else if (endpoint.trigger_url && isSafe) {
        // Build trigger URL with agent's params applied — don't replay original captured search
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
        strategy = "trigger-intercept";
      } else {
        result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
        strategy = "browser";
      }
    } else if (endpointStrategy === "server") {
      // Proven: server-fetch works for this endpoint
      result = await serverFetch();
      if (shouldFallbackToBrowserReplay(result.data, endpoint, options?.intent ?? skill.intent_signature, options?.contextUrl)) {
        result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
        strategy = "browser";
      } else {
        strategy = "server";
      }
    } else if (endpointStrategy === "trigger-intercept" && endpoint.trigger_url && isSafe) {
      // Proven: this endpoint needs trigger-intercept
      let triggerUrl = endpoint.trigger_url;
      if (Object.keys(mergedParams).length > 0) {
        try {
          const tu = new URL(endpoint.trigger_url);
          for (const [k, v] of Object.entries(mergedParams)) {
            if (v != null && !reservedMetaParams.has(k)) tu.searchParams.set(k, String(v));
          }
          triggerUrl = tu.toString();
        } catch { /* keep original */ }
      }
      log("exec", `using learned strategy trigger-intercept via ${triggerUrl}`);
      result = await triggerAndIntercept(triggerUrl, endpoint.url_template, cookies, authHeaders);
      strategy = "trigger-intercept";
    } else if (endpointStrategy === "browser") {
      if (shouldIgnoreLearnedBrowserStrategy(endpoint, url)) {
        result = await serverFetch();
        if (result.status >= 200 && result.status < 400 && !shouldFallbackToBrowserReplay(result.data, endpoint, options?.intent ?? skill.intent_signature, options?.contextUrl)) {
          strategy = "server";
        } else {
          log("exec", `server replay rejected stale learned browser strategy for ${endpoint.endpoint_id}; falling back to browser`);
          result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
          strategy = "browser";
        }
      } else {
        log("exec", `using learned strategy browser`);
        result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
        strategy = "browser";
      }
    } else {
      // No endpoint-level strategy — always try server-fetch first (fastest path).
      // Fall back to trigger-intercept or browser if server returns 4xx.
      try {
        result = await serverFetch();
        if (result.status >= 200 && result.status < 400) {
          // For API endpoints, trust the server response — no fallback to browser
          const isApiEndpoint = /\/(api|graphql)\b/i.test(endpoint.url_template) || /\.(json)(\?|$)/.test(endpoint.url_template);
          if (!isApiEndpoint && shouldFallbackToBrowserReplay(result.data, endpoint, options?.intent ?? skill.intent_signature, options?.contextUrl)) {
            result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
            strategy = "browser";
          } else {
            strategy = "server";
          }
        } else {
          log("exec", `server fetch returned ${result.status}, falling back`);
          if (endpoint.trigger_url && isSafe) {
            let triggerUrl = endpoint.trigger_url;
            if (Object.keys(mergedParams).length > 0) {
              try {
                const tu = new URL(endpoint.trigger_url);
                for (const [k, v] of Object.entries(mergedParams)) {
                  if (v != null && !reservedMetaParams.has(k)) tu.searchParams.set(k, String(v));
                }
                triggerUrl = tu.toString();
              } catch { /* keep original */ }
            }
            result = await triggerAndIntercept(triggerUrl, endpoint.url_template, cookies, authHeaders);
            strategy = "trigger-intercept";
          } else {
            result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
            strategy = "browser";
          }
        }
      } catch {
        result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
        strategy = "browser";
      }
    }

    // Persist learned strategy at endpoint level only.
    // Domain-level cache removed: it over-generalizes (e.g., one 400 on LinkedIn
    // locked all endpoints into trigger-intercept even though server-fetch works for most).
    if (strategy && result.status >= 200 && result.status < 400 && strategy !== endpoint.exec_strategy) {
      log("exec", `learned exec_strategy=${strategy} for endpoint ${endpoint.endpoint_id}`);
      endpoint.exec_strategy = strategy;
      try { cachePublishedSkill(skill, options?.client_scope); } catch (e) { log("exec", `failed to cache strategy: ${e}`); }
    }
  } else if (isSafe) {
    // No auth: fetch-first for safe GETs — fall back to browser if SPA shell or error
    try {
      result = await withRetry(serverFetch, (r) => isRetryableStatus(r.status));
      if (typeof result.data === "string" && isHtml(result.data)) {
        if (isSpaShell(result.data)) {
          result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
        }
      }
    } catch {
      result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
    }
  } else {
    // No auth, non-GET: server fetch
    result = await serverFetch();
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

  if (!trace.success) {
    trace.error = status === 404
      ? `HTTP 404 — endpoint may be stale. Re-run via POST /v1/intent/resolve to get fresh endpoints.`
      : `HTTP ${status}`;
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
      trace.error = semanticAssessment.reason;
      data = {
        error: "intent_mismatch",
        message: `Execution result did not satisfy intent "${effectiveIntent}": ${semanticAssessment.reason}`,
        projected: semanticAssessment.projected,
      };
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

  return {
    trace, result: resultData,
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

  // Interpolate query params with URL encoding
  const interpolatedQuery = query.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] != null ? encodeURIComponent(String(params[k])) : `{${k}}`
  );

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
 * Rank endpoints by relevance to intent using BM25 + structural bonuses.
 * Exported so routes.ts can surface the ranked list to the agent.
 */
export function rankEndpoints(endpoints: EndpointDescriptor[], intent?: string, skillDomain?: string, contextUrl?: string): RankedEndpoint[] {
  // --- Hard-filter: hosts that NEVER contain useful data ---
  const NOISE_HOSTS = /(id5-sync\.com|btloader\.com|presage\.io|onetrust\.com|adsrvr\.org|googlesyndication\.com|adtrafficquality\.google|amazon-adsystem\.com|crazyegg\.com|challenges\.cloudflare\.com|google-analytics\.com|doubleclick\.net|gstatic\.com|accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|protechts\.net|demdex\.net|datadoghq\.com|fullstory\.com|launchdarkly\.com|intercom\.io|sentry\.io|segment\.io|amplitude\.com|mixpanel\.com|hotjar\.com|clarity\.ms|googletagmanager\.com|walletconnect\.com|cloudflareinsights\.com|fonts\.googleapis\.com|recaptcha|waa-pa\.|signaler-pa\.|ogads-pa\.|reddit\.com\/pixels?|pixel-config\.|dns-finder\.com|cookieconsentpub|firebase\.googleapis\.com|firebaseinstallations\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|apis\.google\.com|connect\.facebook\.net|bat\.bing\.com|static\.cloudflareinsights\.com|cdn\.mxpnl\.com|js\.hs-analytics\.net|snap\.licdn\.com|clc\.stackoverflow\.com|px\.ads|t\.co\/i|analytics\.|telemetry\.|stats\.)/i;

  // Noise URL path patterns — tracking, telemetry, logging
  const NOISE_PATHS = /\/(track|pixel|telemetry|beacon|csp-report|litms|demdex|analytics|protechts|collect|tr\/|gen_204|generate_204|log$|logging|heartbeat|metrics|consent|sodar|tag$|event$|events$|impression|pageview|click|__)/i;

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

    if (/\b(channel|channels|server|servers|guild|guilds|workspace|workspaces)\b/.test(intentLower)) {
      const hasEntitySignal = /(\/guilds\b|\/channels\b|\bguilds?\b|\bchannels?\b|\bservers?\b|\bworkspaces?\b)/i.test(haystack);
      const hasFieldSignal = /\b(ids?|names?|icon|member_count|topic|description)\b/i.test(haystack);
      const hasPositive = hasEntitySignal && hasFieldSignal;
      const hasNegative = /(affinit|preview|quests|survey|referrals?|promotions?|science|detectable|applications\/public|\/games\b|entitlements?|billing|subscriptions?|collectibles?|gifts?|experiments?|connections?|status|incidents?|scheduled-maintenances?)/i.test(haystack);
      return hasPositive && !hasNegative;
    }

    return true;
  }

  const plausibilityScopedIntent = /\b(stock|stocks|ticker|tickers|quote|quotes|product|products|item|items|channel|channels|server|servers|guild|guilds|workspace|workspaces)\b/.test(intentLower);
  const plausibleCandidates = candidates.filter((ep) => isPlausibleForIntent(ep));
  if (plausibilityScopedIntent && plausibleCandidates.length === 0) return [];
  const rankedCandidates = plausibleCandidates.length > 0 ? plausibleCandidates : candidates;
  const canonicalReplayTriggers = new Set(
    rankedCandidates
      .filter((ep) => isCanonicalReplayEndpoint(ep))
      .map((ep) => ep.trigger_url)
      .filter((value): value is string => !!value),
  );
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
      score += bm25Score(queryTokens, docs[i], avgDl, docCount, docFreqs) * 20;
    }

    // === Description match bonus — separate from BM25 to avoid IDF dilution ===
    // When an endpoint has a description, compute direct token overlap with RAW intent
    // (not synonym-expanded, to avoid dilution). Each matching core intent token gives a
    // massive bonus that overrides structural noise from schema richness.
    if (ep.description && rawTokens.length > 0) {
      const descTokens = new Set(
        ep.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
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

    // === Structural bonuses ===
    if (ep.dom_extraction) score += 25;
    if (isCanonicalReplayEndpoint(ep)) score += 160;
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
    score += ep.reliability_score * 5;
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

    // Strongly penalize dedicated status/statuspage endpoints unless the user explicitly
    // asked for status/incidents/maintenance. These often hijack root-domain skills.
    if (!STATUS_INTENT.test(intent ?? "")) {
      if (/^(status|statuspage)\./i.test(hostname) || /\/(scheduled-maintenances|incidents|components|status|uptime|summary)\b/i.test(pathname)) {
        score -= 80;
      }
    }

    // === Data-relevance signals ===
    if (DATA_INDICATORS.test(ep.url_template)) score += 5;
    if (CURRENCY_TIME_PATTERNS.test(pathname)) score += 15;
    if (intent && COMMS_INTENT.test(intent) && COMMS_PATH.test(pathname)) score += 45;
    if (intent && COMMS_INTENT.test(intent) && DISCORD_META_PATHS.test(pathname)) score -= 220;
    if (/\b(stock|stocks|ticker|tickers|quote|quotes)\b/i.test(intent ?? "")) {
      const quoteHaystack = `${ep.url_template} ${ep.description ?? ""} ${JSON.stringify(ep.response_schema ?? {})} ${JSON.stringify(semantic)}`.toLowerCase();
      if (/\/chart\b/i.test(pathname) && /(regularmarketprice|currentprice|previousclose|chartpreviousclose|price)/i.test(quoteHaystack)) {
        score += 120;
      }
      if (SESSION_BOUND_QUERY.test(ep.url_template)) {
        score -= 170;
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
    const isCapturedPageArtifact = /captured page artifact/i.test(ep.description ?? "");
    const hasCanonicalReplaySibling = !!ep.trigger_url && canonicalReplayTriggers.has(ep.trigger_url);
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

    // Penalize root/short paths (homepage, config, init)
    if (pathname.length <= 2) score -= 10;

    // Penalize POST endpoints that aren't explicitly API calls (likely tracking/events)
    if (ep.method === "POST" && !DATA_INDICATORS.test(ep.url_template) && !ep.response_schema) {
      score -= 15;
    }

    if (intent && COMMS_INTENT.test(intent) && isCapturedPageArtifact) {
      score = Math.min(score, -400);
    }
    if (hasCanonicalReplaySibling && ep.dom_extraction && !isCanonicalReplayEndpoint(ep)) {
      score -= 260;
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
