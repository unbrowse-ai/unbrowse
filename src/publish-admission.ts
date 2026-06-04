import { getRegistrableDomain } from "./domain.js";
import type { EndpointDescriptor, SkillManifest } from "./types/index.js";

export type PublishAdmissionReason =
  | "ws"
  | "non_actionable_method"
  | "verification_failed"
  | "low_reliability"
  | "off_domain"
  | "noise"
  | "fragile_graphql"
  | "no_durable_signal"
  | "dom_fallback_only"
  | "phantom_endpoint"
  | "captured_error_response"
  | "family_dedup"
  | "over_limit";

export type MarketplacePublishSelection = {
  endpoints: EndpointDescriptor[];
  stats: {
    total: number;
    kept: number;
    by_reason: Record<PublishAdmissionReason, number>;
  };
};

export type MarketplacePublishClosure = MarketplacePublishSelection & {
  root_endpoints: EndpointDescriptor[];
  root_endpoint_ids: string[];
  closure_endpoint_ids: string[];
  closure_operation_ids: string[];
  closure_edge_count: number;
};

type PublishSelectionOptions = {
  limit?: number;
};

type ScoredCandidate = {
  endpoint: EndpointDescriptor;
  familyKey: string;
  score: number;
};

const DEFAULT_PUBLISH_ENDPOINT_LIMIT = readPositiveIntEnv("UNBROWSE_PUBLISH_ENDPOINT_LIMIT", 12);
const MIN_PUBLISH_RELIABILITY = readProbabilityEnv("UNBROWSE_PUBLISH_MIN_RELIABILITY", 0.2);
const CLOSURE_EDGE_KINDS = new Set(["dependency", "auth", "parent_child", "pagination"]);

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readProbabilityEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
function freshReasonCounts(): Record<PublishAdmissionReason, number> {
  return {
    ws: 0,
    non_actionable_method: 0,
    verification_failed: 0,
    low_reliability: 0,
    off_domain: 0,
    noise: 0,
    fragile_graphql: 0,
    no_durable_signal: 0,
    dom_fallback_only: 0,
    phantom_endpoint: 0,
    captured_error_response: 0,
    family_dedup: 0,
    over_limit: 0,
  };
}

function isApiLikePath(pathname: string): boolean {
  return /\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(pathname);
}

function looksOpaqueIdentifier(value: string): boolean {
  if (!value || /^\{[^}]+\}$/.test(value)) return false;
  if (/^[0-9a-f]{12,}$/i.test(value)) return true;
  if (value.length < 16) return false;
  const hasAlpha = /[A-Za-z]/.test(value);
  const hasDigit = /\d/.test(value);
  return hasAlpha && hasDigit;
}

function isCanonicalDocumentReplay(endpoint: EndpointDescriptor): boolean {
  // SPA-sourced data (Next.js __NEXT_DATA__, Nuxt __NUXT__, Redux
  // __INITIAL_STATE__, etc.) is NOT a dom-fallback page artifact even when
  // url_template matches the trigger URL — it's the real SSR payload the
  // server shipped to hydrate the page, equivalent to calling the
  // framework's internal data API. Treat it as a durable real endpoint.
  const extractionMethod = endpoint.dom_extraction?.extraction_method ?? "";
  if (extractionMethod.startsWith("spa-")) return false;
  if (/captured page artifact/i.test(endpoint.description ?? "")) return true;
  if (!endpoint.trigger_url) return false;
  try {
    const endpointUrl = new URL(endpoint.url_template);
    const triggerUrl = new URL(endpoint.trigger_url);
    return (
      endpointUrl.origin === triggerUrl.origin &&
      endpointUrl.pathname === triggerUrl.pathname &&
      !isApiLikePath(endpointUrl.pathname)
    );
  } catch {
    return false;
  }
}

function hasRichSemanticEvidence(endpoint: EndpointDescriptor): boolean {
  return !!(
    endpoint.semantic?.example_response_compact ||
    endpoint.semantic?.response_summary ||
    (endpoint.semantic?.example_fields?.length ?? 0) > 0
  );
}

function hasDurableSignal(endpoint: EndpointDescriptor): boolean {
  return !!(
    endpoint.response_schema ||
    endpoint.dom_extraction ||
    endpoint.search_form ||
    hasRichSemanticEvidence(endpoint) ||
    isCanonicalDocumentReplay(endpoint)
  );
}

function isVerifiedDurable(endpoint: EndpointDescriptor): boolean {
  return (
    endpoint.verification_status === "verified" &&
    endpoint.reliability_score >= 0.9 &&
    !!endpoint.response_schema
  );
}

function isSkillDomainEndpoint(skill: SkillManifest, endpoint: EndpointDescriptor): boolean {
  try {
    const endpointHost = new URL(endpoint.url_template).hostname;
    const skillDomain = getRegistrableDomain(skill.domain);
    const endpointDomain = getRegistrableDomain(endpointHost);
    return endpointDomain === skillDomain;
  } catch {
    return false;
  }
}

function isLikelyNoiseEndpoint(endpoint: EndpointDescriptor): boolean {
  const haystack = [endpoint.url_template, endpoint.description ?? ""].join(" ").toLowerCase();
  // A9/A11 fix — telemetry/event endpoints with `_` separator weren't matching
  // \blog\b because `_` is a word character in regex. A11 broadened to catch
  // app_open_times/upload (tiktok), global-footer/graphql (chrome), eligibility
  // checks (feature gates).
  return (
    /(recaptcha|captcha|csrf|telemetry|analytics|tracking|logging|metrics|beacon|consent|cookie[-_ ]?banner|feature[-_ ]?flag|oauth|session[-_/ ]?refresh|auth[-_/ ]?refresh|header-action|badge)/i.test(haystack) ||
    /\/(log[-_]?events?|track[-_]?events?|click[-_]?events?|page[-_]?views?|impressions?|user[-_]?actions?|client[-_]?logs?|error[-_]?logs?|stats[-_]?events?)\b/i.test(haystack) ||
    /\/(app[-_]?open[-_]?times?|app[-_]?launch[-_]?times?|session[-_]?times?|usage[-_]?stats?)\b/i.test(haystack) ||
    /\/(eligibility|feature[-_]?gates?|feature[-_]?config|ab[-_]?tests?|experiments?[-_]?state)\b/i.test(haystack) ||
    /\/(global[-_]?footer|global[-_]?header|page[-_]?chrome|nav[-_]?config|footer[-_]?config|header[-_]?config)\b/i.test(haystack)
  );
}
function isFragileGraphqlEndpoint(endpoint: EndpointDescriptor): boolean {
  try {
    const url = new URL(endpoint.url_template);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const isGraphLike = pathSegments.some((segment) => /graphql|voyager/i.test(segment));
    if (!isGraphLike) return false;

    const queryId = url.searchParams.get("queryId") ?? "";
    if (queryId) {
      const parts = queryId.split(/[.:]/g).filter(Boolean);
      if (parts.some(looksOpaqueIdentifier)) return true;
    }

    const opaqueGraphSegment = pathSegments.some((segment, index) => {
      if (!/graphql|voyager/i.test(pathSegments[index - 1] ?? "")) return false;
      return looksOpaqueIdentifier(segment);
    });
    if (opaqueGraphSegment) return true;

    return pathSegments.some((segment) => looksOpaqueIdentifier(segment) && /graphql|voyager/i.test(url.pathname));
  } catch {
    return /queryId=/i.test(endpoint.url_template) && /graphql|voyager/i.test(endpoint.url_template);
  }
}

/**
 * G1 phantom-endpoint hallucination detector (issue class added 2026-04-30
 * after lawnet.sg returned a fabricated "search" operation built from
 * homepage marketing copy).
 *
 * Tells (must satisfy ALL):
 *   - DOM-extracted (dom_extraction set) — not from network observation
 *   - URL is the homepage trigger replay (canonical document, non-API path)
 *   - No required user-supplied params (the "operation" takes no inputs)
 *   - No array-of-items shape in response schema or example_fields
 *     (real list/search endpoints have results[]/items[] etc.; phantom
 *     ones have only scalar fields parsed from page chrome)
 *
 * Result of admitting these into the marketplace: agents see `success:true`
 * reports on a homepage and report phantom victories. See judge.md G1
 * patch-hint anchor.
 */
function isPhantomDocumentEndpoint(endpoint: EndpointDescriptor): boolean {
  if (!endpoint.dom_extraction) return false;
  if (!isCanonicalDocumentReplay(endpoint)) return false;

  const requires = endpoint.semantic?.requires ?? [];
  const hasUserParams = requires.some(
    (r) => r.required && r.semantic_type !== "page-context",
  );
  if (hasUserParams) return false; // legit input-driven endpoint

  // Real list/search/feed pages have an array-of-items shape.
  const schema = endpoint.response_schema as Record<string, unknown> | undefined;
  if (schema && typeof schema === "object") {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    for (const val of Object.values(properties)) {
      const propType = (val as Record<string, unknown> | undefined)?.type;
      if (propType === "array") return false;
    }
    if ((schema.type as string | undefined) === "array") return false;
  }

  const exampleFields = endpoint.semantic?.example_fields ?? [];
  if (exampleFields.some((f) => typeof f === "string" && /\[\]/.test(f))) return false;

  return true;
}

/**
 * Captured-error-response detector. Real-world friction caught via
 * harness/recursive/ on instagram.com (2026-04-30): the resolve shortlist
 * surfaced 10 endpoints, several of which were captured 4xx/error responses
 * (`{message:"useragent mismatch", status:"fail"}`,
 *  `{errors:[{severity:"CRITICAL"}], status:"fail"}`). These shouldn't reach
 * the marketplace because the captured "successful response" is actually
 * the API's error envelope — the schema is the error shape, not the data.
 *
 * Tells (must satisfy ALL):
 *   - The example_response_compact has a top-level `status` of "fail" or "error",
 *     OR a top-level `errors` array with at least one element,
 *     OR a top-level `error` truthy field
 *   - AND the response_schema's top-level properties are a subset of typical
 *     error envelopes (no real content fields like results/items/data/<resource>).
 *
 * This is structural (universal across domains): no per-site rules.
 */
function isCapturedErrorResponse(endpoint: EndpointDescriptor): boolean {
  const example = endpoint.semantic?.example_response_compact as Record<string, unknown> | undefined;
  if (!example || typeof example !== "object" || Array.isArray(example)) return false;

  const status = String(example.status ?? "").toLowerCase();
  const hasFailStatus = status === "fail" || status === "error" || status === "failed";
  const errors = example.errors;
  const hasErrorsArray = Array.isArray(errors) && errors.length > 0;
  const hasErrorField = example.error !== undefined && example.error !== null && example.error !== "";
  if (!hasFailStatus && !hasErrorsArray && !hasErrorField) return false;

  // Confirm the schema is error-shaped, not a legit body that happens to
  // include a status field. Legit data endpoints have content fields beyond
  // {message,status,errors,error,code,severity}.
  const schema = endpoint.response_schema as Record<string, unknown> | undefined;
  const errorOnlyKeys = new Set(["message", "status", "error", "errors", "code", "severity", "reason", "detail", "details"]);
  if (schema && typeof schema === "object") {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const propKeys = Object.keys(properties);
    if (propKeys.length === 0) return true; // no schema content at all
    const hasContentKey = propKeys.some((k) => !errorOnlyKeys.has(k.toLowerCase()));
    if (hasContentKey) return false;
    return true;
  }

  // No schema — fall back to the example keys themselves
  const exampleKeys = Object.keys(example);
  return exampleKeys.every((k) => errorOnlyKeys.has(k.toLowerCase()));
}

function normalizedPathname(pathname: string): string {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (/^\{[^}]+\}$/.test(segment)) return "{param}";
      if (looksOpaqueIdentifier(segment)) return ":opaque";
      return segment.toLowerCase();
    })
    .join("/");
}

function endpointFamilyKey(endpoint: EndpointDescriptor): string {
  try {
    const url = new URL(endpoint.url_template);
    const queryKeys = new Set<string>();
    for (const key of url.searchParams.keys()) queryKeys.add(key);
    for (const key of Object.keys(endpoint.query ?? {})) queryKeys.add(key);
    for (const key of Object.keys(endpoint.body_params ?? {})) queryKeys.add(`body:${key}`);
    return [
      endpoint.method,
      url.hostname.toLowerCase(),
      normalizedPathname(url.pathname),
      [...queryKeys].sort().join(","),
      endpoint.dom_extraction ? "dom" : "http",
    ].join("|");
  } catch {
    return `${endpoint.method}|${endpoint.url_template.toLowerCase()}`;
  }
}

function scoreEndpoint(endpoint: EndpointDescriptor): number {
  let score = endpoint.reliability_score * 100;
  if (endpoint.verification_status === "verified") score += 30;
  if (endpoint.response_schema) score += 25;
  if (endpoint.dom_extraction) score += 8;
  if (endpoint.search_form) score += 10;
  if (endpoint.semantic?.action_kind) score += 8;
  if (endpoint.semantic?.resource_kind) score += 4;
  if (endpoint.method === "GET") score += 8;
  if (endpoint.method === "POST") score += 3;
  if (endpoint.trigger_url) score -= 6;
  if (isCanonicalDocumentReplay(endpoint)) score += 18;
  if (isFragileGraphqlEndpoint(endpoint)) score -= 25;
  if (endpoint.zk_proof) {
    score += endpoint.zk_proof.proof_type === "commitment_only" ? 3 : 5;
    if (endpoint.zk_proof.verified && endpoint.zk_proof.proof_type !== "commitment_only") score += 35;
  }
  return score;
}

function rejectionReason(skill: SkillManifest, endpoint: EndpointDescriptor): PublishAdmissionReason | null {
  if (endpoint.method === "WS") return "ws";
  if (endpoint.method === "HEAD" || endpoint.method === "OPTIONS") return "non_actionable_method";
  if (endpoint.verification_status === "failed" || endpoint.verification_status === "disabled") {
    return "verification_failed";
  }
  if (endpoint.reliability_score < MIN_PUBLISH_RELIABILITY) return "low_reliability";
  if (!isSkillDomainEndpoint(skill, endpoint)) return "off_domain";
  if (isLikelyNoiseEndpoint(endpoint)) return "noise";
  if (isFragileGraphqlEndpoint(endpoint) && !isVerifiedDurable(endpoint)) return "fragile_graphql";
  if (isPhantomDocumentEndpoint(endpoint)) return "phantom_endpoint";
  if (isCapturedErrorResponse(endpoint)) return "captured_error_response";
  if (!hasDurableSignal(endpoint)) return "no_durable_signal";
  return null;
}

export function selectMarketplacePublishEndpoints(
  skill: SkillManifest,
  options: PublishSelectionOptions = {},
): MarketplacePublishSelection {
  const reasons = freshReasonCounts();
  const candidates: ScoredCandidate[] = [];

  for (const endpoint of skill.endpoints ?? []) {
    const reason = rejectionReason(skill, endpoint);
    if (reason) {
      reasons[reason] += 1;
      continue;
    }
    candidates.push({
      endpoint,
      familyKey: endpointFamilyKey(endpoint),
      score: scoreEndpoint(endpoint),
    });
  }

  // Harness-harness rubric fix: never publish a skill whose only admitted
  // endpoints are dom-fallback page artifacts. Caching a synthetic
  // "return the HTML page" endpoint poisons resolve — future lookups get
  // a cache hit on a fake endpoint and the real API never gets discovered.
  // If there's a mix, drop the page artifacts and keep the real ones.
  const hasRealEndpoint = candidates.some((c) => !isCanonicalDocumentReplay(c.endpoint));
  if (!hasRealEndpoint) {
    reasons.dom_fallback_only += candidates.length;
    return {
      endpoints: [],
      stats: {
        total: skill.endpoints?.length ?? 0,
        kept: 0,
        by_reason: reasons,
      },
    };
  }
  const filteredCandidates = candidates.filter((c) => {
    if (isCanonicalDocumentReplay(c.endpoint)) {
      reasons.dom_fallback_only += 1;
      return false;
    }
    return true;
  });
  candidates.length = 0;
  candidates.push(...filteredCandidates);

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.endpoint.endpoint_id.localeCompare(b.endpoint.endpoint_id);
  });

  const selected: ScoredCandidate[] = [];
  const seenFamilies = new Set<string>();
  for (const candidate of candidates) {
    if (seenFamilies.has(candidate.familyKey)) {
      reasons.family_dedup += 1;
      continue;
    }
    seenFamilies.add(candidate.familyKey);
    selected.push(candidate);
  }

  const limit = options.limit ?? DEFAULT_PUBLISH_ENDPOINT_LIMIT;
  if (selected.length > limit) {
    reasons.over_limit += selected.length - limit;
  }

  const endpoints = selected.slice(0, limit).map((candidate) => candidate.endpoint);
  return {
    endpoints,
    stats: {
      total: skill.endpoints?.length ?? 0,
      kept: endpoints.length,
      by_reason: reasons,
    },
  };
}

export function selectMarketplacePublishClosure(
  skill: SkillManifest,
  options: PublishSelectionOptions = {},
): MarketplacePublishClosure {
  const roots = selectMarketplacePublishEndpoints(skill, options);
  const rootEndpointIds = roots.endpoints.map((endpoint) => endpoint.endpoint_id);

  if (rootEndpointIds.length === 0) {
    return {
      ...roots,
      root_endpoints: roots.endpoints,
      root_endpoint_ids: [],
      closure_endpoint_ids: [],
      closure_operation_ids: [],
      closure_edge_count: 0,
    };
  }

  const graph = skill.operation_graph;
  if (!graph?.operations?.length || !graph.edges?.length) {
    return {
      ...roots,
      root_endpoints: roots.endpoints,
      root_endpoint_ids: rootEndpointIds,
      closure_endpoint_ids: rootEndpointIds,
      closure_operation_ids: rootEndpointIds,
      closure_edge_count: 0,
    };
  }

  const endpointById = new Map(skill.endpoints.map((endpoint) => [endpoint.endpoint_id, endpoint]));
  const operationById = new Map(graph.operations.map((operation) => [operation.operation_id, operation]));
  const operationByEndpointId = new Map(graph.operations.map((operation) => [operation.endpoint_id, operation]));
  const adjacency = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    if (!CLOSURE_EDGE_KINDS.has(edge.kind)) continue;
    const fromSet = adjacency.get(edge.from_operation_id) ?? new Set<string>();
    fromSet.add(edge.to_operation_id);
    adjacency.set(edge.from_operation_id, fromSet);
    const toSet = adjacency.get(edge.to_operation_id) ?? new Set<string>();
    toSet.add(edge.from_operation_id);
    adjacency.set(edge.to_operation_id, toSet);
  }

  const seenOperationIds = new Set<string>();
  const queue: string[] = [];
  for (const endpointId of rootEndpointIds) {
    const operationId = operationByEndpointId.get(endpointId)?.operation_id ?? endpointId;
    if (seenOperationIds.has(operationId)) continue;
    seenOperationIds.add(operationId);
    queue.push(operationId);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const neighborId of adjacency.get(current) ?? []) {
      if (seenOperationIds.has(neighborId)) continue;
      const neighborOperation = operationById.get(neighborId);
      if (!neighborOperation) continue;
      const neighborEndpoint = endpointById.get(neighborOperation.endpoint_id);
      if (!neighborEndpoint) continue;
      if (rejectionReason(skill, neighborEndpoint)) continue;
      seenOperationIds.add(neighborId);
      queue.push(neighborId);
    }
  }

  const includedEndpointIds = new Set<string>(rootEndpointIds);
  for (const operationId of seenOperationIds) {
    const operation = operationById.get(operationId);
    if (!operation) continue;
    includedEndpointIds.add(operation.endpoint_id);
  }

  const orderedEndpoints = [
    ...roots.endpoints,
    ...skill.endpoints.filter(
      (endpoint) => includedEndpointIds.has(endpoint.endpoint_id) && !rootEndpointIds.includes(endpoint.endpoint_id),
    ),
  ];

  const closureEdgeCount = graph.edges.filter((edge) =>
    CLOSURE_EDGE_KINDS.has(edge.kind) &&
    seenOperationIds.has(edge.from_operation_id) &&
    seenOperationIds.has(edge.to_operation_id),
  ).length;

  return {
    ...roots,
    endpoints: orderedEndpoints,
    root_endpoints: roots.endpoints,
    root_endpoint_ids: rootEndpointIds,
    closure_endpoint_ids: orderedEndpoints.map((endpoint) => endpoint.endpoint_id),
    closure_operation_ids: [...seenOperationIds],
    closure_edge_count: closureEdgeCount,
  };
}

export function formatMarketplacePublishSelection(selection: MarketplacePublishSelection): string {
  const parts = Object.entries(selection.stats.by_reason)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`);
  return parts.length > 0 ? parts.join(", ") : "no drops";
}
