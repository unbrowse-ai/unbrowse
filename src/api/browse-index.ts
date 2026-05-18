import { nanoid } from "nanoid";
import { createHash } from "node:crypto";

function stableEndpointId(method: string, urlTemplate: string): string {
  if (!method || !urlTemplate) return nanoid();
  return createHash("sha256").update(`${method}:${urlTemplate}`).digest("base64url").slice(0, 21);
}
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
import { augmentEndpointsWithAgent } from "../graph/agent-augment.js";
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

export interface CaptureDiagnostic {
  // Raw counts and gate signals collected at each pipeline stage. Per
  // CLAUDE.md's "substrate enables; does not prescribe" rule these are
  // declared values from the existing stages (extractEndpoints,
  // getPageHtml, tryHttpFetch, shouldIndexDomBrowseFallback) — never
  // synthesized verdicts. The agent reads these against intent to judge
  // which gate fired when `indexed: false` is returned on the 17 probes
  // surfaced by 2026-05-18 MCP gate run `20260518T092341Z`.
  requests_count: number;        // input to extractEndpoints (after enrichPassiveCaptureRequests)
  raw_endpoints_count: number;   // output of extractEndpoints
  http_path_grew_skill: boolean | null;  // null if http branch not taken
  dom_fallback_attempted: boolean;       // raw_endpoints===0 branch entered
  dom_html_size: number;                 // bytes from getPageHtml (live tab eval)
  dom_used_server_fetch: boolean;        // tryHttpFetch ran as html fallback
  dom_extraction_confidence: number | null; // null if extractFromDOM not called
  dom_decision_reason: string | null;       // verbatim shouldIndexDomBrowseFallback.reason or "no_html"/"exception"
}

export interface BrowseIndexResult {
  domain: string;
  indexed: boolean;
  mode: "http" | "dom" | "none";
  skill: SkillManifest | null;
  capture_diagnostic: CaptureDiagnostic;
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

  // Heuristic admission gates REMOVED 2026-05-18 per substrate-enables
  // principle (CLAUDE.md): never bake a verdict into a script. The pre-fix
  // shape called validateExtractionQuality (confidence < 0.5 / dupe-ratio
  // > 0.5 / concat patterns / nav-chrome / primitive-rows) AND
  // assessIntentResult (semantic heuristic) as admission gates. Both
  // were "synthesize a verdict in code" — exactly what the rule forbids.
  //
  // Quality signals stay computed on the published skill as EVIDENCE
  // fields (dom_extraction.confidence, etc.); the ranker reads them and
  // the agent makes the call. Bad skills demote via reliability_score
  // updates driven by unbrowse_reflect (Darwinian marketplace).
  //
  // The only remaining reject is "truly empty data" (handled above at
  // the !extractedData branch). Anything with data is admitted; downstream
  // resolve + agent-judge + reliability-feedback handle quality.
  return { allow: true, intentLooksSearch };
}

export async function cacheBrowseRequests(params: {
  sessionUrl: string;
  sessionDomain: string;
  requests: RawRequest[];
  getPageHtml?: () => Promise<string>;
  jsBundles?: Map<string, string>;
  intent?: string;
  /**
   * Optional synthetic RawRequests that are NOT real captured network traffic
   * (e.g. CDP Network.requestWillBeSent header snapshots). They participate
   * ONLY in auth-header extraction — not endpoint extraction — so we capture
   * Authorization / x-csrf-* / etc. without inventing fake endpoints.
   */
  extraAuthHeaderRequests?: RawRequest[];
  /**
   * Optional getter for the live tab's cookies. The DOM-fallback path uses
   * tryHttpFetch as a backstop when getPageHtml returns malformed HTML
   * (CLAUDE.md: Kuri's CDP eval can serialize document.documentElement
   * to "[object Object]" when the response shape changes). Without cookies,
   * tryHttpFetch on a Cloudflare-gated site (npm, dockerhub, etc.) hits the
   * "Just a moment..." challenge and returns ~5KB of garbage, so the DOM
   * fallback rejects the extraction at 0.4 confidence. Passing the live
   * tab's CF clearance cookies through lets the server-fetch get the same
   * unlocked HTML the live tab is rendering. Surfaced by the 2026-05-17
   * MCP bench-gate's #002 npm + #010 dockerhub probes (BUG-1).
   */
  getCookies?: () => Promise<Array<{ name: string; value: string; domain: string }>>;
}): Promise<BrowseIndexResult> {
  const { sessionUrl, sessionDomain, requests, getPageHtml, jsBundles, extraAuthHeaderRequests, getCookies } = params;
  let domain: string;
  try { domain = new URL(sessionUrl).hostname; } catch { domain = sessionDomain; }
  const intent = params.intent ?? `browse ${domain}`;

  const rawEndpoints = extractEndpoints(requests, undefined, { pageUrl: sessionUrl, finalUrl: sessionUrl });

  // Mutable diagnostic accumulator. Populated as the pipeline runs; spread
  // into every return so close-body always carries the per-stage signals.
  const diagnostic: CaptureDiagnostic = {
    requests_count: requests.length,
    raw_endpoints_count: rawEndpoints.length,
    http_path_grew_skill: null,
    dom_fallback_attempted: false,
    dom_html_size: 0,
    dom_used_server_fetch: false,
    dom_extraction_confidence: null,
    dom_decision_reason: null,
  };

  // Extract and persist auth headers (authorization, csrf, bearer tokens)
  // so serverFetch can replay them. Use registrable domain for vault key
  // so ads.x.com and ads-api.x.com share the same session. CDP-only synthetic
  // requests participate here so headers from XHRs HAR/interceptor missed are
  // still captured for replay.
  const requestsForAuth = extraAuthHeaderRequests && extraAuthHeaderRequests.length > 0
    ? [...requests, ...extraAuthHeaderRequests]
    : requests;
  const capturedAuthHeaders = extractAuthHeaders(requestsForAuth);
  // Filter out [REDACTED] placeholders from cookie-inferred auth headers
  for (const [k, v] of Object.entries(capturedAuthHeaders)) {
    if (v === "[REDACTED]") delete capturedAuthHeaders[k];
  }
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
      // LLM-augment descriptions with the configured agent provider
      // (NEBIUS_API_KEY / OPENAI_API_KEY). Substrate-correct quality
      // signal: each endpoints lookup string ("description" + schema
      // keys) goes from heuristic URL-fragment stubs ("Returns
      // resource details") to a concrete LLM-written one-liner
      // grounded in the actual captured URL + sample response. Drives
      // BM25 ranking quality. Silently no-ops if neither key is set;
      // augment-side errors fall back to the heuristic. Discovered
      // 2026-05-18 — the function existed (src/graph/agent-augment.ts)
      // but had zero callers across src/.
      const augmentedEndpoints = await augmentEndpointsWithAgent(mergedEndpoints, { intent, domain });
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
        endpoints: augmentedEndpoints,
        operation_graph: buildSkillOperationGraph(augmentedEndpoints),
        intents: Array.from(new Set([...(existingSkill?.intents ?? []), intent])),
      };

      // Token source discovery: scan live HTML for tokens used in captured
      // request headers and attach AuthTokenBinding entries so serverFetch
      // can rescrape fresh tokens on replay.
      try {
        const html = getPageHtml ? await getPageHtml() : undefined;
        if (html && html.trimStart().startsWith("<")) {
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
      diagnostic.http_path_grew_skill = true;
      return { domain, indexed: true, mode: "http", skill: quickSkill, capture_diagnostic: diagnostic };
    }

    diagnostic.http_path_grew_skill = false;
    return { domain, indexed: false, mode: "http", skill: existingSkill ?? null, capture_diagnostic: diagnostic };
  }

  try {
    diagnostic.dom_fallback_attempted = true;
    const { extractFromDOM } = await import("../extraction/index.js");
    const { detectSearchForms, isStructuredSearchForm } = await import("../execution/search-forms.js");
    const { inferSchema } = await import("../transform/index.js");
    const { templatizeQueryParams, tryHttpFetch } = await import("../execution/index.js");

    let html: string | undefined;
    let livePageHtmlSize = 0;
    try {
      html = getPageHtml ? await getPageHtml() : undefined;
      livePageHtmlSize = html ? html.length : 0;
      diagnostic.dom_html_size = livePageHtmlSize;
    } catch { html = undefined; }
    // getPageHtml is the live Kuri CDP tab HTML; CLAUDE.md documents it may
    // return "[object Object]" / empty when the CDP response shape changes.
    // Reaching here with rawEndpoints.length===0 means the page made no
    // captured XHRs, i.e. it is pure SSR, so its content is fully available
    // from a plain server GET of the session URL. Fall back to that (the same
    // tryHttpFetch the SSR execute fast-path uses) instead of declaring
    // nothing to index and leaving the agent to loop on go -> close ->
    // resolve forever with zero learning.
    //
    // For Cloudflare-gated sites (npm, dockerhub, etc.) tryHttpFetch on a
    // raw URL hits the "Just a moment..." challenge and returns ~5KB of
    // garbage; if we have the live tab's cookies, pass them through so the
    // server-fetch carries the CF clearance the live tab earned. Surfaced
    // by the 2026-05-17 MCP bench-gate's #002 npm + #010 dockerhub probes.
    let sessionCookies: Array<{ name: string; value: string; domain: string }> = [];
    if (getCookies) {
      try { sessionCookies = await getCookies(); } catch { /* best-effort */ }
    }
    let usedServerFetch = false;
    if (!html || !html.trimStart().startsWith("<")) {
      log("browse-index", `getPageHtml malformed (size=${livePageHtmlSize}); falling back to tryHttpFetch with ${sessionCookies.length} session cookies`);
      const fetched = await tryHttpFetch(sessionUrl, {}, sessionCookies);
      html = fetched?.html;
      usedServerFetch = true;
      diagnostic.dom_used_server_fetch = true;
      if (html) diagnostic.dom_html_size = html.length;
    }
    if (!html || !html.trimStart().startsWith("<")) {
      diagnostic.dom_decision_reason = "no_html";
      return { domain, indexed: false, mode: "none", skill: null, capture_diagnostic: diagnostic };
    }

    const evaluate = (h: string) => {
      const ex = extractFromDOM(h, intent);
      const forms = detectSearchForms(h);
      const vf = forms.find((form: { form_selector: string; fields: unknown[] }) => isStructuredSearchForm(form));
      const dd = shouldIndexDomBrowseFallback({
        requestCount: requests.length,
        intent,
        extractedData: ex.data,
        extractedConfidence: ex.confidence,
        hasStructuredForm: !!vf,
      });
      return { extracted: ex, validForm: vf, domDecision: dd, ok: dd.allow && !!ex.data };
    };

    let evald = evaluate(html);
    // The live tab HTML (getPageHtml) can extract BELOW the index-quality gate
    // on a page whose plain server-rendered HTML extracts ABOVE it (observed
    // on openlibrary.org/search: rendered DOM conf 0.42 < 0.5, plain server
    // GET conf 0.63). loop-7's principle is "exhaust the SSR server-fetch
    // before declaring nothing to index"; previously the server-fetch only
    // ran when getPageHtml was structurally junk, not when its extraction
    // failed the gate. If the gate fails and we have not yet tried the
    // server-fetch, try it (with session cookies, so CF-gated sites
    // produce the unlocked HTML, not the challenge page) and keep
    // whichever HTML actually passes. This can only turn a mode:none into
    // an index, never the reverse.
    if (!evald.ok && !usedServerFetch) {
      log("browse-index", `live-html extraction failed gate (conf=${evald.extracted.confidence}); falling back to tryHttpFetch with ${sessionCookies.length} session cookies`);
      const fetched = await tryHttpFetch(sessionUrl, {}, sessionCookies);
      if (fetched?.html && fetched.html.trimStart().startsWith("<")) {
        const alt = evaluate(fetched.html);
        if (alt.ok) {
          html = fetched.html;
          evald = alt;
          diagnostic.dom_used_server_fetch = true;
          diagnostic.dom_html_size = fetched.html.length;
        }
      }
    }

    const { extracted, validForm, domDecision } = evald;
    diagnostic.dom_extraction_confidence = typeof extracted.confidence === "number" ? extracted.confidence : null;
    if (!domDecision.allow || !extracted.data) {
      diagnostic.dom_decision_reason = domDecision.reason ?? (!extracted.data ? "no_extracted_data" : "dom_fallback_rejected");
      return { domain, indexed: false, mode: "none", skill: null, capture_diagnostic: diagnostic };
    }

    const urlTemplate = templatizeQueryParams(sessionUrl);
    const endpoint: EndpointDescriptor = {
      endpoint_id: stableEndpointId("GET", urlTemplate),
      method: "GET",
      url_template: urlTemplate,
      idempotency: "safe",
      verification_status: "verified",
      // Neutral prior. Pre-2026-05-18 this was initialized from the
      // extraction confidence heuristic — coupling admission quality to
      // post-publish ranking, baking a verdict into the score before any
      // usage data existed. Substrate-correct shape: start at 0.5 and let
      // unbrowse_reflect / verification feedback teach the score via
      // updateEndpointScore. New skills earn their rank from real use.
      reliability_score: 0.5,
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
    // LLM-augment descriptions on the DOM-mode path too. Same rationale
    // as the HTTP-path site above. The DOM endpoint is the page-artifact
    // synthetic; agent description tells the ranker what content it
    // actually surfaces.
    const augmentedAllEndpoints = await augmentEndpointsWithAgent(allEndpoints, { intent, domain });

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
      endpoints: augmentedAllEndpoints,
      operation_graph: buildSkillOperationGraph(augmentedAllEndpoints),
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
    return { domain, indexed: true, mode: "dom", skill, capture_diagnostic: diagnostic };
  } catch {
    diagnostic.dom_decision_reason = diagnostic.dom_decision_reason ?? "exception_in_dom_fallback";
    return { domain, indexed: false, mode: "none", skill: null, capture_diagnostic: diagnostic };
  }
}
