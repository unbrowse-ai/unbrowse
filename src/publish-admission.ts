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
  return /(recaptcha|captcha|csrf|telemetry|analytics|tracking|logging|metrics|beacon|consent|cookie[-_ ]?banner|feature[-_ ]?flag|oauth|session[-_/ ]?refresh|auth[-_/ ]?refresh|header-action|badge)/i.test(
    haystack,
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

export function formatMarketplacePublishSelection(selection: MarketplacePublishSelection): string {
  const parts = Object.entries(selection.stats.by_reason)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`);
  return parts.length > 0 ? parts.join(", ") : "no drops";
}
