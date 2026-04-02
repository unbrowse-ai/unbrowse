import { nanoid } from "nanoid";
import { readFileSync } from "node:fs";
import { extractEndpoints } from "../reverse-engineer/index.js";
import { buildSkillOperationGraph, inferEndpointSemantic } from "../graph/index.js";
import type { KuriHarEntry } from "../kuri/client.js";
import type { EndpointDescriptor, SkillManifest } from "../types/index.js";
import type { RawRequest } from "../capture/index.js";
import { cachePublishedSkill, findExistingSkillForDomain } from "../client/index.js";
import { mergeEndpoints } from "../marketplace/index.js";
import { upsertDagEdgesFromOperationGraph } from "../orchestrator/dag-feedback.js";
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

export async function cacheBrowseRequests(params: {
  sessionUrl: string;
  sessionDomain: string;
  requests: RawRequest[];
  getPageHtml?: () => Promise<string>;
}): Promise<BrowseIndexResult> {
  const { sessionUrl, sessionDomain, requests, getPageHtml } = params;
  let domain: string;
  try { domain = new URL(sessionUrl).hostname; } catch { domain = sessionDomain; }

  const rawEndpoints = extractEndpoints(requests, undefined, { pageUrl: sessionUrl, finalUrl: sessionUrl });
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
        intent_signature: `browse ${domain}`,
        domain,
        description: `API skill for ${domain}`,
        owner_type: "agent",
        endpoints: mergedEndpoints,
        operation_graph: buildSkillOperationGraph(mergedEndpoints),
        intents: Array.from(new Set([...(existingSkill?.intents ?? []), `browse ${domain}`])),
      };

      const cacheKey = buildResolveCacheKey(domain, `browse ${domain}`, sessionUrl);
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

    const extracted = extractFromDOM(html, `browse ${domain}`);
    const searchForms = detectSearchForms(html);
    const validForm = searchForms.find((form: { form_selector: string; fields: unknown[] }) => isStructuredSearchForm(form));

    if (!extracted.data && !validForm) return { domain, indexed: false, mode: "none", skill: null };

    const urlTemplate = templatizeQueryParams(sessionUrl);
    const endpoint: EndpointDescriptor = {
      endpoint_id: nanoid(),
      method: "GET",
      url_template: urlTemplate,
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: extracted.confidence ?? 0.7,
      description: validForm ? `Search form for ${domain}` : `Page content from ${domain}`,
      response_schema: extracted.data ? inferSchema([extracted.data]) : undefined,
      dom_extraction: {
        extraction_method: extracted.extraction_method ?? "repeated-elements",
        confidence: extracted.confidence ?? 0.7,
        ...(extracted.selector ? { selector: extracted.selector } : {}),
      },
      trigger_url: sessionUrl,
      ...(validForm ? { search_form: validForm } : {}),
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
      intent_signature: `browse ${domain}`,
      domain,
      description: `DOM skill for ${domain}`,
      owner_type: "agent",
      endpoints: allEndpoints,
      operation_graph: buildSkillOperationGraph(allEndpoints),
      intents: [...new Set([...(existing?.intents ?? []), `browse ${domain}`])],
    };

    const cacheKey = buildResolveCacheKey(domain, `browse ${domain}`, sessionUrl);
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
