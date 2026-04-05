import { nanoid } from "nanoid";
import { readFileSync } from "node:fs";
import { log } from "../logger.js";
import { extractEndpoints, extractAuthHeaders } from "../reverse-engineer/index.js";
import { enrichEndpointsWithTokenSources } from "../reverse-engineer/token-sources.js";
import { buildSkillOperationGraph, inferEndpointSemantic } from "../graph/index.js";
import { validateExtractionQuality } from "../execution/index.js";
import { assessIntentResult } from "../intent-match.js";
import type { KuriHarEntry } from "../kuri/client.js";
import type { EndpointDescriptor, SkillManifest } from "../types/index.js";
import type { RawRequest } from "../capture/index.js";
import { cachePublishedSkill, findExistingSkillForDomain } from "../client/index.js";
import { mergeEndpoints } from "../marketplace/index.js";
import { upsertDagEdgesFromOperationGraph } from "../orchestrator/dag-feedback.js";
import { storeCredential } from "../vault/index.js";
import { getRegistrableDomain } from "../domain.js";
import {
  buildResolveCacheKey,
  domainSkillCache,
  generateLocalDescription,
  getDomainReuseKey,
  invalidateRouteCacheForDomain,
  persistDomainCache,
  scopedCacheKey,
  snapshotPathForCacheKey,
  writeSkillSnapshot,
} from "../orchestrator/index.js";

function normalizeBrowseUrl(url: string, baseUrl?: string): string {
  if (!url) return url;
  try {
    return new URL(url).toString();
  } catch {
    if (!baseUrl) return url;
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      return url;
    }
  }
}

export function harEntriesToRawRequests(entries: KuriHarEntry[], baseUrl?: string): RawRequest[] {
  return entries
    .filter((entry) => entry.request && entry.response)
    .map((entry) => ({
      url: normalizeBrowseUrl(entry.request.url, baseUrl),
      method: entry.request.method,
      request_headers: Object.fromEntries((entry.request.headers ?? []).map((header) => [header.name.toLowerCase(), header.value])),
      request_body: entry.request.postData?.text,
      response_status: entry.response.status,
      response_headers: Object.fromEntries((entry.response.headers ?? []).map((header) => [header.name.toLowerCase(), header.value])),
      response_body: entry.response.content?.text,
      timestamp: entry.startedDateTime ?? new Date().toISOString(),
    }));
}

export function buildBrowseRequestKey(request: RawRequest): string {
  return [
    request.method,
    request.url,
    typeof request.request_body === "string" ? request.request_body : JSON.stringify(request.request_body ?? null),
  ].join(":");
}

export function mergeBrowseRequests(intercepted: RawRequest[], harEntries: KuriHarEntry[], baseUrl?: string): RawRequest[] {
  const normalizedIntercepted = intercepted.map((request) => ({
    ...request,
    url: normalizeBrowseUrl(request.url, baseUrl),
  }));
  const harRequests = harEntriesToRawRequests(harEntries, baseUrl);
  const seen = new Set<string>();
  const allRequests: RawRequest[] = [];

  for (const request of normalizedIntercepted) {
    const key = buildBrowseRequestKey(request);
    if (!seen.has(key)) {
      seen.add(key);
      allRequests.push(request);
    }
  }

  for (const request of harRequests) {
    const key = buildBrowseRequestKey(request);
    if (!seen.has(key)) {
      seen.add(key);
      allRequests.push(request);
    }
  }

  return allRequests;
}

export interface BrowseIndexResult {
  domain: string;
  indexed: boolean;
  mode: "http" | "dom" | "none";
  skill: SkillManifest | null;
}

export function shouldIndexDomBrowseFallback(params: {
  requestCount: number;
  intent: string;
  extractedData: unknown;
  extractedConfidence: number;
  hasStructuredForm: boolean;
}): {
  allow: boolean;
  reason?: string;
  intentLooksSearch: boolean;
} {
  const { requestCount, intent, extractedData, extractedConfidence, hasStructuredForm } = params;
  const intentLooksSearch = /\b(search|find|lookup|filter)\b/i.test(intent);

  if (!extractedData) {
    if (hasStructuredForm && requestCount > 0 && intentLooksSearch) {
      return { allow: true, intentLooksSearch };
    }
    return {
      allow: false,
      reason: hasStructuredForm ? "form_only_without_network_evidence" : "no_dom_data",
      intentLooksSearch,
    };
  }

  const quality = validateExtractionQuality(extractedData, extractedConfidence, intent);
  if (!quality.valid) {
    if (hasStructuredForm && requestCount > 0 && intentLooksSearch) {
      return { allow: true, intentLooksSearch };
    }
    return {
      allow: false,
      reason: quality.quality_note ?? "low_quality_dom_extraction",
      intentLooksSearch,
    };
  }

  const semanticAssessment = assessIntentResult(extractedData, intent);
  if (semanticAssessment.verdict === "fail") {
    if (hasStructuredForm && requestCount > 0 && intentLooksSearch) {
      return { allow: true, intentLooksSearch };
    }
    return {
      allow: false,
      reason: semanticAssessment.reason ?? "dom_extraction_did_not_match_intent",
      intentLooksSearch,
    };
  }

  return { allow: true, intentLooksSearch };
}

export async function cacheBrowseRequests(params: {
  sessionUrl: string;
  sessionDomain: string;
  requests: RawRequest[];
  getPageHtml?: () => Promise<string>;
  jsBundles?: Map<string, string>;
  intent?: string;
}): Promise<BrowseIndexResult> {
  const { sessionUrl, sessionDomain, requests, getPageHtml, jsBundles } = params;
  let domain: string;
  try { domain = new URL(sessionUrl).hostname; } catch { domain = sessionDomain; }
  const intent = params.intent ?? `browse ${domain}`;

  const rawEndpoints = extractEndpoints(requests, undefined, { pageUrl: sessionUrl, finalUrl: sessionUrl });

  // Extract and persist auth headers (authorization, csrf, bearer tokens)
  // so serverFetch can replay them. Use registrable domain for vault key
  // so ads.x.com and ads-api.x.com share the same session.
  const capturedAuthHeaders = extractAuthHeaders(requests);
  if (Object.keys(capturedAuthHeaders).length > 0) {
    const sessionKey = `${getRegistrableDomain(domain)}-session`;
    await storeCredential(sessionKey, JSON.stringify({ headers: capturedAuthHeaders })).catch(() => {});
  }

  if (rawEndpoints.length > 0) {
    const existingSkill = findExistingSkillForDomain(domain);
    let allExisting = existingSkill?.endpoints ?? [];

    const domainKey = getDomainReuseKey(sessionUrl ?? domain);
    if (domainKey) {
      const cached = domainSkillCache.get(domainKey);
      if (cached?.localSkillPath) {
        try {
          const snapshot = JSON.parse(readFileSync(cached.localSkillPath, "utf-8"));
          if (snapshot?.endpoints?.length > 0) {
            allExisting = mergeEndpoints(allExisting, snapshot.endpoints);
          }
        } catch {
          // ignore stale snapshot
        }
      }
    }

    const mergedEndpoints = allExisting.length > 0 ? mergeEndpoints(allExisting, rawEndpoints) : rawEndpoints;
    if (!existingSkill || mergedEndpoints.length >= existingSkill.endpoints.length) {
      for (const endpoint of mergedEndpoints) {
        if (!endpoint.description) endpoint.description = generateLocalDescription(endpoint);
        if (!endpoint.semantic) endpoint.semantic = inferEndpointSemantic(endpoint);
      }
      const quickSkill: SkillManifest = {
        skill_id: existingSkill?.skill_id ?? nanoid(),
        version: "1.0.0",
        schema_version: "1",
        lifecycle: "active",
        execution_type: "http",
        created_at: existingSkill?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        name: domain,
        intent_signature: intent,
        domain,
        description: `API skill for ${domain}`,
        owner_type: "agent",
        endpoints: mergedEndpoints,
        operation_graph: buildSkillOperationGraph(mergedEndpoints),
        intents: Array.from(new Set([...(existingSkill?.intents ?? []), intent])),
      };

      // Token source discovery: scan live HTML for tokens used in captured
      // request headers and attach AuthTokenBinding entries so serverFetch
      // can rescrape fresh tokens on replay.
      try {
        const html = getPageHtml ? await getPageHtml() : undefined;
        if (html && html.startsWith("<")) {
          const preCheck = requests.filter(r => r.request_headers["authorization"] || r.request_headers["x-csrf-token"]).length;
          const enriched = enrichEndpointsWithTokenSources(quickSkill.endpoints, requests, html, jsBundles);
          log("browse-index", `token enrichment: ${enriched} bindings, ${preCheck} auth-reqs pre-call, ${quickSkill.endpoints.length} eps`);
        }
      } catch (e) { log("browse-index", `token enrichment failed: ${e}`); }

      const cacheKey = buildResolveCacheKey(domain, intent, sessionUrl);
      const scopedKey = scopedCacheKey("global", cacheKey);
      writeSkillSnapshot(scopedKey, quickSkill);
      if (domainKey) {
        domainSkillCache.set(domainKey, {
          skillId: quickSkill.skill_id,
          localSkillPath: snapshotPathForCacheKey(scopedKey),
          ts: Date.now(),
        });
        persistDomainCache();
      }
      try { cachePublishedSkill(quickSkill); } catch {}
      upsertDagEdgesFromOperationGraph(quickSkill);
      invalidateRouteCacheForDomain(domain);
      return { domain, indexed: true, mode: "http", skill: quickSkill };
    }

    return { domain, indexed: false, mode: "http", skill: existingSkill ?? null };
  }

  if (!getPageHtml) return { domain, indexed: false, mode: "none", skill: null };

  try {
    const html = await getPageHtml();
    if (!html || !html.startsWith("<")) return { domain, indexed: false, mode: "none", skill: null };

    const { extractFromDOM } = await import("../extraction/index.js");
    const { detectSearchForms, isStructuredSearchForm } = await import("../execution/search-forms.js");
    const { inferSchema } = await import("../transform/index.js");
    const { templatizeQueryParams } = await import("../execution/index.js");

    const extracted = extractFromDOM(html, intent);
    const searchForms = detectSearchForms(html);
    const validForm = searchForms.find((form: { form_selector: string; fields: unknown[] }) => isStructuredSearchForm(form));
    const domDecision = shouldIndexDomBrowseFallback({
      requestCount: requests.length,
      intent,
      extractedData: extracted.data,
      extractedConfidence: extracted.confidence,
      hasStructuredForm: !!validForm,
    });

    if (!domDecision.allow || !extracted.data) return { domain, indexed: false, mode: "none", skill: null };

    const urlTemplate = templatizeQueryParams(sessionUrl);
    const endpoint: EndpointDescriptor = {
      endpoint_id: nanoid(),
      method: "GET",
      url_template: urlTemplate,
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: extracted.confidence ?? 0.7,
      description: validForm && domDecision.intentLooksSearch ? `Search form for ${domain}` : `Page content from ${domain}`,
      response_schema: inferSchema([extracted.data]),
      dom_extraction: {
        extraction_method: extracted.extraction_method ?? "repeated-elements",
        confidence: extracted.confidence ?? 0.7,
        ...(extracted.selector ? { selector: extracted.selector } : {}),
      },
      trigger_url: sessionUrl,
      ...(validForm && domDecision.intentLooksSearch ? { search_form: validForm } : {}),
    };

    endpoint.semantic = inferEndpointSemantic(endpoint, {
      sampleResponse: extracted.data,
      observedAt: new Date().toISOString(),
      sampleRequestUrl: sessionUrl,
    });

    const existing = findExistingSkillForDomain(domain);
    const allEndpoints = existing ? mergeEndpoints(existing.endpoints, [endpoint]) : [endpoint];
    for (const candidate of allEndpoints) {
      if (!candidate.description) candidate.description = generateLocalDescription(candidate);
    }

    const skill: SkillManifest = {
      skill_id: existing?.skill_id ?? nanoid(),
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: existing?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      name: domain,
      intent_signature: intent,
      domain,
      description: `DOM skill for ${domain}`,
      owner_type: "agent",
      endpoints: allEndpoints,
      operation_graph: buildSkillOperationGraph(allEndpoints),
      intents: [...new Set([...(existing?.intents ?? []), intent])],
    };
    const cacheKey = buildResolveCacheKey(domain, intent, sessionUrl);
    const scopedKey = scopedCacheKey("global", cacheKey);
    writeSkillSnapshot(scopedKey, skill);
    const domainReuseKey = getDomainReuseKey(sessionUrl ?? domain);
    if (domainReuseKey) {
      domainSkillCache.set(domainReuseKey, {
        skillId: skill.skill_id,
        localSkillPath: snapshotPathForCacheKey(scopedKey),
        ts: Date.now(),
      });
      persistDomainCache();
    }
    try { cachePublishedSkill(skill); } catch {}
    upsertDagEdgesFromOperationGraph(skill);
    invalidateRouteCacheForDomain(domain);
    return { domain, indexed: true, mode: "dom", skill };
  } catch {
    return { domain, indexed: false, mode: "none", skill: null };
  }
}
